/**
 * attendance.js — "Did you make it?" after a plan (FLAI attendance gate, TOKEN.md §2.1).
 *
 * 2026-10-13: the gate now asks about real plans (cadence.plansToConfirm) and is answered
 * in the app (Home) or by a text reply. One answer path for both: record it, measure lift,
 * and — if they made it — count it as having seen the people in the plan, so "it's been a
 * while" nudges (cadences) reset for them.
 */
'use strict';

const db = require('./db');

/** The user's check-ins waiting for an answer (asked in the last 7 days). */
function openFor(userId) {
  const t = Math.floor(Date.now() / 1000);
  return db._raw().prepare(`SELECT ac.id, ac.event_id, se.title, se.scheduled_at FROM attendance_confirmations ac
    JOIN social_events se ON se.id = ac.event_id
    WHERE ac.user_id = ? AND ac.confirmed_at IS NULL AND ac.attended IS NULL AND ac.asked_at > ? ORDER BY se.scheduled_at DESC`).all(userId, t - 7 * 86400);
}

/**
 * Answer one check-in. attended: true | false | null (skip). Returns { ok } or { error }.
 * Only the person it was asked of can answer it.
 */
function answer(confirmationId, userId, attended) {
  const row = db._raw().prepare('SELECT * FROM attendance_confirmations WHERE id = ?').get(confirmationId);
  if (!row || row.user_id !== userId) return { error: 'NOT_FOUND' };
  const now = Math.floor(Date.now() / 1000);
  const value = attended === true ? 1 : attended === false ? 0 : null;
  db.updateAttendanceConfirmation(confirmationId, { attended: value, confirmed_at: value === null ? null : now });
  if (value !== null) {
    require('./lift').computeAndLogLift(row.event_id, userId).catch((err) => console.error('[attendance] lift:', err.message));
  }
  if (value === 1) sawPeople(row.event_id, userId);
  return { ok: true, attended: value };
}

/**
 * "We moved it" (🐛 #88 — Sean: "I need to be able to give feedback that it got changed to another day because we ended
 * up not doing it yesterday"). Not a yes or a no: the plan's date changes — `when` in their words ("thursday 6pm"),
 * or none = date TBD — through planops (a guest's change becomes a suggestion to the host / co-hosts), and the
 * check-in is cleared so it's asked again after the new date.
 */
function moved(confirmationId, userId, when) {
  const row = db._raw().prepare('SELECT * FROM attendance_confirmations WHERE id = ?').get(confirmationId);
  if (!row || row.user_id !== userId) return { error: 'NOT_FOUND' };
  const w = String(when || '').trim().slice(0, 80);
  if (w) {   // read the day first — a guest's change goes to the host as a suggestion, so it must make sense
    const dt = require('./datetime'); const tz = db.getUser(userId)?.timezone || 'America/Los_Angeles';
    if (!dt.resolveRange(w, tz) && !dt.resolveEventDateTime(w, tz) && !dt.resolveDateOnly(w, tz)) return { error: 'BAD_DATE', message: `Couldn’t read a day from “${w}” — try “Thursday 6pm” or “Oct 29”.` };
  }
  const r = require('./planops').update(userId, row.event_id, w ? { when: w } : { date_tbd: true }, { via: 'app' });
  if (r.error) return r;
  db._raw().prepare('DELETE FROM attendance_confirmations WHERE id = ?').run(confirmationId);
  const p = require('./plan').planFor(row.event_id, userId);
  return { ok: true, suggested: !!r.suggested, to: r.to, dates: p?.dates?.label || null };
}

// They made it: every cadence they have with someone who was in the plan is fulfilled.
function sawPeople(eventId, userId) {
  const e = db._raw().prepare('SELECT host_user_id, scheduled_at FROM social_events WHERE id = ?').get(eventId);
  if (!e) return 0;
  const me = db.getUser(userId)?.phone;
  const phones = [db.getUser(e.host_user_id)?.phone, ...db._raw().prepare(`SELECT c.phone FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
    WHERE ei.event_id = ? AND ei.status = 'accepted'`).all(eventId).map((r) => r.phone)].filter((p) => p && p !== me);
  if (!phones.length) return 0;
  return db._raw().prepare(`UPDATE cadences SET last_fulfilled_at = MAX(COALESCE(last_fulfilled_at, 0), ?)
    WHERE active = 1 AND relationship_id IN (SELECT r.id FROM relationships r JOIN contacts c ON c.id = r.contact_id
      WHERE r.user_id = ? AND c.phone IN (${phones.map(() => '?').join(',')}))`).run(e.scheduled_at, userId, ...phones).changes;
}

module.exports = { openFor, answer, moved, sawPeople };
