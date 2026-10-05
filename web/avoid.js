/**
 * avoid.js — avoid lists ("act on, never say") and the agent activity log.
 *
 * PRIVACY.md "Using private data: act on it, never say it". An avoid-list entry
 * changes what the user's own agent does (who gets invited, how incoming invites
 * are answered) and is never said to anyone else.
 *
 * Storage: only user_id is plaintext. The avoided person and the per-person
 * policy are encrypted (sensitive.js cipher), so the table reveals nothing about
 * who. Every read is written to private_data_access_log. Entries never expire.
 * No reason is stored — only the operative rule (derive and discard).
 *
 * Per-person policy (on_invite) for invites FROM the avoided person:
 *   'auto_decline' (default) — answered "not available", logged in agent activity
 *   'ask'                    — the user is asked before their agent responds
 * Group events that merely INCLUDE an avoided person always ask (owner decision).
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const sensitive = require('./sensitive');

const POLICIES = ['auto_decline', 'ask'];
const LOG_KEY = 'avoid_list';

// Compare phones by their last 10 digits so +1 / formatting differences match.
function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function seal(obj) {
  const e = sensitive.encrypt(JSON.stringify(obj));
  return { ct: e.encrypted_v, iv: e.iv, tag: e.auth_tag };
}

function unseal(row) {
  return JSON.parse(sensitive.decrypt(row.ct, row.iv, row.tag));
}

/**
 * Decrypt the user's avoid list. `accessor` and `context` go to the access log.
 * Returns [{ id, contact_id, name, phone, on_invite }].
 */
function listAvoid(userId, { accessor = 'agent', context = 'agent_reasoning' } = {}) {
  const rows = db._raw().prepare('SELECT * FROM avoid_list WHERE user_id = ? ORDER BY created_at').all(userId);
  sensitive.logAccess(userId, accessor, LOG_KEY, 'read', context);
  return rows.map((r) => ({ id: r.id, ...unseal(r) }));
}

/**
 * Add (or update the policy of) an avoid-list entry for one of the user's own
 * contacts. Idempotent per contact.
 */
function addAvoid(userId, contactId, { onInvite = 'auto_decline' } = {}) {
  if (!POLICIES.includes(onInvite)) return { error: 'INVALID_POLICY', message: `on_invite must be one of ${POLICIES.join(', ')}` };
  const contact = db.getContact(contactId);
  if (!contact || contact.invited_by_user_id !== userId) return { error: 'CONTACT_NOT_FOUND' };
  if (!phoneKey(contact.phone)) return { error: 'CONTACT_HAS_NO_PHONE', message: 'An avoid-list entry needs a phone number to recognise this person.' };

  const name = contact.nickname || contact.name;
  const existing = listAvoid(userId, { context: 'avoid_list add' }).find((e) => e.contact_id === contactId);
  const payload = { contact_id: contactId, name, phone: contact.phone, on_invite: onInvite };
  const { ct, iv, tag } = seal(payload);

  if (existing) {
    db._raw().prepare(`UPDATE avoid_list SET ct = ?, iv = ?, tag = ?, updated_at = strftime('%s','now') WHERE id = ? AND user_id = ?`)
      .run(ct, iv, tag, existing.id, userId);
    sensitive.logAccess(userId, 'agent', LOG_KEY, 'write', 'avoid_list update');
    return { ok: true, id: existing.id, name, on_invite: onInvite, updated: true };
  }
  const id = uuidv4();
  db._raw().prepare('INSERT INTO avoid_list (id, user_id, ct, iv, tag) VALUES (?, ?, ?, ?, ?)').run(id, userId, ct, iv, tag);
  sensitive.logAccess(userId, 'agent', LOG_KEY, 'write', 'avoid_list add');
  return { ok: true, id, name, on_invite: onInvite, created: true };
}

function setPolicy(userId, entryId, onInvite, { accessor = 'agent' } = {}) {
  if (!POLICIES.includes(onInvite)) return { error: 'INVALID_POLICY', message: `on_invite must be one of ${POLICIES.join(', ')}` };
  const row = db._raw().prepare('SELECT * FROM avoid_list WHERE id = ? AND user_id = ?').get(entryId, userId);
  if (!row) return { error: 'NOT_FOUND' };
  const payload = { ...unseal(row), on_invite: onInvite };
  const { ct, iv, tag } = seal(payload);
  db._raw().prepare(`UPDATE avoid_list SET ct = ?, iv = ?, tag = ?, updated_at = strftime('%s','now') WHERE id = ? AND user_id = ?`)
    .run(ct, iv, tag, entryId, userId);
  sensitive.logAccess(userId, accessor, LOG_KEY, 'write', 'avoid_list set_policy');
  return { ok: true, id: entryId, name: payload.name, on_invite: onInvite };
}

function removeAvoid(userId, entryId, { accessor = 'agent' } = {}) {
  const info = db._raw().prepare('DELETE FROM avoid_list WHERE id = ? AND user_id = ?').run(entryId, userId);
  if (!info.changes) return { error: 'NOT_FOUND' };
  sensitive.logAccess(userId, accessor, LOG_KEY, 'delete', 'avoid_list remove');
  return { ok: true, removed: true };
}

/** The avoid-list entry matching this phone, or null. */
function findByPhone(entries, phone) {
  const key = phoneKey(phone);
  return key ? entries.find((e) => phoneKey(e.phone) === key) || null : null;
}

// ── Agent activity log (owner-only, encrypted descriptions) ───────────────────

function recordActivity(userId, kind, { text, eventId = null, avoidId = null } = {}) {
  const { ct, iv, tag } = seal({ text, avoid_id: avoidId });
  const id = uuidv4();
  db._raw().prepare('INSERT INTO agent_activity (id, user_id, kind, event_id, ct, iv, tag) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, kind, eventId, ct, iv, tag);
  return id;
}

function listActivity(userId, { limit = 50, accessor = 'owner', context = 'activity view' } = {}) {
  const rows = db._raw().prepare('SELECT * FROM agent_activity WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(userId, limit);
  sensitive.logAccess(userId, accessor, 'agent_activity', 'read', context);
  return rows.map((r) => {
    const { text, avoid_id } = unseal(r);
    return { id: r.id, kind: r.kind, event_id: r.event_id, text, avoid_id, created_at: r.created_at };
  });
}

module.exports = {
  POLICIES, phoneKey,
  listAvoid, addAvoid, setPolicy, removeAvoid, findByPhone,
  recordActivity, listActivity,
};
