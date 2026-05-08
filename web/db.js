const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'butterflai.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
db.exec(schema);

module.exports = {
  // ── Users ──────────────────────────────────────────────────────────────────
  getUser(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  createUser({ id, name, telegram_id, telegram_username, clawbank_pubkey }) {
    return db.prepare(`
      INSERT INTO users (id, name, telegram_id, telegram_username, clawbank_pubkey)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, telegram_id || null, telegram_username || null, clawbank_pubkey || null);
  },

  updateUserTelegram(id, telegram_id) {
    return db.prepare(`
      UPDATE users SET telegram_id = ?, updated_at = strftime('%s','now') WHERE id = ?
    `).run(telegram_id, id);
  },

  // ── Contacts ───────────────────────────────────────────────────────────────
  createContact({ id, invited_by_user_id, name, telegram_id, telegram_username, tier, opted_out_at }) {
    return db.prepare(`
      INSERT INTO contacts (id, invited_by_user_id, name, telegram_id, telegram_username, tier, opted_out_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, invited_by_user_id, name, telegram_id || null, telegram_username || null, tier, opted_out_at || null);
  },

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
    `).run(contact_id, availability_notes || null, neighborhoods || null, dietary || null, comm_preference || 'telegram');
  },

  // ── Invites ────────────────────────────────────────────────────────────────
  getInvite(token) {
    return db.prepare('SELECT * FROM invites WHERE token = ?').get(token);
  },

  createInvite({ token, created_by_user_id, contact_name }) {
    return db.prepare(`
      INSERT INTO invites (token, created_by_user_id, contact_name)
      VALUES (?, ?, ?)
    `).run(token, created_by_user_id, contact_name || null);
  },

  resolveInvite(token, status, contactId) {
    return db.prepare(`
      UPDATE invites
      SET status = ?, contact_id = ?, resolved_at = strftime('%s','now')
      WHERE token = ?
    `).run(status, contactId || null, token);
  },

  getPendingInvitesByUser(userId) {
    return db.prepare(`
      SELECT * FROM invites WHERE created_by_user_id = ? AND status = 'pending'
      ORDER BY created_at DESC
    `).all(userId);
  },

  // ── Telegram linking ───────────────────────────────────────────────────────
  getContact(id) {
    return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  },

  getContactByTelegramId(telegramId) {
    return db.prepare('SELECT * FROM contacts WHERE telegram_id = ?').get(telegramId);
  },

  getUserByTelegramId(telegramId) {
    return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  },

  setContactTelegramId(contactId, telegramId, chatId) {
    return db.prepare(`
      UPDATE contacts
      SET telegram_id = ?, telegram_chat_id = ?, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(telegramId, String(chatId), contactId);
  },

  setUserTelegramChatId(userId, telegramId, chatId) {
    return db.prepare(`
      UPDATE users
      SET telegram_id = ?, telegram_chat_id = ?, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(telegramId, String(chatId), userId);
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

  updateActivityResponse(activityId, telegramId, response) {
    // Store per-participant responses in metadata JSON
    const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
    if (!activity) return;
    const responses = JSON.parse(activity.responses || '{}');
    responses[telegramId] = response;
    return db.prepare(`
      UPDATE activities SET responses = ?, updated_at = strftime('%s','now') WHERE id = ?
    `).run(JSON.stringify(responses), activityId);
  },

  setActivityTimeChoice(activityId, telegramId, slotIndex) {
    const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
    if (!activity) return;
    const choices = JSON.parse(activity.time_choices || '{}');
    choices[telegramId] = slotIndex;
    return db.prepare(`
      UPDATE activities SET time_choices = ?, updated_at = strftime('%s','now') WHERE id = ?
    `).run(JSON.stringify(choices), activityId);
  },

  // ── Inbound messages (agent queue) ─────────────────────────────────────────
  storeInboundMessage({ from_telegram_id, from_type, from_id, text, chat_id }) {
    return db.prepare(`
      INSERT INTO inbound_messages (id, from_telegram_id, from_type, from_id, text, chat_id)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)
    `).run(from_telegram_id, from_type, from_id, text, String(chat_id));
  },

  getPendingInboundMessages() {
    return db.prepare(`
      SELECT * FROM inbound_messages WHERE processed = 0 ORDER BY created_at ASC
    `).all();
  },

  markMessageProcessed(id) {
    return db.prepare(`UPDATE inbound_messages SET processed = 1 WHERE id = ?`).run(id);
  },
};
