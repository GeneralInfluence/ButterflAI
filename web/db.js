'use strict';

/**
 * ButterflAI database module — split DB architecture
 *
 * main.sqlite        — identity, contacts, coordination metadata (no routing problems)
 * users/{id}.sqlite  — conversation history, desires, private data, preferences
 *                       (physical isolation: a bug cannot cross user boundaries)
 *
 * Public API
 * ----------
 * All SQL lives here. No raw queries outside db.js.
 * Methods that touch per-user tables require a userId argument.
 * _raw()         → main DB (backward compat for cadence, coord-loop one-off queries)
 * _userDb(userId) → per-user DB (create/open/cache on demand)
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const { toE164 } = require('./phoneUtils');

// ── DB paths ──────────────────────────────────────────────────────────────────

const DATA_DIR   = process.env.DATA_DIR  || path.join(__dirname, '..', 'data');
const MAIN_PATH  = process.env.DB_PATH   || path.join(DATA_DIR, 'main.sqlite');
const USERS_DIR  = process.env.USERS_DIR || path.join(DATA_DIR, 'users');

fs.mkdirSync(path.dirname(MAIN_PATH), { recursive: true });
fs.mkdirSync(USERS_DIR, { recursive: true });

// ── Schema files ──────────────────────────────────────────────────────────────

// Schema files: in Docker the app root is /app and db/ is at /app/db/.
// __dirname is /app (web/ is the WORKDIR). Try sibling db/ first, then parent.
function _readSchema(filename) {
  for (const p of [
    path.join(__dirname, 'db', filename),          // Docker: /app/db/
    path.join(__dirname, '..', 'db', filename),    // local dev: web/../db/
  ]) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error(`Schema file not found: ${filename}`);
}

const MAIN_SCHEMA = _readSchema('main-schema.sql');
const USER_SCHEMA = _readSchema('user-schema.sql');

// ── Open and initialise main DB ───────────────────────────────────────────────

const main = new Database(MAIN_PATH);
main.pragma('journal_mode = WAL');
main.pragma('foreign_keys = ON');
main.exec(MAIN_SCHEMA);

// Migration tracking (main DB only; user DBs are always created fresh from user-schema.sql)
main.exec(`CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
)`);

const migrationsDir = path.join(__dirname, 'db', 'migrations');
if (fs.existsSync(migrationsDir)) {
  // Only run migrations that belong to main (001, 002) — coordination migrations
  // (003+) now live in user-schema.sql. We do not run them against main.
  const MAIN_ONLY_MIGRATIONS = ['001_', '002_'];
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql') && MAIN_ONLY_MIGRATIONS.some(p => f.startsWith(p)))
    .sort();
  for (const file of files) {
    const already = main.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (already) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
    let ok = true;
    for (const stmt of stmts) {
      try { main.exec(stmt + ';'); } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('duplicate column')) {
          console.error(`[migration] ${file}: ${err.message}`);
          ok = false;
        }
      }
    }
    if (ok) {
      main.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      console.log(`[migration] applied ${file}`);
    }
  }
}

// Ensure schema columns added post-initial-schema exist (idempotent ALTERs)
for (const stmt of [
  `ALTER TABLE users ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN agent_notes TEXT`,
  `ALTER TABLE users ADD COLUMN agent_endpoint TEXT`,
  `ALTER TABLE contacts ADD COLUMN imported_from TEXT`,
  `ALTER TABLE contacts ADD COLUMN import_source TEXT`,
]) {
  try { main.exec(stmt); } catch (_) { /* column already exists */ }
}

// ── Per-user DB cache ─────────────────────────────────────────────────────────

const _userCache = new Map(); // userId → Database instance

function _userDb(userId) {
  if (!userId) throw new Error('db._userDb: userId is required');
  if (_userCache.has(userId)) return _userCache.get(userId);

  const userPath = path.join(USERS_DIR, `${userId}.sqlite`);
  const udb = new Database(userPath);
  udb.pragma('journal_mode = WAL');
  udb.pragma('foreign_keys = ON');
  udb.exec(USER_SCHEMA);

  _userCache.set(userId, udb);
  return udb;
}

// ── Module exports ────────────────────────────────────────────────────────────

module.exports = {

  /** Escape hatch for the main DB (coordination, cadence one-off queries) */
  _raw()             { return main; },
  /** Per-user DB — creates file if new user */
  _userDb(userId)    { return _userDb(userId); },

  // ── Users (main) ──────────────────────────────────────────────────────────

  getUser(id) {
    return main.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  getUserByPhone(phone) {
    return main.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  },

  getUserByTelegramId(telegramId) {
    return main.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
  },

  createUser({ id, phone, name, onboarding_state, telegram_id, telegram_username, clawbank_pubkey }) {
    main.prepare(`
      INSERT INTO users (id, phone, name, onboarding_state, telegram_id, telegram_username, clawbank_pubkey)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, phone || null, name || 'unknown',
      onboarding_state || 'new',
      telegram_id || null, telegram_username || null, clawbank_pubkey || null,
    );
    // Initialise per-user DB immediately so the file exists
    _userDb(id);
  },

  updateUser(id, fields) {
    const allowed = ['name', 'phone', 'onboarding_state', 'onboarding_data',
                     'telegram_id', 'telegram_chat_id', 'agent_endpoint',
                     'onboarded', 'agent_notes'];
    const sets = Object.keys(fields)
      .filter(k => allowed.includes(k))
      .map(k => `${k} = ?`);
    if (!sets.length) return;
    main.prepare(
      `UPDATE users SET ${sets.join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`
    ).run(...sets.map(s => fields[s.split(' ')[0]]), id);
  },

  setUserTelegramChatId(userId, telegramId, chatId) {
    main.prepare(`
      UPDATE users SET telegram_id = ?, telegram_chat_id = ?, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(String(telegramId), String(chatId), userId);
  },

  // ── Contacts (main) ───────────────────────────────────────────────────────

  getContact(id) {
    return main.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  },

  getContactByPhone(phone) {
    return main.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
  },

  getContactByTelegramId(telegramId) {
    return main.prepare('SELECT * FROM contacts WHERE telegram_id = ?').get(String(telegramId));
  },

  getContactByAgentEndpoint(agentEndpoint, ownerUserId) {
    return main.prepare(`
      SELECT c.*
      FROM contacts c
      JOIN users u ON u.phone = c.phone
      WHERE u.agent_endpoint = ?
        AND c.invited_by_user_id = ?
      LIMIT 1
    `).get(agentEndpoint, ownerUserId);
  },

  getContactsByUser(userId) {
    return main.prepare(
      'SELECT * FROM contacts WHERE invited_by_user_id = ? ORDER BY name'
    ).all(userId);
  },

  upsertContact({ invited_by_user_id, name, phone, notes, tier = 0 }) {
    const { v4: uuidv4 } = require('uuid');
    const e164 = phone ? toE164(phone) : null;
    const existing = e164
      ? main.prepare('SELECT * FROM contacts WHERE invited_by_user_id = ? AND phone = ?')
             .get(invited_by_user_id, e164)
      : null;
    if (existing) {
      main.prepare(`
        UPDATE contacts SET name = ?, tier = ?, updated_at = strftime('%s','now') WHERE id = ?
      `).run(name, tier, existing.id);
      return existing.id;
    }
    const id = uuidv4();
    main.prepare(`
      INSERT INTO contacts (id, invited_by_user_id, name, phone, tier)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, invited_by_user_id, name, e164, tier);
    return id;
  },

  createContact({ id, invited_by_user_id, name, phone, telegram_id, telegram_username, tier, opted_out_at }) {
    main.prepare(`
      INSERT INTO contacts (id, invited_by_user_id, name, phone, telegram_id, telegram_username, tier, opted_out_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, invited_by_user_id, name, phone || null,
           telegram_id || null, telegram_username || null,
           tier ?? 0, opted_out_at || null);
    return id;
  },

  updateContact(id, fields) {
    const allowed = ['name', 'phone', 'tier', 'telegram_id', 'telegram_username', 'telegram_chat_id', 'opted_out_at'];
    const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
    if (!sets.length) return;
    main.prepare(
      `UPDATE contacts SET ${sets.join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`
    ).run(...sets.map(s => fields[s.split(' ')[0]]), id);
  },

  setContactTelegramId(contactId, telegramId, chatId) {
    main.prepare(`
      UPDATE contacts SET telegram_id = ?, telegram_chat_id = ?, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(String(telegramId), String(chatId), contactId);
  },

  optOutContact(id) {
    main.prepare(`
      UPDATE contacts SET tier = 0, opted_out_at = strftime('%s','now'),
        updated_at = strftime('%s','now') WHERE id = ?
    `).run(id);
  },

  // ── Contact preferences (main) ────────────────────────────────────────────

  setContactPreferences({ contact_id, availability_notes, neighborhoods, dietary, comm_preference }) {
    const existing = main.prepare('SELECT 1 FROM contact_preferences WHERE contact_id = ?').get(contact_id);
    if (existing) {
      main.prepare(`
        UPDATE contact_preferences
        SET availability_notes = ?, neighborhoods = ?, dietary = ?,
            comm_preference = ?, updated_at = strftime('%s','now')
        WHERE contact_id = ?
      `).run(availability_notes || null,
             Array.isArray(neighborhoods) ? JSON.stringify(neighborhoods) : neighborhoods,
             Array.isArray(dietary)       ? JSON.stringify(dietary)       : dietary,
             comm_preference || 'sms', contact_id);
    } else {
      main.prepare(`
        INSERT INTO contact_preferences (contact_id, availability_notes, neighborhoods, dietary, comm_preference)
        VALUES (?, ?, ?, ?, ?)
      `).run(contact_id, availability_notes || null,
             Array.isArray(neighborhoods) ? JSON.stringify(neighborhoods) : neighborhoods,
             Array.isArray(dietary)       ? JSON.stringify(dietary)       : dietary,
             comm_preference || 'sms');
    }
  },

  getContactPreferences(contactId) {
    return main.prepare('SELECT * FROM contact_preferences WHERE contact_id = ?').get(contactId);
  },

  // ── Private data (per-user) ───────────────────────────────────────────────

  getPrivateData(userId) {
    return _userDb(userId).prepare('SELECT * FROM private_data WHERE id = ?').get('singleton');
  },

  upsertPrivateData(userId, { ciphertext, iv, tag, wrapped_key }) {
    const udb = _userDb(userId);
    const existing = udb.prepare('SELECT 1 FROM private_data WHERE id = ?').get('singleton');
    if (existing) {
      udb.prepare(`
        UPDATE private_data SET ciphertext = ?, iv = ?, tag = ?, wrapped_key = ?,
          version = version + 1, updated_at = strftime('%s','now')
        WHERE id = 'singleton'
      `).run(ciphertext, iv, tag, wrapped_key);
    } else {
      udb.prepare(`
        INSERT INTO private_data (id, ciphertext, iv, tag, wrapped_key) VALUES ('singleton', ?, ?, ?, ?)
      `).run(ciphertext, iv, tag, wrapped_key);
    }
  },

  // ── Access audit (per-user) ───────────────────────────────────────────────

  writeAccessAudit({ userId, accessor, purpose, recordClass, outsideNormalPath }) {
    _userDb(userId).prepare(`
      INSERT INTO access_audit (accessor, purpose, record_class, outside_normal_path)
      VALUES (?, ?, ?, ?)
    `).run(accessor, purpose, recordClass, outsideNormalPath ? 1 : 0);
  },

  getAccessAuditForUser(userId, limit = 100) {
    return _userDb(userId).prepare(
      'SELECT * FROM access_audit ORDER BY accessed_at DESC LIMIT ?'
    ).all(limit);
  },

  // ── Invites (main) ────────────────────────────────────────────────────────

  getInvite(token) {
    return main.prepare('SELECT * FROM invites WHERE token = ?').get(token);
  },

  createInvite({ token, created_by_user_id, contact_name, expires_at }) {
    main.prepare(`
      INSERT INTO invites (token, created_by_user_id, contact_name, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(token, created_by_user_id, contact_name || null, expires_at || null);
  },

  resolveInvite(token, status, contactId) {
    main.prepare(`
      UPDATE invites SET status = ?, contact_id = ?,
        resolved_at = strftime('%s','now') WHERE token = ?
    `).run(status, contactId || null, token);
  },

  getPendingInvitesByUser(userId) {
    return main.prepare(`
      SELECT i.*, c.name as contact_name, c.phone as contact_phone
      FROM invites i LEFT JOIN contacts c ON c.id = i.contact_id
      WHERE i.created_by_user_id = ? AND i.status = 'pending'
      ORDER BY i.created_at DESC
    `).all(userId);
  },

  // ── SMS opt-outs (main) ───────────────────────────────────────────────────

  isOptedOut(phone) {
    return !!main.prepare('SELECT 1 FROM sms_optouts WHERE phone = ?').get(toE164(phone));
  },

  recordOptOut(phone, source = 'stop_reply') {
    const e164 = toE164(phone);
    main.prepare(`
      INSERT INTO sms_optouts (phone, source) VALUES (?, ?)
      ON CONFLICT(phone) DO UPDATE SET source = excluded.source,
        opted_out_at = strftime('%s','now')
    `).run(e164, source);
    // Also zero the tier for any matching contacts
    main.prepare(
      `UPDATE contacts SET tier = 0, opted_out_at = strftime('%s','now') WHERE phone = ?`
    ).run(e164);
  },

  removeOptOut(phone) {
    main.prepare('DELETE FROM sms_optouts WHERE phone = ?').run(toE164(phone));
  },

  // ── Onboarding intents (per-user) ─────────────────────────────────────────

  createOnboardingIntent({ id, user_id, contact_name, frequency, activity_type, group_size }) {
    _userDb(user_id).prepare(`
      INSERT INTO onboarding_intents (id, contact_name, frequency, activity_type, group_size)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, contact_name, frequency, activity_type || null, group_size || 'one_on_one');
  },

  getOnboardingIntents(userId) {
    return _userDb(userId).prepare('SELECT * FROM onboarding_intents ORDER BY created_at ASC').all();
  },

  confirmOnboardingIntents(userId) {
    _userDb(userId).prepare('UPDATE onboarding_intents SET confirmed = 1').run();
  },

  // ── Relationships (per-user) ──────────────────────────────────────────────

  createRelationship({ id, user_id, contact_id, contact_is_user, nickname, notes }) {
    _userDb(user_id).prepare(`
      INSERT INTO relationships (id, contact_id, contact_is_user, nickname, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, contact_id, contact_is_user ? 1 : 0, nickname || null, notes || null);
    return id;
  },

  getRelationshipsByUser(userId) {
    return _userDb(userId).prepare('SELECT * FROM relationships ORDER BY created_at ASC').all();
  },

  // ── Cadences (per-user) ───────────────────────────────────────────────────

  createCadence({ id, relationship_id, user_id, activity_type, frequency, group_size,
                  budget_per_person, preferred_areas, preferred_times }) {
    _userDb(user_id).prepare(`
      INSERT INTO cadences (id, relationship_id, activity_type, frequency, group_size,
        budget_per_person, preferred_areas, preferred_times)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, relationship_id, activity_type, frequency,
           group_size || 'one_on_one', budget_per_person || null,
           preferred_areas || null, preferred_times || null);
    return id;
  },

  getCadencesByUser(userId) {
    return _userDb(userId).prepare(`
      SELECT c.*, r.contact_id, r.nickname
      FROM cadences c JOIN relationships r ON r.id = c.relationship_id
      WHERE c.active = 1 ORDER BY c.next_target_at ASC
    `).all();
  },

  updateCadenceLastFulfilled(cadenceId, userId, ts) {
    _userDb(userId).prepare(`
      UPDATE cadences SET last_fulfilled_at = ?, next_target_at = NULL WHERE id = ?
    `).run(ts, cadenceId);
  },

  // ── Activities (per-user) ─────────────────────────────────────────────────

  getActivity(userId, id) {
    return _userDb(userId).prepare('SELECT * FROM activities WHERE id = ?').get(id);
  },

  getActivityOrganiser(userId, activityId) {
    // Returns the user record of whoever owns this activity's cadence
    const act = _userDb(userId).prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
    if (!act) return null;
    return { userId, activity: act };
  },

  updateActivityResponse(userId, activityId, phone, response) {
    const udb  = _userDb(userId);
    const act  = udb.prepare('SELECT responses FROM activities WHERE id = ?').get(activityId);
    if (!act) return;
    const responses = JSON.parse(act.responses || '{}');
    responses[toE164(phone)] = response;
    udb.prepare(`
      UPDATE activities SET responses = ?, updated_at = strftime('%s','now') WHERE id = ?
    `).run(JSON.stringify(responses), activityId);
  },

  setActivityTimeChoice(userId, activityId, phone, slotIndex) {
    const udb    = _userDb(userId);
    const act    = udb.prepare('SELECT time_choices FROM activities WHERE id = ?').get(activityId);
    if (!act) return;
    const choices = JSON.parse(act.time_choices || '{}');
    choices[toE164(phone)] = slotIndex;
    udb.prepare(`
      UPDATE activities SET time_choices = ?, updated_at = strftime('%s','now') WHERE id = ?
    `).run(JSON.stringify(choices), activityId);
  },

  // ── Inbound messages (main) ───────────────────────────────────────────────

  storeInboundMessage({ from_phone, from_telegram_id, from_type, from_id, channel, text }) {
    main.prepare(`
      INSERT INTO inbound_messages
        (id, from_phone, from_telegram_id, from_type, from_id, channel, text)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?)
    `).run(
      from_phone || null,
      from_telegram_id ? String(from_telegram_id) : null,
      from_type, from_id,
      channel || 'sms', text,
    );
  },

  getPendingInboundMessages() {
    return main.prepare(
      'SELECT * FROM inbound_messages WHERE processed = 0 ORDER BY created_at ASC'
    ).all();
  },

  markMessageProcessed(id) {
    main.prepare('UPDATE inbound_messages SET processed = 1 WHERE id = ?').run(id);
  },

  // ── Conversation history (per-user) ───────────────────────────────────────

  appendConversation(userId, role, text) {
    const { v4: uuidv4 } = require('uuid');
    _userDb(userId).prepare(`
      INSERT INTO conversation_history (id, role, text) VALUES (?, ?, ?)
    `).run(uuidv4(), role, text.slice(0, 4000));
  },

  getRecentConversation(userId, limit = 20) {
    const rows = _userDb(userId).prepare(`
      SELECT role, text, created_at FROM conversation_history
      ORDER BY created_at DESC LIMIT ?
    `).all(limit);
    return rows.reverse();
  },

  // ── Pending actions (per-user) ────────────────────────────────────────────

  createPendingAction({ id, user_id, action_type, payload, ttl_secs }) {
    const expires_at = Math.floor(Date.now() / 1000) + (ttl_secs || 86400);
    _userDb(user_id).prepare(`
      INSERT INTO pending_actions (id, action_type, payload, expires_at) VALUES (?, ?, ?, ?)
    `).run(id, action_type, JSON.stringify(payload || {}), expires_at);
  },

  getPendingAction(userId) {
    return _userDb(userId).prepare(`
      SELECT * FROM pending_actions
      WHERE expires_at > strftime('%s','now')
      ORDER BY created_at DESC LIMIT 1
    `).get();
  },

  deletePendingAction(id, userId) {
    _userDb(userId).prepare('DELETE FROM pending_actions WHERE id = ?').run(id);
  },

  clearExpiredPendingActions(userId) {
    _userDb(userId).prepare(
      `DELETE FROM pending_actions WHERE expires_at <= strftime('%s','now')`
    ).run();
  },

  // ── Consent ledger (main) ─────────────────────────────────────────────────

  writeConsent(phone, source, disclosureVersion = '1.0') {
    main.prepare(`
      INSERT INTO consent_records (phone, consent_source, disclosure_version)
      VALUES (?, ?, ?)
    `).run(toE164(phone), source, disclosureVersion);
  },

  getConsent(phone) {
    return main.prepare(`
      SELECT * FROM consent_records WHERE phone = ? ORDER BY consented_at DESC LIMIT 1
    `).get(toE164(phone));
  },

  hasConsent(phone) {
    return !!main.prepare(`SELECT 1 FROM consent_records WHERE phone = ? LIMIT 1`).get(toE164(phone));
  },

  // ── User preferences (per-user) ───────────────────────────────────────────

  getPreferences(userId) {
    const row = _userDb(userId).prepare('SELECT * FROM user_preferences WHERE id = ?').get('singleton');
    if (!row) return null;
    const jsonCols = ['dietary_restrictions','food_allergies','cuisine_loves','cuisine_avoids',
                      'activity_loves','activity_avoids','vibe'];
    for (const col of jsonCols) {
      try { row[col] = JSON.parse(row[col] || '[]'); } catch { row[col] = []; }
    }
    return row;
  },

  upsertPreferences(userId, fields) {
    const jsonCols = ['dietary_restrictions','food_allergies','cuisine_loves','cuisine_avoids',
                      'activity_loves','activity_avoids','vibe'];
    const toWrite = { ...fields };
    for (const col of jsonCols) {
      if (col in toWrite && Array.isArray(toWrite[col])) {
        toWrite[col] = JSON.stringify(toWrite[col]);
      }
    }
    delete toWrite.user_id;  // no user_id column in per-user DB
    const udb      = _userDb(userId);
    const existing = udb.prepare('SELECT id FROM user_preferences WHERE id = ?').get('singleton');
    if (!existing) {
      const cols    = ['id', ...Object.keys(toWrite)].join(', ');
      const holders = ['?', ...Object.keys(toWrite).map(() => '?')].join(', ');
      udb.prepare(`INSERT INTO user_preferences (${cols}) VALUES (${holders})`)
         .run('singleton', ...Object.values(toWrite));
    } else {
      const sets = Object.keys(toWrite).map(k => `${k} = ?`).join(', ');
      udb.prepare(`UPDATE user_preferences SET ${sets}, updated_at = strftime('%s','now') WHERE id = 'singleton'`)
         .run(...Object.values(toWrite));
    }
    return this.getPreferences(userId);
  },

  // ── Agent messages (per-user) ─────────────────────────────────────────────

  sendAgentMessage({ fromUserId, toUserId, threadId, kind, topic, body }) {
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    // Store in recipient's DB so they can poll it without cross-user access
    _userDb(toUserId).prepare(`
      INSERT INTO agent_messages (id, from_user, to_user, thread_id, kind, topic, body)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, fromUserId, toUserId, threadId || id, kind, topic, body.slice(0, 2000));
    return id;
  },

  getPendingAgentMessages(userId) {
    return _userDb(userId).prepare(`
      SELECT * FROM agent_messages WHERE processed = 0 ORDER BY created_at ASC
    `).all();
  },

  markAgentMessageProcessed(userId, id) {
    _userDb(userId).prepare('UPDATE agent_messages SET processed = 1 WHERE id = ?').run(id);
  },

  // ── Desires (per-user) ────────────────────────────────────────────────────

  createDesire({ id, userId, rawText, category, activityType, socialSizeMin, socialSizeMax,
                  windowStart, windowEnd, priority, candidateStrategy, candidateIds,
                  candidateTierMin, recurrence, horizon, parentDesireId }) {
    _userDb(userId).prepare(`
      INSERT INTO desires (id, raw_text, category, activity_type,
        social_size_min, social_size_max, time_window_start, time_window_end, priority,
        candidate_strategy, candidate_ids, candidate_tier_min, recurrence, horizon, parent_desire_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, rawText, category, activityType || 'any',
           socialSizeMin || 0, socialSizeMax || 0,
           windowStart, windowEnd, priority || 'want',
           candidateStrategy || 'any', candidateIds || null,
           candidateTierMin ?? 1, recurrence || 'none',
           horizon || 'one_off', parentDesireId || null);
  },

  zeroDesireRawText(userId, id) {
    _userDb(userId).prepare(`
      UPDATE desires SET raw_text = '', raw_text_zeroed = 1,
        updated_at = strftime('%s','now') WHERE id = ?
    `).run(id);
  },

  getCoordDesire(userId, id) {
    return _userDb(userId).prepare('SELECT * FROM coord_desires WHERE id = ?').get(id);
  },

  getPendingSocialDesires(userId) {
    return _userDb(userId).prepare(`
      SELECT * FROM coord_desires
      WHERE status = 'pending'
      AND category IN ('social','dining','outdoor','live_music','dancing','drinks','sports','culture')
      ORDER BY created_at ASC
    `).all();
  },

  updateDesireStatus(userId, id, status) {
    _userDb(userId).prepare(`
      UPDATE desires SET status = ?, updated_at = strftime('%s','now') WHERE id = ?
    `).run(status, id);
  },

  getDueRecurringTemplates(userId) {
    return _userDb(userId).prepare(`
      SELECT d.* FROM coord_desires d
      WHERE d.horizon = 'template'
      AND (d.recurrence_end IS NULL OR d.recurrence_end >= date('now'))
      AND NOT EXISTS (
        SELECT 1 FROM desires child
        WHERE child.parent_desire_id = d.id
        AND child.time_window_start >= date('now', 'weekday 0', '-7 days')
      )
    `).all();
  },

  // ── Coordination sessions (main) ──────────────────────────────────────────
  // Kept in main so inbound MCP messages can be routed without knowing userId first.

  createCoordSession({ id, desireId, initiatorUserId, role, expiresAt, purgeAfter }) {
    main.prepare(`
      INSERT INTO coordination_sessions
        (id, desire_id, initiator_user_id, role, expires_at, purge_after)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, desireId, initiatorUserId, role || 'initiator', expiresAt, purgeAfter);
  },

  getCoordSession(id) {
    return main.prepare('SELECT * FROM coordination_sessions WHERE id = ?').get(id);
  },

  updateCoordSession(id, fields) {
    const allowed = ['state', 'round', 'agreed_slot_start', 'agreed_slot_duration',
                     'agreed_activity', 'escalation_reason'];
    const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
    if (!sets.length) return;
    main.prepare(`
      UPDATE coordination_sessions SET ${sets.join(', ')}, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(...sets.map(s => fields[s.split(' ')[0]]), id);
  },

  createCoordPeer({ id, sessionId, peerAgentId, peerUserId }) {
    main.prepare(`
      INSERT INTO coord_session_peers (id, session_id, peer_agent_id, peer_user_id)
      VALUES (?, ?, ?, ?)
    `).run(id, sessionId, peerAgentId, peerUserId || null);
  },

  getCoordPeers(sessionId) {
    return main.prepare('SELECT * FROM coord_session_peers WHERE session_id = ?').all(sessionId);
  },

  getCoordPeer(sessionId, peerAgentId) {
    return main.prepare(
      'SELECT * FROM coord_session_peers WHERE session_id = ? AND peer_agent_id = ?'
    ).get(sessionId, peerAgentId);
  },

  updateCoordPeer(id, fields) {
    const allowed = ['state', 'available_days', 'offered_windows'];
    const sets    = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
    if (!sets.length) return;
    const values  = sets.map(s => {
      const k = s.split(' ')[0];
      return (k === 'available_days' || k === 'offered_windows')
        ? JSON.stringify(fields[k]) : fields[k];
    });
    main.prepare(`
      UPDATE coord_session_peers SET ${sets.join(', ')}, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(...values, id);
  },

  getCoordPeerByAgentId(peerAgentId, sessionId) {
    return main.prepare(
      'SELECT * FROM coord_session_peers WHERE peer_agent_id = ? AND session_id = ?'
    ).get(peerAgentId, sessionId);
  },

  // ── Ambient signals (main) ────────────────────────────────────────────────

  upsertAmbientSignal({ id, fromAgentId, category, area, date, period, certainty, openToCompany, expiresAt }) {
    main.prepare(`
      INSERT INTO ambient_signals (id, from_agent_id, category, area, date, period, certainty, open_to_company, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        certainty = excluded.certainty,
        open_to_company = excluded.open_to_company,
        expires_at = excluded.expires_at
    `).run(id, fromAgentId || null, category, area || null, date, period, certainty,
           openToCompany ? 1 : 0, expiresAt);
  },

  getAmbientSignalsForDate(date) {
    return main.prepare(`
      SELECT * FROM ambient_signals
      WHERE date = ? AND expires_at > datetime('now')
      ORDER BY created_at DESC
    `).all(date);
  },

  deleteAmbientSignal(fromAgentId, date, category) {
    main.prepare(
      'DELETE FROM ambient_signals WHERE from_agent_id = ? AND date = ? AND category = ?'
    ).run(fromAgentId, date, category);
  },

  // ── Wallets (per-user) ────────────────────────────────────────────────────

  getWallet(userId) {
    return _userDb(userId).prepare('SELECT * FROM user_wallets WHERE id = ?').get('singleton');
  },

  upsertWallet(userId, { wallet_address, clawbank_account_id }) {
    const udb      = _userDb(userId);
    const existing = udb.prepare('SELECT id FROM user_wallets WHERE id = ?').get('singleton');
    if (existing) {
      udb.prepare(`
        UPDATE user_wallets SET wallet_address = ?, clawbank_account_id = ?,
          updated_at = strftime('%s','now') WHERE id = 'singleton'
      `).run(wallet_address || null, clawbank_account_id || null);
    } else {
      udb.prepare(`
        INSERT INTO user_wallets (id, wallet_address, clawbank_account_id)
        VALUES ('singleton', ?, ?)
      `).run(wallet_address || null, clawbank_account_id || null);
    }
  },

  // ── Available windows (stub for coordination deps) ────────────────────────
  // Returns availability windows for a user (from preferences + calendar).
  // Currently returns an empty array — wire to Google Calendar when ready.
  getAvailableWindows(userId) {
    const prefs = this.getPreferences(userId);
    if (!prefs || !prefs.preferred_times) return [];
    try { return JSON.parse(prefs.preferred_times); } catch { return []; }
  },

};
