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

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'butterflai.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Apply schema (idempotent — all statements use IF NOT EXISTS)
const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
db.exec(schema);

// Apply any pending migrations that aren't yet in the live schema
// (safe to run multiple times — they'll throw on column-already-exists and we catch)
const migrationsDir = path.join(__dirname, 'db', 'migrations');
if (fs.existsSync(migrationsDir)) {
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // Run each statement individually so one failure doesn't block the rest
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      try { db.exec(stmt + ';'); } catch (_) { /* column/table already exists — ok */ }
    }
  }
}

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
    return db.prepare(`
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

  getContactsByUser(userId) {
    return db.prepare('SELECT * FROM contacts WHERE invited_by_user_id = ? ORDER BY name').all(userId);
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
    const allowed = ['name', 'phone', 'tier', 'opted_out_at', 'telegram_id', 'telegram_chat_id'];
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
    return !!db.prepare('SELECT 1 FROM sms_optouts WHERE phone = ?').get(phone);
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

};
