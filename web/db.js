/**
 * ButterflAI database module
 *
 * All SQL lives here. No raw queries elsewhere.
 * Sections:
 *   Users · Contacts · Contact preferences · Private data · Access audit
 *   Invites · SMS opt-outs · Onboarding · Relationships · Cadences
 *   Activities · Inbound messages · Wallets
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { toE164 } = require('./phoneUtils');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'butterflai.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Apply schema (idempotent — all statements use IF NOT EXISTS)
const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
db.exec(schema);

// Migration tracking table — ensures each migration file runs exactly once
db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
)`);

// Apply any pending migrations (skips already-applied ones).
// Collects from two directories and applies in sorted order:
//   ../db/migrations/  — shared base migrations (001_sms_and_audit, 002_consent_records, …)
//   ./db/migrations/   — web-layer migrations (003_coordination, 009_attendance_confirmations, …)
// Both are merged and sorted by filename so numbering stays consistent.
// Docker does the same merge at build time (COPY db/ ./db/ after COPY web/ ./),
// so production and test see identical migration sets.
function applyMigrations() {
  const dirs = [
    path.join(__dirname, '..', 'db', 'migrations'), // root db/migrations/
    path.join(__dirname, 'db', 'migrations'),        // web/db/migrations/
  ];

  // Collect unique filenames across both dirs, prefer later dir on conflict
  const fileMap = new Map(); // filename → full path
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql'))) {
      fileMap.set(file, path.join(dir, file));
    }
  }

  const files = [...fileMap.keys()].sort();
  for (const file of files) {
    const alreadyApplied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (alreadyApplied) continue;
    const sql = fs.readFileSync(fileMap.get(file), 'utf8');
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    let allOk = true;
    for (const stmt of statements) {
      try { db.exec(stmt + ';'); } catch (err) {
        const safe = ['already exists', 'duplicate column', 'no such table'];
        if (safe.some(s => err.message.includes(s))) {
          // Schema handled elsewhere (e.g. CREATE TABLE IF NOT EXISTS in app code); mark applied.
          console.log(`[migration] ${file}: skipped safe (${err.message.split('\n')[0]})`);
        } else {
          console.error(`[migration] ${file}: ${err.message}`);
          allOk = false;
        }
      }
    }
    if (allOk) {
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      console.log(`[migration] applied ${file}`);
    }
  }
}

applyMigrations();

module.exports = {

  // Escape hatch for one-off queries (cadence engine, migrations, etc.)
  // Use sparingly — prefer named methods above.
  _raw() { return db; },

  // ── Users ──────────────────────────────────────────────────────────────────

  getUser(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  getUserByPhone(phone) {
    return db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  },

  getUserByTelegramId(telegramId) {
    return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
  },

  createUser({ id, phone, name, onboarding_state, telegram_id, telegram_username, clawbank_pubkey }) {
    const result = db.prepare(`
      INSERT INTO users (id, phone, name, onboarding_state, telegram_id, telegram_username, clawbank_pubkey)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      phone || null,
      name || 'unknown',
      onboarding_state || 'new',
      telegram_id || null,
      telegram_username || null,
      clawbank_pubkey || null,
    );

    // Grant baseline FLAI on user creation — ledger failure must never break signup
    try {
      const { BASELINE_GRANT } = require('./flai');
      db.prepare(`
        INSERT INTO flai_ledger (user_id, delta, reason, metadata)
        VALUES (?, ?, 'baseline_grant', '{}')
      `).run(id, BASELINE_GRANT);
    } catch (ledgerErr) {
      console.error('[db] baseline_grant ledger write failed (non-fatal):', ledgerErr.message);
    }

    return result;
  },

  updateUser(id, fields) {
    const allowed = ['name', 'phone', 'onboarding_state', 'onboarding_data',
                     'telegram_id', 'telegram_chat_id', 'agent_endpoint'];
    const sets = Object.keys(fields)
      .filter(k => allowed.includes(k))
      .map(k => `${k} = ?`);
    if (!sets.length) return;
    const values = sets.map(s => fields[s.split(' ')[0]]);
    db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`)
      .run(...values, id);
  },

  setUserTelegramChatId(userId, telegramId, chatId) {
    db.prepare(`
      UPDATE users SET telegram_id = ?, telegram_chat_id = ?, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(String(telegramId), String(chatId), userId);
  },

  // ── Contacts ───────────────────────────────────────────────────────────────

  getContact(id) {
    return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  },

  getContactByPhone(phone) {
    return db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
  },

  getContactByTelegramId(telegramId) {
    return db.prepare('SELECT * FROM contacts WHERE telegram_id = ?').get(String(telegramId));
  },

  /**
   * Find a contact linked to a peer agent endpoint.
   * Used by the MCP inbound handler to verify consent before accepting coord messages.
   * Joins through the contact's linked user record to find the agent_endpoint.
   */
  getContactByAgentEndpoint(agentEndpoint, ownerUserId) {
    return db.prepare(`
      SELECT c.*, ce.can_coordinate
      FROM contacts c
      JOIN consent_edges ce ON ce.contact_id = c.id AND ce.user_id = ?
      JOIN users u ON u.phone = c.phone
      WHERE u.agent_endpoint = ?
      LIMIT 1
    `).get(ownerUserId, agentEndpoint);
  },

  getContactsByUser(userId) {
    return db.prepare('SELECT * FROM contacts WHERE invited_by_user_id = ? ORDER BY name').all(userId);
  },

  /**
   * Create or update a contact by phone number.
   * If a contact with this phone already exists for this user, updates name/tier.
   * Returns the contact id.
   */
  upsertContact({ invited_by_user_id, name, phone, notes, tier = 0 }) {
    const { v4: uuidv4 } = require('uuid');
    const normalizedPhone = phone ? toE164(phone) : null;
    if (normalizedPhone) {
      const existing = db.prepare(
        'SELECT * FROM contacts WHERE invited_by_user_id = ? AND phone = ?'
      ).get(invited_by_user_id, normalizedPhone);
      if (existing) {
        db.prepare(`
          UPDATE contacts SET name = ?, updated_at = strftime('%s','now') WHERE id = ?
        `).run(name, existing.id);
        return existing.id;
      }
    }
    const id = uuidv4();
    db.prepare(`
      INSERT INTO contacts (id, invited_by_user_id, name, phone, tier)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, invited_by_user_id, name, normalizedPhone, tier);
    return id;
  },

  createContact({ id, invited_by_user_id, name, phone, telegram_id, telegram_username, tier, opted_out_at }) {
    return db.prepare(`
      INSERT INTO contacts (id, invited_by_user_id, name, phone, telegram_id, telegram_username, tier, opted_out_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, invited_by_user_id, name,
      phone || null, telegram_id || null, telegram_username || null,
      tier ?? 0, opted_out_at || null,
    );
  },

  updateContact(id, fields) {
    const allowed = ['name', 'phone', 'tier', 'opted_out_at', 'telegram_id', 'telegram_chat_id', 'nickname', 'also_known_as'];
    const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
    if (!sets.length) return;
    const values = sets.map(s => fields[s.split(' ')[0]]);
    db.prepare(`UPDATE contacts SET ${sets.join(', ')}, updated_at = strftime('%s','now') WHERE id = ?`)
      .run(...values, id);
  },

  setContactTelegramId(contactId, telegramId, chatId) {
    db.prepare(`
      UPDATE contacts SET telegram_id = ?, telegram_chat_id = ?, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(String(telegramId), String(chatId), contactId);
  },

  optOutContact(id) {
    db.prepare(`
      UPDATE contacts SET tier = 0, opted_out_at = strftime('%s','now'), updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(id);
  },

  // ── Contact preferences (non-sensitive) ───────────────────────────────────

  setContactPreferences({ contact_id, availability_notes, neighborhoods, dietary, comm_preference }) {
    return db.prepare(`
      INSERT INTO contact_preferences (contact_id, availability_notes, neighborhoods, dietary, comm_preference)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(contact_id) DO UPDATE SET
        availability_notes = excluded.availability_notes,
        neighborhoods = excluded.neighborhoods,
        dietary = excluded.dietary,
        comm_preference = excluded.comm_preference,
        updated_at = strftime('%s','now')
    `).run(
      contact_id,
      availability_notes || null,
      neighborhoods ? JSON.stringify(neighborhoods) : null,
      dietary ? JSON.stringify(dietary) : null,
      comm_preference || 'sms',
    );
  },

  getContactPreferences(contactId) {
    return db.prepare('SELECT * FROM contact_preferences WHERE contact_id = ?').get(contactId);
  },

  // ── Private data (encrypted at rest) ──────────────────────────────────────

  getPrivateData(userId) {
    return db.prepare('SELECT * FROM private_data WHERE user_id = ?').get(userId);
  },

  upsertPrivateData(userId, { ciphertext, iv, tag, wrapped_key }) {
    return db.prepare(`
      INSERT INTO private_data (user_id, ciphertext, iv, tag, wrapped_key)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        iv = excluded.iv,
        tag = excluded.tag,
        wrapped_key = excluded.wrapped_key,
        version = version + 1,
        updated_at = strftime('%s','now')
    `).run(userId, ciphertext, iv, tag, wrapped_key);
  },

  deletePrivateData(userId) {
    return db.prepare('DELETE FROM private_data WHERE user_id = ?').run(userId);
  },

  // ── Access audit log ───────────────────────────────────────────────────────

  writeAccessAudit({ userId, accessor, purpose, recordClass, outsideNormalPath }) {
    return db.prepare(`
      INSERT INTO access_audit (user_id, accessor, purpose, record_class, outside_normal_path)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, accessor, purpose, recordClass, outsideNormalPath ? 1 : 0);
  },

  getAccessAuditForUser(userId, limit = 100) {
    return db.prepare(`
      SELECT * FROM access_audit WHERE user_id = ? ORDER BY accessed_at DESC LIMIT ?
    `).all(userId, limit);
  },

  // ── Invites ────────────────────────────────────────────────────────────────

  getInvite(token) {
    return db.prepare('SELECT * FROM invites WHERE token = ?').get(token);
  },

  createInvite({ token, created_by_user_id, contact_name, expires_at }) {
    return db.prepare(`
      INSERT INTO invites (token, created_by_user_id, contact_name, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(token, created_by_user_id, contact_name || null, expires_at || null);
  },

  resolveInvite(token, status, contactId) {
    return db.prepare(`
      UPDATE invites SET status = ?, contact_id = ?, resolved_at = strftime('%s','now')
      WHERE token = ?
    `).run(status, contactId || null, token);
  },

  getPendingInvitesByUser(userId) {
    return db.prepare(`
      SELECT * FROM invites WHERE created_by_user_id = ? AND status = 'pending' ORDER BY created_at DESC
    `).all(userId);
  },

  // ── SMS opt-outs ───────────────────────────────────────────────────────────

  isOptedOut(phone) {
    return !!db.prepare('SELECT 1 FROM sms_optouts WHERE phone = ?').get(toE164(phone));
  },

  recordOptOut(phone, source = 'stop_reply') {
    db.prepare(`
      INSERT OR REPLACE INTO sms_optouts (phone, opted_out_at, source) VALUES (?, strftime('%s','now'), ?)
    `).run(phone, source);
    // Also tier-0 any contact with this phone
    db.prepare(`
      UPDATE contacts SET tier = 0, opted_out_at = strftime('%s','now'), updated_at = strftime('%s','now')
      WHERE phone = ?
    `).run(phone);
  },

  removeOptOut(phone) {
    db.prepare('DELETE FROM sms_optouts WHERE phone = ?').run(toE164(phone));
  },

  // ── Onboarding intents ─────────────────────────────────────────────────────

  createOnboardingIntent({ id, user_id, contact_name, frequency, activity_type, group_size }) {
    return db.prepare(`
      INSERT INTO onboarding_intents (id, user_id, contact_name, frequency, activity_type, group_size)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, user_id, contact_name, frequency, activity_type || null, group_size || 'one_on_one');
  },

  getOnboardingIntents(userId) {
    return db.prepare('SELECT * FROM onboarding_intents WHERE user_id = ? ORDER BY created_at').all(userId);
  },

  confirmOnboardingIntents(userId) {
    db.prepare('UPDATE onboarding_intents SET confirmed = 1 WHERE user_id = ?').run(userId);
  },

  deleteOnboardingIntents(userId) {
    db.prepare('DELETE FROM onboarding_intents WHERE user_id = ?').run(userId);
  },

  // ── Relationships ──────────────────────────────────────────────────────────

  createRelationship({ id, user_id, contact_id, contact_is_user, nickname, notes }) {
    return db.prepare(`
      INSERT INTO relationships (id, user_id, contact_id, contact_is_user, nickname, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, user_id, contact_id, contact_is_user ? 1 : 0, nickname || null, notes || null);
  },

  getRelationshipsByUser(userId) {
    return db.prepare('SELECT * FROM relationships WHERE user_id = ?').all(userId);
  },

  // ── Cadences ───────────────────────────────────────────────────────────────

  createCadence({ id, relationship_id, activity_type, frequency, group_size, budget_per_person, preferred_areas, preferred_times }) {
    return db.prepare(`
      INSERT INTO cadences (id, relationship_id, activity_type, frequency, group_size, budget_per_person, preferred_areas, preferred_times)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, relationship_id, activity_type, frequency,
      group_size || 'one_on_one',
      budget_per_person || null,
      preferred_areas ? JSON.stringify(preferred_areas) : null,
      preferred_times || null,
    );
  },

  getCadencesByUser(userId) {
    return db.prepare(`
      SELECT c.* FROM cadences c
      JOIN relationships r ON c.relationship_id = r.id
      WHERE r.user_id = ? AND c.active = 1
      ORDER BY c.next_target_at ASC NULLS LAST
    `).all(userId);
  },

  updateCadenceLastFulfilled(cadenceId, ts) {
    db.prepare(`
      UPDATE cadences SET last_fulfilled_at = ?, updated_at = strftime('%s','now') WHERE id = ?
    `).run(ts, cadenceId);
  },

  // ── Activities ─────────────────────────────────────────────────────────────

  getActivity(id) {
    return db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
  },

  getActivityOrganiser(activityId) {
    return db.prepare(`
      SELECT u.* FROM activities a
      JOIN cadences c ON a.cadence_id = c.id
      JOIN relationships r ON c.relationship_id = r.id
      JOIN users u ON r.user_id = u.id
      WHERE a.id = ?
    `).get(activityId);
  },

  updateActivityResponse(activityId, phone, response) {
    const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
    if (!activity) return;
    const responses = JSON.parse(activity.responses || '{}');
    responses[phone] = response;
    db.prepare(`UPDATE activities SET responses = ?, updated_at = strftime('%s','now') WHERE id = ?`)
      .run(JSON.stringify(responses), activityId);
  },

  setActivityTimeChoice(activityId, phone, slotIndex) {
    const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
    if (!activity) return;
    const choices = JSON.parse(activity.time_choices || '{}');
    choices[phone] = slotIndex;
    db.prepare(`UPDATE activities SET time_choices = ?, updated_at = strftime('%s','now') WHERE id = ?`)
      .run(JSON.stringify(choices), activityId);
  },

  // ── Inbound messages (agent queue) ─────────────────────────────────────────

  storeInboundMessage({ from_phone, from_telegram_id, from_type, from_id, channel, text }) {
    return db.prepare(`
      INSERT INTO inbound_messages (id, from_phone, from_telegram_id, from_type, from_id, channel, text)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?)
    `).run(
      from_phone || null,
      from_telegram_id ? String(from_telegram_id) : null,
      from_type, from_id,
      channel || 'sms',
      text,
    );
  },

  getPendingInboundMessages() {
    return db.prepare(`
      SELECT * FROM inbound_messages WHERE processed = 0 ORDER BY created_at ASC
    `).all();
  },

  // ── Conversation history (agent context across turns) ──────────────────────

  appendConversation(userId, role, text) {
    const { v4: uuidv4 } = require('uuid');
    db.prepare(`
      INSERT INTO conversation_history (id, user_id, role, text)
      VALUES (?, ?, ?, ?)
    `).run(uuidv4(), userId, role, text.slice(0, 4000));
  },

  getRecentConversation(userId, limit = 20) {
    // Returns oldest-first so it reads naturally as a chat log
    const rows = db.prepare(`
      SELECT role, text, created_at FROM conversation_history
      WHERE user_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(userId, limit);
    return rows.reverse();
  },

  markMessageProcessed(id) {
    db.prepare('UPDATE inbound_messages SET processed = 1 WHERE id = ?').run(id);
  },

  // ── Pending actions (stateful SMS conversations) ──────────────────────────

  createPendingAction({ id, user_id, action_type, payload, ttl_secs }) {
    const expires_at = Math.floor(Date.now() / 1000) + (ttl_secs || 86400);
    return db.prepare(`
      INSERT INTO pending_actions (id, user_id, action_type, payload, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, user_id, action_type, JSON.stringify(payload || {}), expires_at);
  },

  getPendingAction(userId) {
    // Get the most recent non-expired pending action for a user
    return db.prepare(`
      SELECT * FROM pending_actions
      WHERE user_id = ? AND expires_at > strftime('%s','now')
      ORDER BY created_at DESC LIMIT 1
    `).get(userId);
  },

  deletePendingAction(id) {
    db.prepare('DELETE FROM pending_actions WHERE id = ?').run(id);
  },

  clearExpiredPendingActions() {
    db.prepare(`DELETE FROM pending_actions WHERE expires_at <= strftime('%s','now')`).run();
  },

  // ── Consent ledger ────────────────────────────────────────────────────────

  /**
   * Record an explicit opt-in event.
   * @param {string} phone             - E.164 phone number
   * @param {'SELF_START'|'INVITE_PAGE'} source
   * @param {string} [disclosureVersion]
   */
  writeConsent(phone, source, disclosureVersion = '1.0') {
    return db.prepare(`
      INSERT INTO consent_records (phone, consent_source, disclosure_version)
      VALUES (?, ?, ?)
    `).run(toE164(phone), source, disclosureVersion);
  },

  /**
   * Return the most recent consent record for a phone number, or undefined.
   * Phone is normalized to E.164 before lookup.
   * @param {string} phone
   */
  getConsent(phone) {
    return db.prepare(`
      SELECT * FROM consent_records WHERE phone = ? ORDER BY consented_at DESC LIMIT 1
    `).get(toE164(phone));
  },

  /** Returns true if there is at least one consent record for the phone number. */
  hasConsent(phone) {
    const row = db.prepare(`
      SELECT 1 FROM consent_records WHERE phone = ? LIMIT 1
    `).get(toE164(phone));
    return !!row;
  },

  // ── User preferences ──────────────────────────────────────────────────────

  getPreferences(userId) {
    const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId);
    if (!row) return null;
    // Parse JSON columns
    const jsonCols = ['dietary_restrictions','food_allergies','cuisine_loves','cuisine_avoids',
                      'activity_loves','activity_avoids','vibe'];
    for (const col of jsonCols) {
      try { row[col] = JSON.parse(row[col] || '[]'); } catch { row[col] = []; }
    }
    return row;
  },

  upsertPreferences(userId, fields) {
    // Stringify any array/object fields before writing
    const jsonCols = ['dietary_restrictions','food_allergies','cuisine_loves','cuisine_avoids',
                      'activity_loves','activity_avoids','vibe'];
    const toWrite = { ...fields };
    for (const col of jsonCols) {
      if (col in toWrite && Array.isArray(toWrite[col])) {
        toWrite[col] = JSON.stringify(toWrite[col]);
      }
    }
    const existing = db.prepare('SELECT user_id FROM user_preferences WHERE user_id = ?').get(userId);
    if (!existing) {
      const cols = ['user_id', ...Object.keys(toWrite)].join(', ');
      const placeholders = ['?', ...Object.keys(toWrite).map(() => '?')].join(', ');
      db.prepare(`INSERT INTO user_preferences (${cols}) VALUES (${placeholders})`)
        .run(userId, ...Object.values(toWrite));
    } else {
      const sets = Object.keys(toWrite).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE user_preferences SET ${sets}, updated_at = strftime('%s','now') WHERE user_id = ?`)
        .run(...Object.values(toWrite), userId);
    }
    return this.getPreferences(userId);
  },

  // ── Agent-to-agent messages ────────────────────────────────────────────────

  sendAgentMessage({ fromUserId, toUserId, threadId, kind, topic, body }) {
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    db.prepare(`
      INSERT INTO agent_messages (id, from_user, to_user, thread_id, kind, topic, body)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, fromUserId, toUserId, threadId || id, kind, topic, body.slice(0, 2000));
    return id;
  },

  getPendingAgentMessages(toUserId) {
    return db.prepare(`
      SELECT * FROM agent_messages
      WHERE to_user = ? AND processed = 0
      ORDER BY created_at ASC
    `).all(toUserId);
  },

  markAgentMessageProcessed(id) {
    db.prepare('UPDATE agent_messages SET processed = 1 WHERE id = ?').run(id);
  },

  // ── Desires ───────────────────────────────────────────────────────────────

  createDesire({ id, userId, rawText, category, activityType, socialSizeMin, socialSizeMax,
                  windowStart, windowEnd, priority, candidateStrategy, candidateIds,
                  candidateTierMin, recurrence, horizon, parentDesireId }) {
    return db.prepare(`
      INSERT INTO desires (id, user_id, raw_text, category, activity_type,
        social_size_min, social_size_max, time_window_start, time_window_end, priority,
        candidate_strategy, candidate_ids, candidate_tier_min, recurrence, horizon, parent_desire_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, rawText, category, activityType || 'any',
           socialSizeMin || 0, socialSizeMax || 0,
           windowStart, windowEnd, priority || 'want',
           candidateStrategy || 'any', candidateIds || null,
           candidateTierMin ?? 1, recurrence || 'none',
           horizon || 'one_off', parentDesireId || null);
  },

  // Zero raw_text immediately after parsing — structured fields are all we need
  zeroDesireRawText(id) {
    return db.prepare(`UPDATE desires SET raw_text = '', raw_text_zeroed = 1,
      updated_at = strftime('%s','now') WHERE id = ?`).run(id);
  },

  getDueRecurringTemplates(userId) {
    // Templates are due if: they have no children in the current week,
    // or the recurrence_end hasn't passed yet
    return db.prepare(`
      SELECT d.* FROM coord_desires d
      WHERE d.user_id = ? AND d.horizon = 'template'
      AND (d.recurrence_end IS NULL OR d.recurrence_end >= date('now'))
      AND NOT EXISTS (
        SELECT 1 FROM desires child
        WHERE child.parent_desire_id = d.id
        AND child.time_window_start >= date('now', 'weekday 0', '-7 days')
      )
    `).all(userId);
  },

  // Returns coord-safe fields only — raw_text excluded
  getCoordDesire(id) {
    return db.prepare('SELECT * FROM coord_desires WHERE id = ?').get(id);
  },

  getPendingSocialDesires(userId) {
    return db.prepare(`
      SELECT * FROM coord_desires
      WHERE user_id = ? AND status = 'pending'
      AND category IN ('social','dining','outdoor','live_music','dancing','drinks','sports','culture')
      ORDER BY created_at ASC
    `).all(userId);
  },

  updateDesireStatus(id, status) {
    return db.prepare(`
      UPDATE desires SET status = ?, updated_at = strftime('%s','now') WHERE id = ?
    `).run(status, id);
  },

  // ── Coordination sessions ─────────────────────────────────────────────────

  createCoordSession({ id, desireId, initiatorUserId, role, expiresAt, purgeAfter }) {
    return db.prepare(`
      INSERT INTO coordination_sessions
        (id, desire_id, initiator_user_id, role, expires_at, purge_after)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, desireId, initiatorUserId, role || 'initiator', expiresAt, purgeAfter);
  },

  getCoordSession(id) {
    return db.prepare('SELECT * FROM coordination_sessions WHERE id = ?').get(id);
  },

  updateCoordSession(id, fields) {
    const allowed = ['state', 'round', 'agreed_slot_start', 'agreed_slot_duration',
                     'agreed_activity', 'escalation_reason'];
    const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
    if (!sets.length) return;
    db.prepare(`
      UPDATE coordination_sessions SET ${sets.join(', ')}, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(...sets.map(s => fields[s.split(' ')[0]]), id);
  },

  // ── Coordination session peers ────────────────────────────────────────────

  createCoordPeer({ id, sessionId, peerAgentId, peerUserId }) {
    return db.prepare(`
      INSERT INTO coord_session_peers (id, session_id, peer_agent_id, peer_user_id)
      VALUES (?, ?, ?, ?)
    `).run(id, sessionId, peerAgentId, peerUserId || null);
  },

  getCoordPeers(sessionId) {
    return db.prepare('SELECT * FROM coord_session_peers WHERE session_id = ?').all(sessionId);
  },

  getCoordPeer(sessionId, peerAgentId) {
    return db.prepare('SELECT * FROM coord_session_peers WHERE session_id = ? AND peer_agent_id = ?')
      .get(sessionId, peerAgentId);
  },

  updateCoordPeer(id, fields) {
    const allowed = ['state', 'available_days', 'offered_windows', 'matched_windows',
                     'proposed_slot_start', 'proposed_slot_dur', 'rounds_used', 'last_msg_at'];
    const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
    if (!sets.length) return;
    // Stringify JSON fields
    const values = sets.map(s => {
      const k = s.split(' ')[0];
      return (k === 'available_days' || k === 'offered_windows' || k === 'matched_windows')
        ? JSON.stringify(fields[k]) : fields[k];
    });
    db.prepare(`
      UPDATE coord_session_peers SET ${sets.join(', ')}, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(...values, id);
  },

  getCoordPeerByAgentId(peerAgentId, sessionId) {
    return db.prepare('SELECT * FROM coord_session_peers WHERE peer_agent_id = ? AND session_id = ?')
      .get(peerAgentId, sessionId);
  },

  // ── Ambient signals ───────────────────────────────────────────────────────

  upsertAmbientSignal({ id, fromAgentId, category, area, date, period, certainty, openToCompany, expiresAt }) {
    return db.prepare(`
      INSERT INTO ambient_signals (id, from_agent_id, category, area, date, period, certainty, open_to_company, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        certainty = excluded.certainty,
        open_to_company = excluded.open_to_company,
        expires_at = excluded.expires_at
    `).run(id, fromAgentId, category, area || null, date, period, certainty, openToCompany ? 1 : 0, expiresAt);
  },

  getAmbientSignalsForDate(date) {
    return db.prepare(`
      SELECT * FROM ambient_signals
      WHERE date = ? AND expires_at > datetime('now')
      ORDER BY received_at DESC
    `).all(date);
  },

  deleteAmbientSignal(fromAgentId, date, category) {
    return db.prepare('DELETE FROM ambient_signals WHERE from_agent_id = ? AND date = ? AND category = ?')
      .run(fromAgentId, date, category);
  },

  // ── Wallets (stubbed) ──────────────────────────────────────────────────────

  getWallet(userId) {
    return db.prepare('SELECT * FROM user_wallets WHERE user_id = ?').get(userId);
  },

  upsertWallet(userId, { wallet_address, clawbank_account_id }) {
    return db.prepare(`
      INSERT INTO user_wallets (user_id, wallet_address, clawbank_account_id)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        wallet_address = excluded.wallet_address,
        clawbank_account_id = excluded.clawbank_account_id,
        updated_at = strftime('%s','now')
    `).run(userId, wallet_address || null, clawbank_account_id || null);
  },

  // ── Attendance confirmations (FLAI §2.1) ──────────────────────────────────

  createAttendanceConfirmation({ id, event_id, user_id, asked_at, source }) {
    return db.prepare(`
      INSERT INTO attendance_confirmations (id, event_id, user_id, asked_at, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, event_id, user_id, asked_at, source || 'sms_gate');
  },

  updateAttendanceConfirmation(id, { attended, confirmed_at }) {
    const sets = [];
    const values = [];
    if (attended !== undefined) { sets.push('attended = ?'); values.push(attended); }
    if (confirmed_at !== undefined) { sets.push('confirmed_at = ?'); values.push(confirmed_at); }
    if (!sets.length) return;
    db.prepare(`UPDATE attendance_confirmations SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id);
  },

  getAttendanceConfirmation(event_id, user_id) {
    return db.prepare(`
      SELECT * FROM attendance_confirmations WHERE event_id = ? AND user_id = ?
    `).get(event_id, user_id);
  },

  /**
   * Return events >12h past that the user accepted (responded YES to invite)
   * but have no attendance_confirmations row yet.
   * Uses the 'activities' table (see schema.sql).
   */
  getPendingAttendanceConfirmations(userId) {
    const twelveHoursAgo = Math.floor(Date.now() / 1000) - 43200;
    return db.prepare(`
      SELECT a.*, r.user_id as organizer_user_id
      FROM activities a
      JOIN cadences c ON a.cadence_id = c.id
      JOIN relationships r ON c.relationship_id = r.id
      WHERE r.user_id = ?
        AND a.status = 'completed'
        AND a.scheduled_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM attendance_confirmations ac
          WHERE ac.event_id = a.id AND ac.user_id = ?
        )
    `).all(userId, twelveHoursAgo, userId);
  },

  // ── Proposals (FLAI §2.2) ─────────────────────────────────────────────────

  createProposal({ id, user_id, cadence_id, origin, activity_type, surfaced_slots }) {
    return db.prepare(`
      INSERT INTO proposals (id, user_id, cadence_id, origin, activity_type, surfaced_slots)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id, user_id, cadence_id || null, origin, activity_type || null,
      surfaced_slots ? JSON.stringify(surfaced_slots) : null,
    );
  },

  updateProposalOutcome(proposalId, { outcome, event_id }) {
    db.prepare(`
      UPDATE proposals SET outcome = ?, event_id = ? WHERE id = ?
    `).run(outcome || null, event_id || null, proposalId);
  },

  getProposalByEvent(event_id) {
    return db.prepare('SELECT * FROM proposals WHERE event_id = ? LIMIT 1').get(event_id);
  },

  // ── FLAI ledger (FLAI §2.3) ───────────────────────────────────────────────

  appendFlaiLedger({ user_id, delta, reason, ref_id, metadata }) {
    return db.prepare(`
      INSERT INTO flai_ledger (user_id, delta, reason, ref_id, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      user_id || null, delta, reason, ref_id || null,
      metadata ? JSON.stringify(metadata) : '{}',
    );
  },

  getFlaiBalance(user_id) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(delta), 0) as balance FROM flai_ledger WHERE user_id = ?
    `).get(user_id);
    return row?.balance || 0;
  },

  // ── Referrals ─────────────────────────────────────────────────────────────

  createReferral({ id, referrer_user_id, referral_token }) {
    return db.prepare(`
      INSERT INTO referrals (id, referrer_user_id, referral_token)
      VALUES (?, ?, ?)
    `).run(id, referrer_user_id, referral_token);
  },

  getReferralByToken(token) {
    return db.prepare('SELECT * FROM referrals WHERE referral_token = ?').get(token);
  },

  redeemReferral(referral_token, referred_user_id) {
    return db.prepare(`
      UPDATE referrals SET status = 'joined', referred_user_id = ?
      WHERE referral_token = ? AND status = 'pending'
    `).run(referred_user_id, referral_token);
  },

  rewardReferral(id) {
    return db.prepare(`
      UPDATE referrals SET status = 'rewarded', rewarded_at = strftime('%s','now')
      WHERE id = ?
    `).run(id);
  },

  getUserByReferralToken(token) {
    return db.prepare('SELECT * FROM users WHERE referral_token = ?').get(token);
  },

  getOrCreateReferralToken(userId) {
    const user = db.prepare('SELECT referral_token FROM users WHERE id = ?').get(userId);
    if (user?.referral_token) return user.referral_token;
    // Generate an 8-char short token from a UUID
    const { v4: uuidv4 } = require('uuid');
    const token = uuidv4().replace(/-/g, '').slice(0, 8);
    db.prepare('UPDATE users SET referral_token = ? WHERE id = ?').run(token, userId);
    return token;
  },

  // ── Lift observations (FLAI §2.4) ────────────────────────────────────────

  appendLiftObservation({ event_id, user_id, estimator, value, confidence, inputs }) {
    return db.prepare(`
      INSERT INTO lift_observations (event_id, user_id, estimator, value, confidence, inputs)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event_id || null, user_id || null, estimator,
      value ?? null, confidence ?? null,
      inputs ? JSON.stringify(inputs) : '{}',
    );
  },

  // ── Admin helpers ──────────────────────────────────────────────────────────

  getAllUsers() {
    return db.prepare('SELECT id, name, phone, onboarding_state, created_at FROM users ORDER BY created_at DESC').all();
  },

  getFlaiLedgerSummary() {
    return db.prepare(`
      SELECT
        SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS total_granted,
        SUM(CASE WHEN delta < 0 THEN delta ELSE 0 END) AS total_burned,
        SUM(delta)                                      AS net_circulation,
        COUNT(DISTINCT user_id)                         AS users_with_activity
      FROM flai_ledger
    `).get();
  },

  getFlaiLedgerRecent(limit = 50) {
    return db.prepare(`
      SELECT l.id, l.user_id, u.name, u.phone, l.delta, l.reason, l.ref_id, l.created_at
      FROM flai_ledger l
      LEFT JOIN users u ON u.id = l.user_id
      ORDER BY l.created_at DESC LIMIT ?
    `).all(limit);
  },

  /** Spend breakdown grouped by reason — useful for admin "how are tokens being used" view */
  getFlaiSpendByReason() {
    return db.prepare(`
      SELECT
        reason,
        COUNT(*) AS events,
        SUM(delta) AS net,
        SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS granted,
        ABS(SUM(CASE WHEN delta < 0 THEN delta ELSE 0 END)) AS burned
      FROM flai_ledger
      GROUP BY reason
      ORDER BY net ASC
    `).all();
  },

  getUsersWithBalances() {
    return db.prepare(`
      SELECT u.id, u.name, u.phone, u.onboarding_state,
             COALESCE(SUM(l.delta), 0) AS balance
      FROM users u
      LEFT JOIN flai_ledger l ON l.user_id = u.id
      GROUP BY u.id
      ORDER BY balance DESC
    `).all();
  },

  // ── Web Push subscriptions ────────────────────────────────────────────────

  upsertPushSubscription({ id, user_id, endpoint, p256dh, auth }) {
    db.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id = excluded.user_id,
        p256dh  = excluded.p256dh,
        auth    = excluded.auth
    `).run(id, user_id, endpoint, p256dh, auth);
  },

  getPushSubscriptions(userId) {
    return db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  },

  deletePushSubscription(endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  },

};
