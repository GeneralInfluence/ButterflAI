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
 * state = userId
 */
function getGoogleContactsAuthUrl(userId) {
  const { google } = require('googleapis');
  const client = makeGooglePeopleClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/contacts.readonly'],
    state: `contacts:${userId}`,
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
async function importFromGoogle(userId, googleTokens) {
  const client = makeGooglePeopleClient();
  client.setCredentials(googleTokens);

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

      if (!name || phones.length === 0) { skipped++; continue; }

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

  // Create an invite token
  const token = uuidv4().replace(/-/g, '');
  db.createInvite({ token, created_by_user_id: userId, contact_name: contact.name });

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
  sendInvite,
  getImportableContacts,
  getActiveContacts,
};
