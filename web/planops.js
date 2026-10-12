/**
 * planops.js — the ONE place a plan is changed.
 *
 * Owner, 2026-10-12: "We need to organize better so we're operating on single objects, not
 * stringing things together with spaghetti logic." Plans used to be changed from several
 * places with different rules (the agent's create/update tools, the app's edit route,
 * merges, group catch-ups): one checked name length and another didn't, one sent FYIs to
 * people who deferred and another only for some changes — and nothing stopped a second plan
 * with the same name. Every create / update / cancel / invite / merge now goes through here:
 *   - one plan per name (open plans of the same host)
 *   - names 1–80 characters
 *   - dates: a chosen date clears the options; options without a chosen date = date TBD
 *   - FYI to people who deferred when the date, place, lock-in or status changes
 *   - every change written to plan_changes (who, how, old → new)
 * Readers use plan.js. Callers check who's acting (host); this module re-checks.
 */
'use strict';

const db = require('./db');
const multiparty = require('./multiparty');
const plan = require('./plan');
const datetime = require('./datetime');
const defer = require('./defer');

const MAX_TITLE = 80;
const SET_FIELDS = ['title', 'activity_type', 'notes', 'venue_name', 'venue_address', 'scheduled_at', 'date_tbd', 'proposed_dates',
  'tentative', 'flexible_time', 'duration_mins', 'event_type', 'host_attending', 'status', 'group_id'];

function log(eventId, actorId, via, field, oldV, newV) {
  db._raw().prepare(`INSERT INTO plan_changes (event_id, actor_id, via, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(eventId, actorId || null, via, field, oldV == null ? null : String(oldV).slice(0, 500), newV == null ? null : String(newV).slice(0, 500));
}

function cleanTitle(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s && s.length <= MAX_TITLE ? s : null;
}

const toTs = (v) => (typeof v === 'number' ? Math.floor(v) : Math.floor(new Date(v).getTime() / 1000));

/**
 * Create a plan. input: title, activity_type, when ("friday 7pm"), scheduled_at,
 * flexible_time, tentative, proposed_dates, duration_mins, notes, venue_name,
 * venue_address, event_type, group (name), contact_ids.
 */
async function create(hostId, input, { via = 'agent' } = {}) {
  const host = db.getUser(hostId);
  if (!host) return { error: 'NO_USER' };
  const title = cleanTitle(input.title);
  if (!title) return { error: 'BAD_TITLE', message: `A plan needs a name of 1–${MAX_TITLE} characters.` };
  const same = plan.existingByName(hostId, title);
  if (same) {
    return { error: 'PLAN_EXISTS', action_status: 'NOT_CREATED', eventId: same.id,
      message: `"${same.title}" already exists (eventId="${same.id}"). Update it with update_event (dates → scheduled_at or proposed_dates, venue_name, notes) — don't create another.` };
  }
  const data = { title, activity_type: input.activity_type || 'hangout', venue_name: input.venue_name, venue_address: input.venue_address,
    duration_mins: input.duration_mins, notes: input.notes, event_type: input.event_type, flexible_time: input.flexible_time,
    tentative: input.tentative, proposed_dates: input.proposed_dates, scheduled_at: input.scheduled_at };

  // People: a named group invites its members; inviting a whole group makes it that group's plan.
  let contactIds = input.contact_ids || [];
  if (input.group) {
    const { group: g, groups: all } = require('./plans').findGroup(hostId, input.group);
    if (!g) return { error: 'GROUP_NOT_FOUND', message: `No group called "${input.group}". Groups: ${all.map((x) => x.name).join(', ') || 'none yet'}.` };
    data.group_id = g.id;
    contactIds = [...new Set([...contactIds, ...g.members.map((m) => m.id).filter(Boolean)])];
  } else if (contactIds.length) {
    const g = require('./groups').groupCoveredBy(hostId, contactIds);
    if (g) data.group_id = g.id;
  }

  // Dates: a spoken day+time is resolved here, in the host's timezone (never by the model).
  let resolved = null;
  if (input.when && !input.flexible_time) {
    resolved = datetime.resolveEventDateTime(input.when, host.timezone || 'America/Los_Angeles');
    if (resolved) data.scheduled_at = resolved.iso;
  }
  if (!data.scheduled_at && !data.flexible_time) data.date_tbd = true;   // plans exist from first mention

  let eventId;
  try { eventId = multiparty.createEvent(hostId, data); }
  catch (err) { return { error: 'BAD_PROPOSED_DATES', message: err.message }; }
  log(eventId, hostId, via, 'created', null, title);

  const inv = contactIds.length ? await invite(hostId, eventId, contactIds, { via }) : { sent: 0, skipped: 0 };
  const g = data.group_id ? db.getContactGroups(hostId).find((x) => x.id === data.group_id) : null;
  return { eventId, invites: inv, group: g?.name, scheduled_for: resolved?.label };
}

/**
 * Change a plan. changes: any of title, activity_type, notes, venue_name, venue_address,
 * scheduled_at (or when), proposed_dates, tentative, flexible_time, duration_mins,
 * event_type, host_attending, cancel / status:'cancelled'.
 */
function update(actorId, eventId, changes, { via = 'agent' } = {}) {
  const e = db._raw().prepare('SELECT * FROM social_events WHERE id = ?').get(eventId);
  if (!e) return { error: 'EVENT_NOT_FOUND' };
  if (e.host_user_id !== actorId) return { error: 'NOT_HOST', message: 'Only the host can change this plan.' };
  const u = {};

  if (changes.title !== undefined) {
    const t = cleanTitle(changes.title);
    if (!t) return { error: 'BAD_TITLE', message: `Name must be 1–${MAX_TITLE} characters` };
    const same = plan.existingByName(actorId, t);
    if (same && same.id !== eventId) return { error: 'PLAN_EXISTS', eventId: same.id, message: `You already have a plan called "${same.title}".` };
    u.title = t;
  }
  for (const k of ['activity_type', 'notes', 'venue_name', 'venue_address']) if (changes[k] !== undefined) u[k] = changes[k] === '' ? null : changes[k];

  // Dates
  let when = changes.scheduled_at;
  if (changes.when) {
    const r = datetime.resolveEventDateTime(changes.when, db.getUser(actorId)?.timezone || 'America/Los_Angeles');
    if (!r) return { error: 'BAD_DATE', message: `Couldn't read a date and time from "${changes.when}".` };
    when = r.iso;
  }
  if (when !== undefined && when !== null) {
    const ts = toTs(when);
    if (!Number.isFinite(ts)) return { error: 'BAD_DATE', message: 'scheduled_at must be an ISO date-time.' };
    Object.assign(u, { scheduled_at: ts, date_tbd: 0, flexible_time: 0 });
    if (changes.proposed_dates === undefined) u.proposed_dates = null;   // a chosen date replaces the options
  }
  if (changes.proposed_dates !== undefined) {
    let p;
    try { p = multiparty.normalizeProposals(changes.proposed_dates); } catch (err) { return { error: 'BAD_PROPOSED_DATES', message: err.message }; }
    u.proposed_dates = p ? JSON.stringify(p) : null;
    if (p && changes.tentative === undefined) u.tentative = 1;
    if (p && u.scheduled_at === undefined && (e.date_tbd || e.flexible_time)) Object.assign(u, { date_tbd: 1, flexible_time: 0 });
  }
  if (changes.tentative !== undefined) u.tentative = changes.tentative ? 1 : 0;
  if (changes.flexible_time !== undefined) u.flexible_time = changes.flexible_time ? 1 : 0;
  if (changes.duration_mins !== undefined && Number(changes.duration_mins) > 0) u.duration_mins = Math.round(Number(changes.duration_mins));
  if (changes.event_type !== undefined) u.event_type = changes.event_type === 'public' ? 'public' : 'private';
  if (changes.host_attending !== undefined) u.host_attending = changes.host_attending ? 1 : 0;
  if (changes.group_id !== undefined && db.getContactGroups(actorId).some((g) => g.id === changes.group_id)) u.group_id = changes.group_id;
  if (changes.cancel === true || changes.status === 'cancelled') u.status = 'cancelled';
  else if (changes.status === 'open') u.status = 'open';

  const fields = Object.keys(u).filter((k) => SET_FIELDS.includes(k) && String(u[k] ?? '') !== String(e[k] ?? ''));
  if (!fields.length) return { ok: true, event_id: eventId, updated: [], note: 'Nothing changed' };
  db._raw().prepare(`UPDATE social_events SET ${fields.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...fields.map((k) => u[k]), eventId);
  for (const k of fields) log(eventId, actorId, via, k, e[k], u[k]);

  // FYI (not a question) to people who deferred, on big changes (defer.js).
  const tz = db.getUser(actorId)?.timezone || 'America/Los_Angeles';
  const big = [];
  if (fields.includes('scheduled_at') && !u.date_tbd) big.push(`the date is now ${new Date(u.scheduled_at * 1000).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })}`);
  if (fields.includes('venue_name') && u.venue_name) big.push(`it's now at ${u.venue_name}`);
  if (fields.includes('tentative') && u.tentative === 0) big.push("it's locked in");
  if (fields.includes('status') && u.status === 'cancelled') big.push("it's cancelled");
  const fyi = big.length ? defer.notifyDeferred(eventId, big.join('; ')) : 0;
  return { ok: true, event_id: eventId, updated: fields, fyi_sent_to_deferred: fyi || undefined };
}

/** Invite people (the host's contacts). quiet: no per-invite notification (caller sends one). */
async function invite(actorId, eventId, contactIds, { via = 'agent', quiet = false } = {}) {
  const e = db._raw().prepare('SELECT host_user_id FROM social_events WHERE id = ?').get(eventId);
  if (!e) return { error: 'EVENT_NOT_FOUND', sent: 0, skipped: contactIds.length };
  if (e.host_user_id !== actorId) return { error: 'NOT_HOST', sent: 0, skipped: contactIds.length };
  const r = await multiparty.inviteContacts(eventId, contactIds, { quiet });
  if (r.sent) log(eventId, actorId, via, 'invited', null, `${r.sent} invited`);
  return r;
}

/** Fold `dropId` into `keepId` (people, discussion, dates, place). Host only. */
function merge(actorId, keepId, dropId, { via = 'agent' } = {}) {
  const r = multiparty.mergeEvents(actorId, keepId, dropId);
  if (r.merged) { log(keepId, actorId, via, 'merged_in', dropId, r.combined.title); log(dropId, actorId, via, 'status', 'open', 'cancelled'); }
  return r;
}

/** What changed on a plan, newest first (for the admin / feedback). */
function history(eventId, limit = 50) {
  return db._raw().prepare('SELECT * FROM plan_changes WHERE event_id = ? ORDER BY id DESC LIMIT ?').all(eventId, limit);
}

module.exports = { create, update, invite, merge, history, MAX_TITLE };
