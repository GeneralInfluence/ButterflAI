/**
 * calmirror.js — a person's calendar (Google or Apple) reflects their ButterflAI calendar.
 *
 * Owner, 2026-10-13. Every plan someone is in (hosting, invited, or said yes) is on their
 * Google Calendar the way ButterflAI shows it, and follows every change:
 *   set date      → one timed entry; tentative / not answered yet = "tentative" and free
 *   proposed dates → one all-day entry per option, "(proposed)", tentative and free
 *   date TBD / open invite → nothing (no day to put it on; ButterflAI lists it as undated)
 *   cancelled, declined, removed, hidden → removed
 *
 * The calendar ripple (ripples/reactions/calendar.js) marks people's rows dirty; flush()
 * writes them (right away, and retried from the coord loop). What to show is computed
 * from the plan object (plan.js) — the same thing the ButterflAI calendar reads.
 * Google or Apple (iCloud CalDAV) — whichever the person connected (one per person).
 * Off per person in Settings (users.gcal_mirror).
 */
'use strict';

const crypto = require('crypto');
const db = require('./db');
const plan = require('./plan');
const { LINKS } = require('./links');

const MAX_ATTEMPTS = 5;
let _override = null;   // tests inject { upsert(userId, gid, body, ctx), remove(userId, gid), connected(userId) }
/** The calendar this person connected: Google or Apple (one per person — calendar_tokens). */
function backend(userId) {
  if (_override) return _override;
  const cal = require('./calendar');
  const provider = cal.getCalendarProvider(userId);
  if (provider === 'google') return { provider, upsert: cal.googleUpsert, remove: cal.googleDelete, connected: () => true };
  if (provider === 'apple') {
    const apple = require('./calendar-apple');
    return { provider, upsert: apple.mirrorUpsert, remove: apple.mirrorDelete, connected: () => true };
  }
  return { provider: null, connected: () => false };
}
function _setGoogle(g) { _override = g ? { provider: 'test', ...g } : null; }   // name kept for existing tests

const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** Is this person's Google Calendar connected and mirrored? */
function isOn(userId) { const u = db.getUser(userId); return !!u && u.gcal_mirror !== 0 && backend(userId).connected(userId); }

/** What this person's Google Calendar should show for a plan: [{ key, body }]. */
function desired(userId, eventId) {
  const p = plan.planFor(eventId, userId);
  if (!p || p.stage === 'cancelled') return [];
  if (p.role === 'guest' && (!p.invitation || p.invitation.status === 'declined')) return [];
  const pending = p.role === 'guest' && p.invitation.status === 'invited';
  const firm = !p.tentative && !pending;
  const label = pending ? ' (invited)' : p.tentative ? ' (tentative)' : '';
  const common = {
    location: p.place || '',
    description: `${p.role === 'host' ? 'You’re hosting' : `With ${p.host.name}`} · from ButterflAI\n${LINKS.events}?event=${encodeURIComponent(p.id)}`,
    extendedProperties: { private: { butterflai_event: p.id } },
  };
  if (p.dates.kind === 'set' && p.dates.time_tbd) {   // day known, time not: an all-day entry
    return [{ key: `day:${p.dates.days[0]}`, body: { ...common, summary: p.title + label,
      start: { date: p.dates.days[0] }, end: { date: addDays(p.dates.days[0], 1) },
      status: firm ? 'confirmed' : 'tentative', transparency: 'transparent' } }];
  }
  if (p.dates.kind === 'set') {
    return [{ key: 'set', body: { ...common, summary: p.title + label,
      start: { dateTime: new Date(p.dates.start * 1000).toISOString() },
      end: { dateTime: new Date((p.dates.end + 60) * 1000).toISOString() },
      status: firm ? 'confirmed' : 'tentative', transparency: firm ? 'opaque' : 'transparent' } }];
  }
  if (p.dates.kind === 'proposed') {
    return p.dates.proposals.map((o) => ({ key: `proposed:${o.from}:${o.to}`, body: { ...common, summary: `${p.title} (proposed)`,
      start: { date: o.from }, end: { date: addDays(o.to, 1) }, status: 'tentative', transparency: 'transparent' } }));
  }
  return [];
}

const hashOf = (entries) => crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 32);
const parse = (s) => { try { return JSON.parse(s || '[]') || []; } catch (_) { return []; } };

/** Mark people's copies of a plan as needing a sync. */
function markDirty(eventId, userIds) {
  const st = db._raw().prepare(`INSERT INTO calendar_mirror (user_id, event_id, dirty, attempts) VALUES (?, ?, 1, 0)
    ON CONFLICT(user_id, event_id) DO UPDATE SET dirty = 1, attempts = 0, updated_at = strftime('%s','now')`);
  let n = 0;
  for (const id of new Set(userIds.filter(Boolean))) { st.run(id, eventId); n++; }
  return n;
}

/** Everyone whose calendar shows a plan: the host and every guest with ButterflAI. */
function peopleIn(eventId) {
  const e = db._raw().prepare('SELECT host_user_id FROM social_events WHERE id = ?').get(eventId);
  if (!e) return [];
  const guests = db._raw().prepare(`SELECT DISTINCT u.id FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
    JOIN users u ON u.phone = c.phone WHERE ei.event_id = ?`).all(eventId).map((r) => r.id);
  return [e.host_user_id, ...guests];
}

/** Every plan a person is in (for connecting, turning the mirror on/off, and the retro). */
function markAllFor(userId) {
  const ids = new Set([
    ...plan.plansFor(userId).map((p) => p.id),
    ...db._raw().prepare('SELECT event_id FROM calendar_mirror WHERE user_id = ?').all(userId).map((r) => r.event_id),
  ]);
  for (const id of ids) markDirty(id, [userId]);
  return ids.size;
}

async function syncRow(row) {
  const g = backend(row.user_id);
  const user = db.getUser(row.user_id);
  // Entries written to a calendar this person has since disconnected can't be reached;
  // they're forgotten, and the connected calendar gets fresh ones.
  const have = parse(row.entries).filter((h) => !h.provider || h.provider === g.provider);
  const on = !!user && user.gcal_mirror !== 0 && g.connected(row.user_id);
  if (!on && !have.length) {           // nothing there, nothing to write
    db._raw().prepare('UPDATE calendar_mirror SET dirty = 0, last_error = NULL WHERE user_id = ? AND event_id = ?').run(row.user_id, row.event_id);
    return 'skipped';
  }
  const want = on ? desired(row.user_id, row.event_id) : [];
  const hash = hashOf(want);
  if (hash === row.hash && have.length === want.length) {
    db._raw().prepare('UPDATE calendar_mirror SET dirty = 0, last_error = NULL WHERE user_id = ? AND event_id = ?').run(row.user_id, row.event_id);
    return 'unchanged';
  }
  const next = [];
  for (const w of want) {
    const old = have.find((h) => h.key === w.key);
    next.push({ key: w.key, provider: g.provider, gid: await g.upsert(row.user_id, old?.gid || null, w.body,
      { uid: `butterflai-${row.event_id}-${w.key}` }) });
  }
  for (const h of have) if (!want.some((w) => w.key === h.key)) await g.remove(row.user_id, h.gid);
  db._raw().prepare(`UPDATE calendar_mirror SET entries = ?, hash = ?, dirty = 0, attempts = 0, last_error = NULL, updated_at = strftime('%s','now')
    WHERE user_id = ? AND event_id = ?`).run(JSON.stringify(next), hash, row.user_id, row.event_id);
  return next.length ? 'written' : 'removed';
}

let flushing = null;
/** Write everything marked dirty (one flush at a time). Returns how many rows were handled. */
function flush({ limit = 50 } = {}) {
  if (flushing) return flushing.then(() => flush({ limit }));
  flushing = (async () => {
    const rows = db._raw().prepare('SELECT * FROM calendar_mirror WHERE dirty = 1 AND attempts < ? ORDER BY updated_at LIMIT ?').all(MAX_ATTEMPTS, limit);
    let n = 0;
    for (const r of rows) {
      try { await syncRow(r); n++; }
      catch (err) {
        console.error(`[calmirror] user=${r.user_id} event=${r.event_id}:`, err.message);
        db._raw().prepare('UPDATE calendar_mirror SET attempts = attempts + 1, last_error = ? WHERE user_id = ? AND event_id = ?')
          .run(String(err.message).slice(0, 300), r.user_id, r.event_id);
      }
    }
    return n;
  })().finally(() => { flushing = null; });
  return flushing;
}

/** Flush soon, without making the caller wait (ripples are synchronous). */
function flushSoon() { setImmediate(() => { flush().catch(() => {}); }); }

module.exports = { isOn, desired, markDirty, markAllFor, peopleIn, flush, flushSoon, _setGoogle };
