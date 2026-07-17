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

  // Resolve the user's real calendar timezone. ALL wall-clock reasoning below happens in
  // it, not the server's zone — Fly/Docker default to UTC, so "8am" was being built as
  // 08:00 UTC (= midnight PDT), producing free slots at the wrong hour for the user.
  const tz = (await getCalendarTimezone(userId)) || 'America/Los_Angeles';

  // Time-of-day windows, as wall-clock HOURS in the user's timezone.
  const timeWindows = {
    morning:   { start: 8,  end: 12 },
    lunch:     { start: 11, end: 14 },
    afternoon: { start: 13, end: 18 },
    evening:   { start: 17, end: 22 },
  };
  const window = timeWindows[preferred_time] || { start: 9, end: 21 };

  const nowMs = now.getTime();
  const endMs = end.getTime();
  const durMs = duration_mins * 60 * 1000;
  const today = _tzParts(nowMs, tz); // today's date, in the user's zone
  const freeSlots = [];

  for (let dayOffset = 0; dayOffset < search_days && freeSlots.length < count; dayOffset++) {
    // Anchor at noon to read this day's Y/M/D in-zone without DST edge issues.
    const dayAnchor = _wallToUtcMs(today.year, today.month, today.day, 12, 0, tz) + dayOffset * 86400000;
    const dp = _tzParts(dayAnchor, tz);

    let h = window.start;
    while (h * 60 + duration_mins <= window.end * 60 && freeSlots.length < count) {
      const slotStartMs = _wallToUtcMs(dp.year, dp.month, dp.day, h, 0, tz);
      const slotEndMs   = slotStartMs + durMs;
      if (slotStartMs < nowMs || slotEndMs > endMs) { h += 1; continue; }

      const sIso = new Date(slotStartMs).toISOString();
      const eIso = new Date(slotEndMs).toISOString();
      const conflict = busy.some(b => b.start < eIso && b.end > sIso);
      if (!conflict) {
        freeSlots.push({ start: sIso, end: eIso, label: formatSlotLabel(slotStartMs, tz) });
        h += Math.max(1, Math.ceil(duration_mins / 60)); // non-overlapping suggestions
      } else {
        h += 1;
      }
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

// ── Timezone helpers (DST-aware wall-clock <-> UTC, no external deps) ──────────

// Wall-clock parts of an instant, as seen in IANA `tz`.
function _tzParts(instantMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(instantMs))) p[part.type] = part.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
}

// Offset (ms) = tz wall time minus UTC, at the given instant.
function _tzOffsetMs(instantMs, tz) {
  const p = _tzParts(instantMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instantMs;
}

// The UTC instant (ms) whose wall clock in `tz` is (year, month[1-12], day, hour, minute).
// Two-pass correction resolves DST transitions (offset differs before/after the jump).
function _wallToUtcMs(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const off1  = _tzOffsetMs(guess, tz);
  let t = guess - off1;
  const off2 = _tzOffsetMs(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

function formatSlotLabel(instant, tz = 'America/Los_Angeles') {
  const d = instant instanceof Date ? instant : new Date(instant);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', hour12: true,
  }).formatToParts(d);
  const g = t => (parts.find(p => p.type === t) || {}).value || '';
  return `${g('weekday')} ${g('month')} ${g('day')} at ${g('hour')}${g('dayPeriod').toLowerCase()}`;
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

// ── Unified calendar interface (Google + Apple) ──────────────────────────────

const apple = require('./calendar-apple');

/**
 * Returns 'google', 'apple', or null.
 */
function getCalendarProvider(userId) {
  const hasGoogle = hasCalendarConnected(userId);
  const hasApple  = apple.hasAppleCalendarConnected(userId);
  if (hasGoogle) return 'google';
  if (hasApple)  return 'apple';
  return null;
}

/**
 * Create a calendar event on whichever backend is connected.
 */
async function createEventUnified(userId, eventData) {
  const provider = getCalendarProvider(userId);
  if (provider === 'google') return createEvent(userId, eventData);
  if (provider === 'apple')  return apple.createEvent(userId, eventData);
  throw new Error('No calendar connected');
}

/**
 * Check availability on whichever backend is connected.
 */
async function checkAvailabilityUnified(userId, slots, timezone) {
  const provider = getCalendarProvider(userId);
  if (provider === 'google') return checkAvailability(userId, slots, timezone);
  if (provider === 'apple')  return apple.checkAvailability(userId, slots, timezone);
  throw new Error('No calendar connected');
}

/**
 * Get timezone from whichever backend is connected.
 */
async function getCalendarTimezoneUnified(userId) {
  const provider = getCalendarProvider(userId);
  if (provider === 'google') return getCalendarTimezone(userId);
  if (provider === 'apple')  return apple.getCalendarTimezone(userId);
  return null;
}

/**
 * Is ANY calendar connected (Google or Apple)?
 */
function hasAnyCalendarConnected(userId) {
  return hasCalendarConnected(userId) || apple.hasAppleCalendarConnected(userId);
}

module.exports = {
  // Google-specific
  getAuthUrl,
  handleOAuthCallback,
  hasCalendarConnected,
  // Apple-specific
  saveAppleCredentials: apple.saveAppleCredentials,
  hasAppleCalendarConnected: apple.hasAppleCalendarConnected,
  // Unified interface (use these in agent.js)
  getCalendarProvider,
  createEvent: createEventUnified,
  checkAvailability: checkAvailabilityUnified,
  findFreeSlots,
  getCalendarTimezone: getCalendarTimezoneUnified,
  hasAnyCalendarConnected,
  // Exposed for tests
  _wallToUtcMs,
  _tzParts,
  formatSlotLabel,
};
