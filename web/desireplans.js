/**
 * desireplans.js — social desires are plans (owner, 2026-10-13: "make them plans").
 *
 * "Go out with a friend or two this week" used to become desires + coordination sessions
 * that negotiated a time between agents and finished as "scheduled" without any plan, so
 * nothing showed on Home, the calendar or in chat (event-map contradiction #3). Now:
 *   - each social desire becomes plans on first mention, one per time it should happen
 *     (frequency, max 3): idea stage with the desire's window as proposed dates, named from
 *     its kind ("Meal out with a friend or two — week of Oct 13"), people named → invited;
 *   - when negotiation agrees a time, the next undated plan gets that date and the people
 *     who agreed are invited (all through planops, so it ripples);
 *   - deleting a desire cancels its plans that nobody has said yes to yet.
 * Solo and protective desires ("work out", "a chill night") stay what they are: holds and
 * preferences for the user's own agent, not plans with people.
 */
'use strict';

const db = require('./db');
const planops = require('./planops');

const LABELS = {
  social: 'Night out', active: 'Workout', dining: 'Meal out', outdoor: 'Outdoors', live_music: 'Live music',
  dancing: 'Dancing', drinks: 'Drinks', chill: 'Hangout', sports: 'Sports', culture: 'Culture night',
};
function size(min, max) {
  if (min === 1 && max === 1) return 'a friend';
  if (min === 1 && max === 2) return 'a friend or two';
  if (min === 2 && max === 3) return 'a couple of friends';
  if (min === max) return `${min} friends`;
  return `${min}–${max} friends`;
}
const fmt = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/**
 * Plans for one social desire. d: { category, sizeMin, sizeMax, frequency, windowStart,
 * windowEnd, candidateStrategy }. candidateIds: contacts the user named.
 * Returns [{ event_id, title }].
 */
async function forDesire(userId, desireId, d, candidateIds = []) {
  if (!(d.sizeMin > 0)) return [];
  const to = d.windowEnd > addDays(d.windowStart, 13) ? addDays(d.windowStart, 13) : d.windowEnd;   // a proposed range is at most 14 days
  const base = `${LABELS[d.category] || 'Plan'} with ${size(d.sizeMin, d.sizeMax)} — week of ${fmt(d.windowStart)}`;
  const n = Math.min(Math.max(d.frequency || 1, 1), 3);
  const made = [];
  for (let i = 1; i <= n; i++) {
    let title = n > 1 ? `${base} (${i} of ${n})` : base;
    let r = await planops.create(userId, { title, activity_type: d.category, tentative: true,
      proposed_dates: [{ from: d.windowStart, to }],
      contact_ids: d.candidateStrategy === 'specific' ? candidateIds : [] }, { via: 'desire' });
    for (let k = 2; r.error === 'PLAN_EXISTS' && k < 6; k++) {
      title = `${n > 1 ? `${base} (${i} of ${n})` : base} #${k}`;
      r = await planops.create(userId, { title, activity_type: d.category, tentative: true, proposed_dates: [{ from: d.windowStart, to }],
        contact_ids: d.candidateStrategy === 'specific' ? candidateIds : [] }, { via: 'desire' });
    }
    if (r.error) { console.error(`[desireplans] desire=${desireId}: ${r.error}`); continue; }
    db._raw().prepare('INSERT OR IGNORE INTO desire_plans (desire_id, event_id) VALUES (?, ?)').run(desireId, r.eventId);
    made.push({ event_id: r.eventId, title });
  }
  return made;
}

/** Negotiation agreed a time: the desire's next undated plan gets it, and who agreed is invited. */
async function scheduled(sessionId) {
  const s = db.getCoordSession(sessionId);
  if (!s?.agreed_slot_start) return null;
  const desire = db._raw().prepare('SELECT user_id FROM desires WHERE id = ?').get(s.desire_id);
  if (!desire) return null;
  const p = db._raw().prepare(`SELECT se.id FROM desire_plans dp JOIN social_events se ON se.id = dp.event_id
    WHERE dp.desire_id = ? AND COALESCE(se.status, 'open') != 'cancelled' AND (se.date_tbd = 1 OR se.proposed_dates IS NOT NULL)
    ORDER BY dp.created_at LIMIT 1`).get(s.desire_id);
  if (!p) return null;
  const raw = String(s.agreed_slot_start);   // ISO (coordination.js); plain seconds tolerated
  const start = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw);
  if (!Number.isFinite(start)) return null;
  planops.update(desire.user_id, p.id, { scheduled_at: new Date(start).toISOString(), ...(s.agreed_slot_duration ? { duration_mins: s.agreed_slot_duration } : {}) }, { via: 'negotiation' });
  // The people whose agents confirmed, as the host's contacts.
  const host = db.getUser(desire.user_id);
  const contactIds = db.getCoordPeers(sessionId).filter((x) => x.state === 'confirmed')
    .map((x) => db._raw().prepare('SELECT phone FROM users WHERE agent_endpoint = ?').get(x.peer_agent_id)?.phone)
    .filter(Boolean)
    .map((phone) => db.getContactsByUser(host.id).find((c) => c.phone === phone)?.id)
    .filter(Boolean);
  if (contactIds.length) await planops.invite(host.id, p.id, contactIds, { via: 'negotiation' });
  return p.id;
}

/** Deleting desires: cancel their plans that nobody has said yes to and that have no set date. */
function cancelFor(userId, desireIds) {
  let n = 0;
  for (const did of desireIds) {
    for (const { event_id } of db._raw().prepare('SELECT event_id FROM desire_plans WHERE desire_id = ?').all(did)) {
      const e = db._raw().prepare('SELECT host_user_id, status, date_tbd, proposed_dates FROM social_events WHERE id = ?').get(event_id);
      const joined = db._raw().prepare("SELECT 1 FROM event_invitations WHERE event_id = ? AND status = 'accepted'").get(event_id);
      if (e && e.host_user_id === userId && e.status !== 'cancelled' && !joined && (e.date_tbd || e.proposed_dates)) {
        planops.update(userId, event_id, { cancel: true }, { via: 'desire' });
        n++;
      }
    }
    db._raw().prepare('DELETE FROM desire_plans WHERE desire_id = ?').run(did);
  }
  return n;
}

module.exports = { forDesire, scheduled, cancelFor };
