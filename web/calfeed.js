/**
 * Your plans as a calendar you subscribe to — no password (owner, 2026-10-23: "It would be nice if there was some
 * integrated way to do that rather than making them remember something none of my friends have been able to remember").
 * One tap on the iPhone (webcal://…) → Subscribe; Google Calendar takes the same link ("From URL"). The calendar app
 * fetches it every hour or so. Shows exactly what the calendar mirror shows (calmirror.desired: name, dates, place,
 * "You're hosting" / "With <host>", a link) — nothing else. Anyone with the link can read it, so it's random, private to
 * them, and can be turned off or replaced. Read-only: ButterflAI can't see their calendar this way (that needs Google or
 * iCloud connected).
 */
'use strict';

const crypto = require('crypto');
const db = require('./db');

function linkFor(userId, { create = false } = {}) {
  let t = db.getUser(userId)?.cal_feed_token;
  if (!t && create) { t = crypto.randomBytes(24).toString('hex'); db._raw().prepare('UPDATE users SET cal_feed_token = ? WHERE id = ?').run(t, userId); }
  if (!t) return null;
  const host = String(process.env.BASE_URL || 'https://butterflai.social').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return { webcal: `webcal://${host}/cal/${t}.ics`, https: `https://${host}/cal/${t}.ics` };
}
function off(userId) { db._raw().prepare('UPDATE users SET cal_feed_token = NULL WHERE id = ?').run(userId); }

/** The calendar for a feed token, or null. */
function feed(token) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ''))) return null;
  const u = db._raw().prepare('SELECT id FROM users WHERE cal_feed_token = ?').get(token);
  if (!u) return null;
  const { toIcs } = require('./calendar-apple');
  const calmirror = require('./calmirror');
  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const events = [];
  for (const p of require('./plan').plansFor(u.id, { includePast: true })) {
    if (p.stage === 'past' && (p.dates?.end || 0) < since) continue;
    for (const e of calmirror.desired(u.id, p.id)) {
      const ics = toIcs(`${p.id}-${e.key}@butterflai`, e.body).split('\r\n');
      events.push(...ics.slice(ics.indexOf('BEGIN:VEVENT'), ics.indexOf('END:VEVENT') + 1));
    }
  }
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ButterflAI//Plans//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:ButterflAI plans', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H', ...events, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

module.exports = { linkFor, off, feed };
