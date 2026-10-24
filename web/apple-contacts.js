/**
 * iCloud Contacts (🐛 #90 — Melanie: "I wanna be able to connect my Apple contacts list through my iCloud"). The same
 * app-specific password as Apple Calendar reads contacts over CardDAV (contacts.icloud.com). One Apple connection, like
 * Google's: connecting Apple brings calendar and contacts. Kept in sync daily, and when a name isn't found (like Google).
 * People without a number are kept by name (so the agent can find them and ask). Never writes to iCloud.
 */
'use strict';

const { DAVClient } = require('tsdav');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const crypto = require('./crypto');

const CARDDAV_URL = 'https://contacts.icloud.com';
let _client = null;   // tests: a fake DAV client
function _setClient(c) { _client = c; }

async function save(userId, { appleId, appPassword }) {
  const e = await crypto.encryptRecord({ appleId, appPassword });
  db._raw().prepare(`INSERT INTO apple_contacts (user_id, ciphertext, iv, tag, wrapped_key) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, wrapped_key = excluded.wrapped_key`)
    .run(userId, e.ciphertext, e.iv, e.tag, e.wrapped_key);
}
function connected(userId) { return db._raw().prepare('SELECT last_sync_at FROM apple_contacts WHERE user_id = ?').get(userId) || null; }

async function client(userId) {
  if (_client) return _client;
  if (process.env.NODE_ENV === 'test') return null;   // tests never reach iCloud
  const row = db._raw().prepare('SELECT * FROM apple_contacts WHERE user_id = ?').get(userId);
  if (!row) return null;
  const creds = await crypto.decryptRecord(row, userId, 'agent_reasoning', 'contacts_sync', 'apple_contacts', db);
  const c = new DAVClient({ serverUrl: CARDDAV_URL, credentials: { username: creds.appleId, password: creds.appPassword }, authMethod: 'Basic', defaultAccountType: 'carddav' });
  await c.login();
  return c;
}

/** The people in a vCard: { name, phones[] }. */
function parseVCard(text) {
  const lines = String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  let name = null; const phones = [];
  for (const l of lines) {
    const [k, ...v] = l.split(':'); const val = v.join(':').trim();
    const key = k.split(';')[0].replace(/^item\d+\./i, '').toUpperCase();
    if (key === 'FN' && val) name = val.replace(/\\,/g, ',');
    else if (key === 'N' && !name && val) { const [last, first] = val.split(';'); name = [first, last].filter(Boolean).join(' ').trim() || null; }
    else if (key === 'TEL' && val) phones.push(val);
  }
  return { name, phones };
}

/** Bring their iCloud contacts in. Returns { imported, skipped }. Throws on a login failure. */
async function importAll(userId) {
  const { addImported } = require('./contacts-import');
  const c = await client(userId);
  if (!c) return { imported: 0, skipped: 0 };
  let imported = 0, skipped = 0;
  for (const book of await c.fetchAddressBooks()) {
    for (const card of await c.fetchVCards({ addressBook: book })) {
      const { name, phones } = parseVCard(card.data);
      const r = addImported(userId, name, phones, 'apple');
      imported += r.imported; skipped += r.skipped;
    }
  }
  return { imported, skipped };
}

/** Sync now (never throws). force skips the 10-minute gap. */
async function sync(userId, { force = false } = {}) {
  const row = connected(userId);
  if (!row) return { synced: false, reason: 'not_connected' };
  if (!force && row.last_sync_at && row.last_sync_at > Math.floor(Date.now() / 1000) - 600) return { synced: false, reason: 'recent' };
  try {
    const r = await importAll(userId);
    db._raw().prepare("UPDATE apple_contacts SET last_sync_at = strftime('%s','now') WHERE user_id = ?").run(userId);
    require('./connections').ok(userId, 'apple');
    return { synced: true, imported: r.imported };
  } catch (err) {
    console.error(`[apple-contacts] sync failed user=${userId}:`, err.message);
    require('./connections').report(userId, 'apple', err);
    return { synced: false, reason: 'error', error: err.message };
  }
}

module.exports = { save, connected, sync, importAll, parseVCard, _setClient };
