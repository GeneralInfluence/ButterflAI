/**
 * ButterflAI calendar integration (§1.6 IMPLEMENTATION.md)
 *
 * Google Calendar first; designed behind a provider interface so other
 * providers (Outlook, Apple) slot in without touching the calling code.
 *
 * Capabilities:
 *  - OAuth2 flow: generate auth URL, exchange code for tokens, store encrypted
 *  - Read: check real availability for a user in a time window
 *  - Write: create an event on the user's calendar
 *
 * Out of scope for v1 (per spec):
 *  - Race condition detection / re-check after booking
 *  - Multi-calendar merging
 *  - Sending a formal calendar invite to the other party
 *
 * Token storage:
 *  - OAuth tokens are encrypted at rest using the same AES-256-GCM / KMS
 *    system as private data (crypto.js). Stored in calendar_tokens table.
 */

'use strict';

const { google } = require('googleapis');
const crypto = require('./crypto');
const db = require('./db');

// ── Table setup ───────────────────────────────────────────────────────────────

function ensureCalendarTable() {
  db._raw().exec(`
    CREATE TABLE IF NOT EXISTS calendar_tokens (
      user_id    TEXT PRIMARY KEY REFERENCES users(id),
      provider   TEXT NOT NULL DEFAULT 'google',
      ciphertext TEXT NOT NULL,
      iv         TEXT NOT NULL,
      tag        TEXT NOT NULL,
      wrapped_key TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);
}

// ── Google OAuth client factory ───────────────────────────────────────────────

function makeGoogleClient() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI ||
                       `${process.env.BASE_URL || 'http://localhost:3000'}/auth/google/callback`;

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// ── OAuth flow ────────────────────────────────────────────────────────────────

/**
 * Generate the Google OAuth URL to redirect the user to.
 * state = userId (used to match the callback to a user).
 */
function getAuthUrl(userId) {
  const client = makeGoogleClient();
  return client.generateAuthUrl({
    access_type: 'offline',       // gets a refresh token
    prompt: 'consent',            // always show consent screen to force refresh token
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    state: userId,
  });
}

/**
 * Exchange an auth code for tokens, encrypt, and persist.
 * Called from the /auth/google/callback route.
 */
async function handleOAuthCallback(code, userId) {
  const client = makeGoogleClient();
  const { tokens } = await client.getToken(code);

  // Encrypt before storing
  const encrypted = await crypto.encryptRecord(tokens);
  db._raw().prepare(`
    INSERT INTO calendar_tokens (user_id, provider, ciphertext, iv, tag, wrapped_key)
    VALUES (?, 'google', ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      tag = excluded.tag,
      wrapped_key = excluded.wrapped_key,
      updated_at = strftime('%s','now')
  `).run(userId, encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.wrapped_key);

  console.log(`[calendar] OAuth tokens stored for user=${userId}`);
}

/**
 * Load and decrypt a user's stored OAuth tokens.
 * Returns null if no tokens on file.
 */
async function loadTokens(userId) {
  const row = db._raw()
    .prepare('SELECT * FROM calendar_tokens WHERE user_id = ?')
    .get(userId);
  if (!row) return null;
  return crypto.decryptRecord(row, userId, 'agent_reasoning', 'calendar_token_load', 'calendar_tokens', db);
}

/**
 * Get an authenticated Google auth client for a user.
 * Handles token refresh automatically; re-encrypts if tokens changed.
 */
async function getAuthClient(userId) {
  const tokens = await loadTokens(userId);
  if (!tokens) return null;

  const client = makeGoogleClient();
  client.setCredentials(tokens);

  // Auto-refresh: Google client fires 'tokens' event when it refreshes
  client.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    const encrypted = await crypto.encryptRecord(merged);
    db._raw().prepare(`
      UPDATE calendar_tokens SET ciphertext=?, iv=?, tag=?, wrapped_key=?, updated_at=strftime('%s','now')
      WHERE user_id=?
    `).run(encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.wrapped_key, userId);
  });

  return client;
}

// ── Availability check ────────────────────────────────────────────────────────

/**
 * Check whether a user is free during a set of proposed time slots.
 *
 * @param {string} userId
 * @param {Array<{start: string, end: string}>} slots  - ISO 8601 strings
 * @returns {Array<{slot, free: boolean, conflicts: string[]}>}
 */
async function checkAvailability(userId, slots) {
  const authClient = await getAuthClient(userId);
  if (!authClient) {
    return slots.map(slot => ({ slot, free: null, error: 'no_calendar_connected' }));
  }

  const cal = google.calendar({ version: 'v3', auth: authClient });

  // Use freebusy query — more efficient than listing events
  const timeMin = slots.reduce((min, s) => s.start < min ? s.start : min, slots[0].start);
  const timeMax = slots.reduce((max, s) => s.end > max ? s.end : max, slots[0].end);

  const resp = await cal.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: [{ id: 'primary' }],
    },
  });

  const busyPeriods = resp.data.calendars?.primary?.busy || [];

  return slots.map(slot => {
    const conflicts = busyPeriods.filter(b =>
      b.start < slot.end && b.end > slot.start
    );
    return {
      slot,
      free: conflicts.length === 0,
      conflicts: conflicts.map(c => `${c.start}–${c.end}`),
    };
  });
}

/**
 * Find the next N free windows of a given duration within a search range.
 *
 * @param {string} userId
 * @param {object} opts
 *   duration_mins  - how long the slot needs to be
 *   search_days    - how many days to look ahead (default 21)
 *   count          - how many free slots to return (default 3)
 *   preferred_time - 'morning' | 'lunch' | 'afternoon' | 'evening' (optional)
 */
async function findFreeSlots(userId, { duration_mins = 90, search_days = 21, count = 3, preferred_time } = {}) {
  const authClient = await getAuthClient(userId);
  if (!authClient) {
    return { error: 'no_calendar_connected', slots: [] };
  }

  const cal = google.calendar({ version: 'v3', auth: authClient });
  const now = new Date();
  const end = new Date(now.getTime() + search_days * 86400 * 1000);

  const resp = await cal.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      items: [{ id: 'primary' }],
    },
  });

  const busy = resp.data.calendars?.primary?.busy || [];

  // Time-of-day windows (local hour ranges)
  const timeWindows = {
    morning:   { start: 8,  end: 12 },
    lunch:     { start: 11, end: 14 },
    afternoon: { start: 13, end: 18 },
    evening:   { start: 17, end: 22 },
  };
  const window = timeWindows[preferred_time] || { start: 9, end: 21 };

  const freeSlots = [];
  const cursor = new Date(now);
  cursor.setMinutes(0, 0, 0);
  cursor.setHours(window.start);

  while (freeSlots.length < count && cursor < end) {
    const slotStart = new Date(cursor);
    const slotEnd = new Date(cursor.getTime() + duration_mins * 60 * 1000);

    // Skip if outside window
    if (cursor.getHours() < window.start || slotEnd.getHours() > window.end) {
      cursor.setHours(cursor.getHours() + 1);
      if (cursor.getHours() >= window.end) {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(window.start);
      }
      continue;
    }

    // Check against busy periods
    const conflict = busy.some(b => b.start < slotEnd.toISOString() && b.end > slotStart.toISOString());

    if (!conflict) {
      freeSlots.push({
        start: slotStart.toISOString(),
        end: slotEnd.toISOString(),
        label: formatSlotLabel(slotStart),
      });
      cursor.setTime(slotEnd.getTime()); // skip past this slot
    } else {
      cursor.setHours(cursor.getHours() + 1);
    }
  }

  return { slots: freeSlots };
}

// ── Event creation ────────────────────────────────────────────────────────────

/**
 * Create a calendar event for a user.
 *
 * @param {string} userId
 * @param {object} event
 *   title, start (ISO), end (ISO), description, location
 * @returns {string} eventId
 */
async function createEvent(userId, { title, start, end, description, location }) {
  const authClient = await getAuthClient(userId);
  if (!authClient) throw new Error('no_calendar_connected');

  const cal = google.calendar({ version: 'v3', auth: authClient });

  const resp = await cal.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: title,
      description: description || '',
      location: location || '',
      start: { dateTime: start, timeZone: 'UTC' },
      end: { dateTime: end, timeZone: 'UTC' },
    },
  });

  console.log(`[calendar] event created user=${userId} id=${resp.data.id}`);
  return resp.data.id;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSlotLabel(date) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = days[date.getDay()];
  const m = months[date.getMonth()];
  const day = date.getDate();
  const h = date.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 || 12;
  return `${d} ${m} ${day} at ${hour}${ampm}`;
}

function hasCalendarConnected(userId) {
  return !!db._raw()
    .prepare('SELECT 1 FROM calendar_tokens WHERE user_id = ?')
    .get(userId);
}

// ── Module init ───────────────────────────────────────────────────────────────

ensureCalendarTable();

/**
 * Fetch the user's timezone from their primary Google Calendar.
 * Returns an IANA timezone string (e.g. "America/Los_Angeles") or null.
 */
async function getCalendarTimezone(userId) {
  const client = await getAuthClient(userId);
  if (!client) return null;
  const { google } = require('googleapis');
  const cal = google.calendar({ version: 'v3', auth: client });
  const resp = await cal.calendars.get({ calendarId: 'primary' });
  return resp.data.timeZone || null;
}

module.exports = {
  getAuthUrl,
  handleOAuthCallback,
  checkAvailability,
  findFreeSlots,
  createEvent,
  hasCalendarConnected,
  getCalendarTimezone,
};
