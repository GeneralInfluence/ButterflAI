/**
 * ButterflAI contact ingestion (§5.5 IMPLEMENTATION.md)
 *
 * THE TWO-GATE RULE — this is the entire safety model, do not collapse it:
 *   Gate 1: Ingest ≠ consent to contact.
 *     Importing builds a *private, user-only* list of "people you could invite."
 *     It does NOT authorize messaging anyone. All imported contacts start at Tier 0.
 *   Gate 2: Per-contact invite gate.
 *     A contact is messaged ONLY when the user affirmatively selects that specific
 *     person for an invite. No bulk-blasting.
 *
 * Sources:
 *   - Manual entry (name + phone from user)
 *   - Google People API (OAuth — same flow as calendar, separate scope)
 *   - vCard upload (future)
 *
 * Ingested contacts:
 *   - Stored per-user, not exposed to other users
 *   - Carry `imported_from` provenance tag
 *   - Start at tier=0 (no contact authorization)
 *   - Show up in the user's "people you could invite" list
 *   - Are promoted to tier=1/2 only when user explicitly chooses to invite them
 */

'use strict';

const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// ── Table augmentation ────────────────────────────────────────────────────────

function ensureImportColumns() {
  // Add imported_from and import_source if they don't exist
  try { db._raw().exec(`ALTER TABLE contacts ADD COLUMN imported_from TEXT`); } catch (_) {}
  try { db._raw().exec(`ALTER TABLE contacts ADD COLUMN import_source TEXT`); } catch (_) {}
  // imported_from: 'manual' | 'google_contacts' | 'vcard'
  // import_source: raw source identifier (e.g. google account email)
}

// ── Manual entry ──────────────────────────────────────────────────────────────

/**
 * Manually add a contact to the user's importable list.
 * Does NOT send any message. Does NOT change the contact's tier from 0.
 *
 * @param {string} userId
 * @param {object} contact  { name, phone }
 * @returns {string} contactId
 */
function addManualContact(userId, { name, phone }) {
  if (!name) throw new Error('name is required');

  // Check if we already have this phone under this user
  if (phone) {
    const existing = db._raw()
      .prepare('SELECT * FROM contacts WHERE invited_by_user_id = ? AND phone = ?')
      .get(userId, phone);
    if (existing) return existing.id;
  }

  const contactId = uuidv4();
  db.createContact({
    id: contactId,
    invited_by_user_id: userId,
    name,
    phone: phone || null,
    tier: 0,
  });
  db._raw()
    .prepare(`UPDATE contacts SET imported_from='manual', import_source='user_entry' WHERE id=?`)
    .run(contactId);

  return contactId;
}

// ── Google Contacts import ────────────────────────────────────────────────────

/**
 * Google People API OAuth URL (separate scope from calendar).
 * state = signed linktoken
 */
// `state` is a signed linktoken (purpose 'oauth:gcontacts'), not a bare userId (2026-10-09).
function getGoogleContactsAuthUrl(state) {
  const { google } = require('googleapis');
  const client = makeGooglePeopleClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/contacts.readonly'],
    state,
  });
}

function makeGooglePeopleClient() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI ||
                       `${process.env.BASE_URL || 'http://localhost:3000'}/auth/google/callback`;
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID/SECRET not set');
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Import contacts from Google People API.
 * Ingests all contacts with a phone number as Tier 0.
 * Skips duplicates (same user + phone).
 *
 * @param {string} userId
 * @param {object} googleTokens  - OAuth tokens from callback
 * @returns {{ imported: number, skipped: number }}
 */
async function importFromGoogle(userId, googleTokens, { onTokens } = {}) {
  const client = makeGooglePeopleClient();
  client.setCredentials(googleTokens);
  if (onTokens) client.on('tokens', onTokens);   // refreshed access token → keep it

  const people = google.people({ version: 'v1', auth: client });

  let imported = 0;
  let skipped = 0;
  let nextPageToken;

  do {
    const resp = await people.people.connections.list({
      resourceName: 'people/me',
      pageSize: 200,
      personFields: 'names,phoneNumbers',
      pageToken: nextPageToken,
    });

    for (const person of resp.data.connections || []) {
      const name = person.names?.[0]?.displayName;
      const phones = person.phoneNumbers || [];

      if (!name) { skipped++; continue; }
      // No phone number: still keep the name, so the agent can find them and ask for
      // the number (it used to drop them — 2026-10-09). One row per name.
      if (phones.length === 0) {
        const have = db._raw().prepare('SELECT 1 FROM contacts WHERE invited_by_user_id = ? AND lower(name) = lower(?)').get(userId, name);
        if (have) { skipped++; continue; }
        const id = uuidv4();
        db.createContact({ id, invited_by_user_id: userId, name, phone: null, tier: 0 });
        db._raw().prepare(`UPDATE contacts SET imported_from='google_contacts', import_source='google' WHERE id = ?`).run(id);
        imported++;
        continue;
      }

      for (const phoneObj of phones) {
        const phone = normalisePhone(phoneObj.value);
        if (!phone) { skipped++; continue; }

        // Two-gate rule: check if already exists under this user
        const exists = db._raw()
          .prepare('SELECT 1 FROM contacts WHERE invited_by_user_id = ? AND phone = ?')
          .get(userId, phone);

        if (exists) { skipped++; continue; }

        const contactId = uuidv4();
        db.createContact({ id: contactId, invited_by_user_id: userId, name, phone, tier: 0 });
        db._raw()
          .prepare(`UPDATE contacts SET imported_from='google_contacts', import_source='google' WHERE id=?`)
          .run(contactId);
        imported++;
      }
    }

    nextPageToken = resp.data.nextPageToken;
  } while (nextPageToken);

  console.log(`[contacts-import] user=${userId} imported=${imported} skipped=${skipped}`);
  return { imported, skipped };
}

// ── Ongoing sync ─────────────────────────────────────────────────────────────
// The Google grant is kept (encrypted, every read audited — crypto.js) so contacts added
// later show up: daily, and right away when a lookup finds no match (2026-10-09: Sean's
// friend Alex wasn't found; his contacts were last imported in June, once).

const crypto = require('./crypto');
const SYNC_MIN_GAP = 10 * 60;   // on-demand syncs at most every 10 minutes

async function saveGoogleTokens(userId, tokens) {
  const old = await loadGoogleTokens(userId).catch(() => null);
  const merged = { ...(old || {}), ...tokens };
  if (!tokens.refresh_token && old?.refresh_token) merged.refresh_token = old.refresh_token;
  const e = await crypto.encryptRecord(merged);
  db._raw().prepare(`
    INSERT INTO contact_sync_tokens (user_id, provider, ciphertext, iv, tag, wrapped_key)
    VALUES (?, 'google', ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
      wrapped_key = excluded.wrapped_key, updated_at = strftime('%s','now')
  `).run(userId, e.ciphertext, e.iv, e.tag, e.wrapped_key);
}

async function loadGoogleTokens(userId) {
  const row = db._raw().prepare('SELECT * FROM contact_sync_tokens WHERE user_id = ?').get(userId);
  if (!row) return null;
  return crypto.decryptRecord(row, userId, 'agent_reasoning', 'contacts_sync', 'contact_sync_tokens', db);
}

function syncStatus(userId) {
  const row = db._raw().prepare('SELECT last_sync_at FROM contact_sync_tokens WHERE user_id = ?').get(userId);
  const lastImport = db._raw().prepare("SELECT max(created_at) t FROM contacts WHERE invited_by_user_id = ? AND import_source = 'google'").get(userId)?.t;
  return { connected: !!row, last_sync_at: row?.last_sync_at || null, last_import_at: lastImport || null };
}

/** Re-import from Google. `force` skips the 10-minute gap. Never throws. */
async function syncGoogle(userId, { force = false } = {}) {
  try {
    const row = db._raw().prepare('SELECT last_sync_at FROM contact_sync_tokens WHERE user_id = ?').get(userId);
    if (!row) return { synced: false, reason: 'not_connected' };
    if (!force && row.last_sync_at && row.last_sync_at > Math.floor(Date.now() / 1000) - SYNC_MIN_GAP) return { synced: false, reason: 'recent' };
    const tokens = await loadGoogleTokens(userId);
    const result = await importFromGoogle(userId, tokens, { onTokens: (t) => saveGoogleTokens(userId, t).catch(() => {}) });
    db._raw().prepare("UPDATE contact_sync_tokens SET last_sync_at = strftime('%s','now') WHERE user_id = ?").run(userId);
    return { synced: true, imported: result.imported };
  } catch (err) {
    console.error(`[contacts-import] sync failed user=${userId}:`, err.message);
    return { synced: false, reason: 'error', error: err.message };
  }
}

/** Daily sync for everyone connected (staggered; runs every 6h, syncs if >24h old). */
function startSyncLoop(intervalMs = 6 * 3600 * 1000) {
  const run = async () => {
    const due = db._raw().prepare("SELECT user_id FROM contact_sync_tokens WHERE COALESCE(last_sync_at, 0) < strftime('%s','now') - 86400").all();
    for (const { user_id } of due) await syncGoogle(user_id, { force: true });
  };
  return setInterval(() => run().catch((err) => console.error('[contacts-import] sync loop:', err.message)), intervalMs);
}

// ── Invite gate ───────────────────────────────────────────────────────────────

/**
 * Promote a Tier 0 contact to Tier 1 by sending them an invite SMS.
 * This is Gate 2 — the user has affirmatively selected this specific person.
 *
 * Sends the self-identify + STOP + portal link message.
 * Does NOT upgrade the contact's tier until they accept via the invite page.
 *
 * @param {string} userId      - The user initiating the invite
 * @param {string} contactId   - The contact to invite (must be Tier 0)
 * @param {string} context     - Brief context e.g. "quarterly lunch"
 * @returns {{ token: string, url: string }}
 */
async function sendInvite(userId, contactId, context) {
  const sms = require('./sms');

  const user = db.getUser(userId);
  const contact = db.getContact(contactId);

  if (!contact) throw new Error('Contact not found');
  if (!contact.phone) throw new Error('Contact has no phone number');
  if (db.isOptedOut(contact.phone)) throw new Error('Contact has opted out');
  if (contact.invited_by_user_id !== userId) throw new Error('Unauthorized');
  // send_contact_invite is only for Tier 0 (not yet connected) contacts.
  // If the contact is already Tier 1+, the agent should use create_social_event instead.
  if ((contact.tier ?? 0) >= 1) {
    throw new Error(
      `Contact "${contact.name}" is already Tier ${contact.tier} (connected). ` +
      `Use create_social_event to invite them to an activity, not send_contact_invite.`
    );
  }

  // Anti-spam: one invite per person per 30 days.
  const recent = db._raw().prepare(`SELECT 1 FROM invites WHERE created_by_user_id = ? AND contact_id = ?
    AND created_at > strftime('%s','now') - 30 * 86400`).get(userId, contactId);
  if (recent) throw new Error(`Already invited ${contact.name} in the last 30 days — don't send another.`);

  // Create an invite token
  const token = uuidv4().replace(/-/g, '');
  db.createInvite({ token, created_by_user_id: userId, contact_name: contact.name, contact_id: contactId });

  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const inviteUrl = `${baseUrl}/invite/${token}`;
  const portalUrl = `${baseUrl}/contact/${token}`;

  // Gate 2: send invite with mandatory self-identify + STOP + portal link
  await sms.sendContactInvite(
    contact.phone,
    contact.name,
    user.name,
    context,
    `Set up your own ButterflAI: ${inviteUrl}`,
    portalUrl
  );

  console.log(`[contacts-import] invite sent user=${userId} contact=${contactId} token=${token}`);
  return { token, url: inviteUrl };
}

// ── User's importable list ────────────────────────────────────────────────────

/**
 * Get all Tier 0 contacts for a user — their "people you could invite" list.
 * These have been ingested but not yet invited.
 */
function getImportableContacts(userId) {
  return db._raw()
    .prepare(`
      SELECT c.*, i.status as invite_status, i.token as invite_token
      FROM contacts c
      LEFT JOIN invites i ON i.created_by_user_id = ? AND i.contact_id = c.id
      WHERE c.invited_by_user_id = ? AND c.tier = 0 AND c.opted_out_at IS NULL
      ORDER BY c.name
    `)
    .all(userId, userId);
}

/**
 * Get all active (Tier 1+) contacts for a user.
 */
function getActiveContacts(userId) {
  return db._raw()
    .prepare(`
      SELECT c.*, cp.availability_notes, cp.dietary, cp.neighborhoods, cp.comm_preference
      FROM contacts c
      LEFT JOIN contact_preferences cp ON cp.contact_id = c.id
      WHERE c.invited_by_user_id = ? AND c.tier > 0
      ORDER BY c.name
    `)
    .all(userId, userId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalisePhone(raw) {
  if (!raw) return null;
  let s = raw.replace(/[\s\-\(\)\.]/g, '');
  if (!s.startsWith('+')) {
    // Assume US if no country code and 10 digits
    if (s.length === 10) s = '+1' + s;
    else return null; // can't reliably normalise
  }
  return s.length >= 8 ? s : null;
}

// ── Init ──────────────────────────────────────────────────────────────────────

ensureImportColumns();

module.exports = {
  addManualContact,
  getGoogleContactsAuthUrl,
  importFromGoogle,
  saveGoogleTokens,
  syncGoogle,
  syncStatus,
  startSyncLoop,
  sendInvite,
  getImportableContacts,
  getActiveContacts,
};
