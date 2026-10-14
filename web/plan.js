/**
 * plan.js — the plan as ONE object.
 *
 * Owner, 2026-10-12: "We need to organize better so we're operating on single objects,
 * not stringing things together with spaghetti logic." Until now each screen re-derived a
 * plan's stage, dates and people its own way (feed, calendar, events page), and leftovers
 * like "Waiting on Allie, Melanie…" came from question threads tied to no plan.
 *
 * planFor(eventId, viewerId) describes a plan from the viewer's side, computed here once:
 *   stage    idea | proposed | invited | confirmed | past | cancelled
 *   dates    { kind: tbd | proposed | set | open, proposals, start, end, label }
 *   days     calendar days it covers (YYYY-MM-DD, viewer's timezone)
 *   people   everyone in it, with status / deferral; who's in, waiting, out
 *   asked    questions the host's agent asked people about THIS plan, not answered yet
 *   creating { done, total, suggested }
 *   next     the viewer's next step, if any
 * plansFor(userId) lists the plans a user is in (hosting or invited, not declined).
 * Screens and APIs read these instead of querying tables themselves.
 */
'use strict';

const db = require('./db');

const now = () => Math.floor(Date.now() / 1000);
const first = (s) => String(s || '').trim().split(/\s+/)[0] || 'Someone';

function parseJson(s, dflt) { try { const v = JSON.parse(s || 'null'); return v ?? dflt; } catch (_) { return dflt; } }

// YYYY-MM-DD of a unix time in a timezone.
function ymd(ts, tz) { return new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: tz }); }
function addDays(dateStr, n) { const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function span(from, to, max = 15) { const out = []; for (let d = from, i = 0; d <= to && i < max; d = addDays(d, 1), i++) out.push(d); return out; }
function fmtDay(s) { return new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }); }

function datesOf(e, tz) {
  const proposals = parseJson(e.proposed_dates, []);
  if (proposals.length) {
    return { kind: 'proposed', proposals, label: proposals.map((p) => (p.from === p.to ? fmtDay(p.from) : `${fmtDay(p.from)} – ${fmtDay(p.to)}`)).join(' or ') + ' (proposed)',
      days: [...new Set(proposals.flatMap((p) => span(p.from, p.to)))], last: proposals[proposals.length - 1].to };
  }
  if (e.date_tbd) return { kind: 'tbd', proposals: [], label: 'Date TBD', days: [] };
  if (e.flexible_time) return { kind: 'open', proposals: [], label: 'Open invite', days: [] };
  const start = e.scheduled_at, end = e.scheduled_at + Math.max(60, (e.duration_mins || 120) * 60) - 60;
  return { kind: 'set', proposals: [], start, end, days: span(ymd(start, tz), ymd(end, tz)),
    label: new Date(start * 1000).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) };
}

/** The plan from `viewerId`'s side, or null if they're not in it. */
function planFor(eventId, viewerId) {
  const e = db._raw().prepare('SELECT * FROM social_events WHERE id = ?').get(eventId);
  if (!e) return null;
  const viewer = db.getUser(viewerId);
  if (!viewer) return null;
  const tz = viewer.timezone || 'America/Los_Angeles';
  const host = db.getUser(e.host_user_id);
  const invitations = db._raw().prepare(`SELECT ei.id, ei.status, ei.going, ei.defers_to, ei.dismissed_at, ei.needs_owner_decision, c.phone, COALESCE(c.nickname, c.name) AS name
    FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ?`).all(e.id);
  const isHost = e.host_user_id === viewerId;
  const mine = invitations.find((i) => i.phone && i.phone === viewer.phone);
  if (!isHost && (!mine || mine.dismissed_at)) return null;

  const people = invitations.map((i) => ({
    name: first(i.name), status: i.status,
    // On a tentative plan a yes is "interested" unless they said they're going (2026-10-13).
    going: i.status === 'accepted' && (!!i.going || !e.tentative),
    deferring_to: parseJson(i.defers_to, []).map((n) => (isHost && n === first(viewer.name) ? 'you' : n)),
  }));
  const plain = people.filter((p) => !p.deferring_to.length);
  const dates = datesOf(e, tz);
  const t = now();

  // Questions the host's agent asked people about this plan that haven't been answered.
  const asked = isHost ? db._raw().prepare(`SELECT u.name, am.created_at FROM agent_messages am JOIN users u ON u.id = am.to_user
    WHERE am.from_user = ? AND am.thread_id = ? AND am.kind = 'query' AND am.processed = 0`).all(viewerId, e.id).map((q) => first(q.name)) : [];

  const todo = db._raw().prepare(`SELECT count(*) total, sum(done_at IS NOT NULL AND suggested = 0) done, sum(suggested = 1) suggested,
    sum(suggested = 0) kept FROM event_todos WHERE event_id = ?`).get(e.id);

  const ended = dates.kind === 'set' ? dates.end < t : dates.kind === 'proposed' ? (Date.parse(dates.last + 'T23:59:59Z') / 1000) < t - 86400 : false;
  const stage = e.status === 'cancelled' ? 'cancelled'
    : ended ? 'past'
    : !isHost && mine?.status === 'invited' ? 'invited'
    : dates.kind === 'tbd' ? 'idea'
    : e.tentative ? 'proposed'
    : 'confirmed';

  const interested = plain.filter((p) => p.status === 'accepted').map((p) => p.name);   // everyone who said yes
  const going = plain.filter((p) => p.going).map((p) => p.name);                         // …of whom these said they're going
  const waiting = plain.filter((p) => p.status === 'invited').map((p) => p.name);
  // Paused after a heads-up (ripples/reactions/avoid-heads-up.js): they said yes before.
  const stillGoing = !isHost && mine && mine.status === 'accepted' && mine.needs_owner_decision;
  const next = stillGoing ? 'Still going? Tap to answer'
    : stage === 'invited' ? (e.tentative ? 'Interested? Tap to answer' : 'Tap to respond')
    : isHost && stage === 'idea' ? 'Pick dates'
    : isHost && e.tentative && invitations.length && !waiting.length && (interested.length || people.some((p) => p.deferring_to.length))
      ? 'Lock in the plan — tell your agent the final details' : null;

  return {
    id: e.id, title: e.title, what: e.activity_type, place: e.venue_name || null, notes: e.notes || null,
    host: { name: first(host?.name), is_you: isHost }, role: isHost ? 'host' : 'guest',
    invitation: mine ? { id: mine.id, status: mine.status, going: mine.status === 'accepted' && (!!mine.going || !e.tentative), must_ask: !!mine.needs_owner_decision && mine.status !== 'declined',
      deferred_to: parseJson(mine.defers_to, []) } : null,
    tentative: !!e.tentative, stage, dates, days: dates.days, at: dates.kind === 'set' ? dates.start : null,
    group: e.group_id ? (db._raw().prepare('SELECT id, name FROM contact_groups WHERE id = ?').get(e.group_id) || null) : null,
    people, interested, going, waiting_on: waiting, out: plain.filter((p) => p.status === 'declined').map((p) => p.name),
    deferring: people.filter((p) => p.deferring_to.length).map((p) => ({ who: p.name, to: p.deferring_to })),
    asked, creating: { done: todo.done || 0, total: todo.kept || 0, suggested: todo.suggested || 0 },
    // What friends' ButterflAIs answered this viewer's questions about this plan (answers.js).
    answers: require('./answers').forPlan(e.id, viewerId),
    next,
  };
}

/** Every plan the user is in (hosting, or invited and not declined), excluding cancelled. */
function plansFor(userId, { includePast = false, includeDeclined = false } = {}) {
  const u = db.getUser(userId);
  if (!u) return [];
  const ids = db._raw().prepare(`
    SELECT id FROM social_events WHERE host_user_id = ? AND COALESCE(status, 'open') != 'cancelled'
    UNION
    SELECT se.id FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id JOIN social_events se ON se.id = ei.event_id
    WHERE c.phone = ? AND se.host_user_id != ? AND (ei.status != 'declined' OR ?) AND ei.dismissed_at IS NULL AND COALESCE(se.status, 'open') != 'cancelled'`)
    .all(userId, u.phone || '', userId, includeDeclined ? 1 : 0).map((r) => r.id);
  return ids.map((id) => planFor(id, userId)).filter(Boolean).filter((p) => includePast || p.stage !== 'past');
}

/**
 * The plan circle (owner, 2026-10-13: agents in the same plan "speak to each other
 * differently than an outside agent"). Two users are insiders of a plan when it isn't
 * cancelled and each is its host or has said yes (deferring counts — they're in).
 * Computed live from the guest list, so it follows every RSVP with nothing stored.
 */
function inCircle(eventId, userA, userB) {
  if (!eventId || !userA || !userB || userA === userB) return false;
  const e = db._raw().prepare('SELECT host_user_id, status FROM social_events WHERE id = ?').get(eventId);
  if (!e || e.status === 'cancelled') return false;
  const inIt = (uid) => {
    if (uid === e.host_user_id) return true;
    const u = db.getUser(uid);
    return !!(u?.phone && db._raw().prepare(`SELECT 1 FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
      WHERE ei.event_id = ? AND c.phone = ? AND ei.status = 'accepted'`).get(eventId, u.phone));
  };
  return inIt(userA) && inIt(userB);
}

/** Normalized plan name for "is this the same plan?" (case, punctuation, spacing). */
function sameName(a, b) {
  const n = (s) => String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return n(a) === n(b);
}

/** An open plan this host already has with the same name (for "don't create twice"). */
function existingByName(hostUserId, title) {
  const rows = db._raw().prepare(`SELECT id, title, scheduled_at, date_tbd FROM social_events WHERE host_user_id = ? AND COALESCE(status, 'open') != 'cancelled'
    AND (date_tbd = 1 OR scheduled_at > ?)`).all(hostUserId, now() - 86400);
  return rows.find((r) => sameName(r.title, title)) || null;
}

module.exports = { planFor, plansFor, existingByName, sameName, inCircle };
