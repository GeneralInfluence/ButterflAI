/**
 * Apple Calendar (iCloud) integration via CalDAV.
 *
 * Apple does not offer a public OAuth API for Calendar.
 * Users generate an app-specific password at appleid.apple.com,
 * which we store encrypted (same KMS path as Google tokens).
 *
 * CalDAV endpoint: https://caldav.icloud.com
 * Auth: Basic auth with Apple ID email + app-specific password
 */

'use strict';

const { DAVClient } = require('tsdav');
const ICAL = require('ical.js');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const crypto = require('./crypto');

const CALDAV_URL = 'https://caldav.icloud.com';

// ── Token storage (reuse same encrypted pattern as Google) ──────────────────

async function saveAppleCredentials(userId, { appleId, appPassword }) {
  const plaintext = JSON.stringify({ appleId, appPassword });
  const encrypted = await crypto.encryptRecord({ appleId, appPassword });
  db._raw().prepare(`
    INSERT INTO calendar_tokens (user_id, provider, ciphertext, iv, tag, wrapped_key)
    VALUES (?, 'apple', ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      provider=excluded.provider, ciphertext=excluded.ciphertext,
      iv=excluded.iv, tag=excluded.tag, wrapped_key=excluded.wrapped_key,
      updated_at=strftime('%s','now')
  `).run(userId, encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.wrapped_key);
}

async function loadAppleCredentials(userId) {
  const row = db._raw().prepare(
    "SELECT * FROM calendar_tokens WHERE user_id = ? AND provider = 'apple'"
  ).get(userId);
  if (!row) return null;
  return await crypto.decryptRecord({
    ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, wrapped_key: row.wrapped_key,
  });
}

function hasAppleCalendarConnected(userId) {
  return !!db._raw().prepare(
    "SELECT 1 FROM calendar_tokens WHERE user_id = ? AND provider = 'apple'"
  ).get(userId);
}

// ── DAV client factory ──────────────────────────────────────────────────────

async function getDAVClient(userId) {
  const creds = await loadAppleCredentials(userId);
  if (!creds) return null;
  const client = new DAVClient({
    serverUrl: CALDAV_URL,
    credentials: { username: creds.appleId, password: creds.appPassword },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
  await client.login();
  return client;
}

// ── Calendar operations ────────────────────────────────────────────────────

/**
 * Check availability for a user across proposed time slots.
 * Returns which slots are free.
 */
async function checkAvailability(userId, slots, timezone = 'America/Los_Angeles') {
  const client = await getDAVClient(userId);
  if (!client) throw new Error('Apple Calendar not connected');

  const calendars = await client.fetchCalendars();
  const primary = calendars.find(c => c.displayName !== 'Birthdays') || calendars[0];
  if (!primary) return slots.map(s => ({ ...s, free: true }));

  // Fetch events for the date range
  const allStarts = slots.map(s => new Date(s.start));
  const rangeStart = new Date(Math.min(...allStarts));
  const rangeEnd = new Date(Math.max(...slots.map(s => new Date(s.end))));

  const objects = await client.fetchCalendarObjects({
    calendar: primary,
    timeRange: { start: rangeStart.toISOString(), end: rangeEnd.toISOString() },
  });

  const results = slots.map(slot => {
    const slotStart = new Date(slot.start).getTime();
    const slotEnd = new Date(slot.end).getTime();
    const conflict = objects.some(obj => {
      try {
        const jcal = ICAL.parse(obj.data);
        const comp = new ICAL.Component(jcal);
        const vevent = comp.getFirstSubcomponent('vevent');
        if (!vevent) return false;
        const ev = new ICAL.Event(vevent);
        const start = ev.startDate.toJSDate().getTime();
        const end = ev.endDate.toJSDate().getTime();
        return start < slotEnd && end > slotStart;
      } catch { return false; }
    });
    return { ...slot, free: !conflict };
  });

  return results;
}

/**
 * Create a calendar event on the user's primary iCloud calendar.
 */
async function createEvent(userId, { summary, description, start, end }) {
  const client = await getDAVClient(userId);
  if (!client) throw new Error('Apple Calendar not connected');

  const calendars = await client.fetchCalendars();
  const primary = calendars.find(c => c.displayName !== 'Birthdays' && !c.readOnly) || calendars[0];
  if (!primary) throw new Error('No writable calendar found');

  const uid = uuidv4();
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const startDt = new Date(start.dateTime || start).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const endDt   = new Date(end.dateTime   || end  ).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  const icsData = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ButterflAI//EN',
    'BEGIN:VEVENT',
    `UID:${uid}@butterflai`,
    `DTSTAMP:${now}`,
    `DTSTART:${startDt}`,
    `DTEND:${endDt}`,
    `SUMMARY:${summary}`,
    description ? `DESCRIPTION:${description}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');

  await client.createCalendarObject({
    calendar: primary,
    filename: `${uid}.ics`,
    iCalString: icsData,
  });

  console.log(`[calendar-apple] event created user=${userId} uid=${uid}`);
  return { id: uid, summary };
}

/**
 * Get the user's primary timezone from their iCloud calendar.
 */
async function getCalendarTimezone(userId) {
  const client = await getDAVClient(userId);
  if (!client) return null;
  const calendars = await client.fetchCalendars();
  const primary = calendars[0];
  return primary?.timezone || null;
}

module.exports = {
  saveAppleCredentials,
  hasAppleCalendarConnected,
  checkAvailability,
  createEvent,
  getCalendarTimezone,
};
