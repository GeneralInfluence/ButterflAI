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
 *   - every change recorded as a ripple (ripples/), in the same transaction, and the
 *     reactions run: guest answers, deferring, removing and hiding go through here too
 *     (owner, 2026-10-13: "every change to an event should cascade through the entire
 *     system"). The only other code that writes plans is multiparty.js, the storage layer
 *     this module calls (tests/integration/ripples.test.js checks both).
 * Readers use plan.js. Callers check who's acting (host); this module re-checks.
 */
'use strict';

const db = require('./db');
const multiparty = require('./multiparty');
const plan = require('./plan');
const datetime = require('./datetime');
const defer = require('./defer');
const ripples = require('./ripples');

const MAX_TITLE = 80;
const SET_FIELDS = ['title', 'activity_type', 'notes', 'venue_name', 'venue_address', 'scheduled_at', 'date_tbd', 'proposed_dates',
  'tentative', 'flexible_time', 'duration_mins', 'event_type', 'host_attending', 'status', 'group_id', 'cancelled_at'];

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
    const { group: g, groups: all } = require('./feeling').findGroup(hostId, input.group);
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
  try {
    db._raw().transaction(() => {
      eventId = multiparty.createEvent(hostId, data);
      log(eventId, hostId, via, 'created', null, title);
      ripples.ripple([{ type: 'created', event_id: eventId, actor_id: hostId, via, data: { title } }]);
    })();
  } catch (err) { return { error: 'BAD_PROPOSED_DATES', message: err.message }; }

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
  if (changes.cancel === true || changes.status === 'cancelled') { u.status = 'cancelled'; if (e.status !== 'cancelled') u.cancelled_at = Math.floor(Date.now() / 1000); }
  else if (changes.status === 'open') { u.status = 'open'; u.cancelled_at = null; }

  const fields = Object.keys(u).filter((k) => SET_FIELDS.includes(k) && String(u[k] ?? '') !== String(e[k] ?? ''));
  if (!fields.length) return { ok: true, event_id: eventId, updated: [], note: 'Nothing changed' };
  let batch;
  db._raw().transaction(() => {
    db._raw().prepare(`UPDATE social_events SET ${fields.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...fields.map((k) => u[k]), eventId);
    for (const k of fields) log(eventId, actorId, via, k, e[k], u[k]);
    batch = ripples.emit(changesFor(eventId, actorId, via, fields, e, { ...e, ...u }));
  })();
  const results = ripples.run(batch);
  return { ok: true, event_id: eventId, updated: fields.filter((f) => f !== 'cancelled_at'), fyi_sent_to_deferred: results['deferrers-fyi'] || undefined };
}

// Which kinds of change (ripples.TYPES) a set of changed fields amounts to.
const DATE_FIELDS = ['scheduled_at', 'date_tbd', 'proposed_dates', 'flexible_time', 'duration_mins'];
function changesFor(eventId, actorId, via, fields, before, after) {
  const has = (...ks) => ks.some((k) => fields.includes(k));
  const c = (type, data = {}) => ({ type, event_id: eventId, actor_id: actorId, via, data });
  const out = [];
  if (has('title')) out.push(c('renamed', { from: before.title, to: after.title }));
  if (has(...DATE_FIELDS)) out.push(c('dates_changed', { scheduled_at: after.scheduled_at, date_tbd: !!after.date_tbd, proposed_dates: after.proposed_dates || null, changed: fields.filter((f) => DATE_FIELDS.includes(f)) }));
  if (has('venue_name', 'venue_address')) out.push(c('place_changed', { venue_name: after.venue_name || null, venue_address: after.venue_address || null }));
  if (has('tentative') && !after.tentative) out.push(c('locked_in'));
  if (has('status') && after.status === 'cancelled') out.push(c('cancelled'));
  const other = fields.filter((f) => !['title', 'venue_name', 'venue_address', 'cancelled_at', ...DATE_FIELDS].includes(f)
    && !(f === 'tentative' && !after.tentative) && !(f === 'status' && after.status === 'cancelled'));
  if (other.length) out.push(c('details_changed', { fields: other }));
  return out;
}

/** Invite people (the host's contacts). quiet: no per-invite notification (caller sends one). */
async function invite(actorId, eventId, contactIds, { via = 'agent', quiet = false } = {}) {
  const e = db._raw().prepare('SELECT host_user_id FROM social_events WHERE id = ?').get(eventId);
  if (!e) return { error: 'EVENT_NOT_FOUND', sent: 0, skipped: contactIds.length };
  if (e.host_user_id !== actorId) return { error: 'NOT_HOST', sent: 0, skipped: contactIds.length };
  const before = new Set(db._raw().prepare('SELECT id FROM event_invitations WHERE event_id = ?').all(eventId).map((x) => x.id));
  const r = await multiparty.inviteContacts(eventId, contactIds, { quiet });
  const added = guestRows(eventId).filter((g) => !before.has(g.invitation_id));
  if (added.length) {
    log(eventId, actorId, via, 'invited', null, `${added.length} invited`);
    ripples.ripple(added.flatMap((g) => [
      { type: 'guest_added', event_id: eventId, actor_id: actorId, via, data: g },
      // The new guest's avoid list declined at once (inside the invite, which already sent
      // the host the ordinary decline notice).
      g.status === 'declined' ? { type: 'guest_responded', event_id: eventId, actor_id: null, via, data: { ...g, previous: 'invited', by: 'avoid_list' } } : null,
    ]));
  }
  return r;
}

// Who's on a plan, as ripple data (one row per invitation).
function guestRows(eventId) {
  return db._raw().prepare(`SELECT ei.id AS invitation_id, ei.contact_id, ei.status, ei.source, c.phone, COALESCE(c.nickname, c.name) AS name
    FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ?`).all(eventId);
}
function guestRow(invitationId) {
  return db._raw().prepare(`SELECT ei.id AS invitation_id, ei.event_id, ei.contact_id, ei.status, ei.source, ei.needs_owner_decision, ei.defers_to,
      c.phone, COALESCE(c.nickname, c.name) AS name, se.host_user_id, se.title
    FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id JOIN social_events se ON se.id = ei.event_id WHERE ei.id = ?`).get(invitationId);
}

/**
 * A guest's answer (accepted | declined). by: 'guest' (in the app or their own agent —
 * phone must match), 'contact' (a text reply — phone must match), 'host' (the host
 * recording an answer they heard elsewhere — userId must be the host), 'public' (the
 * public event page). An answer that doesn't change their status only clears a pause
 * ("Still going?" → yes) and ripples nothing.
 */
function respond(invitationId, status, { by = 'guest', phone = null, userId = null, via = 'app' } = {}) {
  if (!['accepted', 'declined'].includes(status)) return { ok: false, error: 'BAD_STATUS' };
  const g = guestRow(invitationId);
  if (!g) return { ok: false, error: 'INVITATION_NOT_FOUND' };
  if ((by === 'guest' || by === 'contact') && (!phone || g.phone !== phone)) return { ok: false, error: 'Not authorized' };
  if (by === 'host' && g.host_user_id !== userId) return { ok: false, error: 'NOT_HOST' };
  let batch = null;
  db._raw().transaction(() => {
    db._raw().prepare(`UPDATE event_invitations SET status = ?, responded_at = strftime('%s','now'), needs_owner_decision = 0 WHERE id = ?`).run(status, invitationId);
    log(g.event_id, userId, via, 'guest_status', `${g.name}: ${g.status}`, `${g.name}: ${status}`);
    if (g.status !== status) {
      batch = ripples.emit([{ type: 'guest_responded', event_id: g.event_id, actor_id: userId, via,
        data: { invitation_id: g.invitation_id, contact_id: g.contact_id, phone: g.phone, name: g.name, source: g.source, status, previous: g.status, by } }]);
    }
  })();
  return { ok: true, status, previous: g.status, event_id: g.event_id, unchanged: g.status === status, ripples: ripples.run(batch) };
}

/** The host records an answer they heard about elsewhere ("Allie's in"). Adds them if not invited. */
function recordRsvp(hostId, eventId, contactId, status, { via = 'agent' } = {}) {
  const e = db._raw().prepare('SELECT host_user_id FROM social_events WHERE id = ?').get(eventId);
  if (!e || e.host_user_id !== hostId) return { ok: false, error: 'EVENT_NOT_FOUND' };
  let inv = db._raw().prepare('SELECT id FROM event_invitations WHERE event_id = ? AND contact_id = ?').get(eventId, contactId);
  if (!inv) {
    const id = require('uuid').v4();
    db._raw().transaction(() => {
      db._raw().prepare(`INSERT INTO event_invitations (id, event_id, contact_id, status) VALUES (?, ?, ?, 'invited')`).run(id, eventId, contactId);
      log(eventId, hostId, via, 'invited', null, '1 invited (recorded)');
    })();
    ripples.ripple([{ type: 'guest_added', event_id: eventId, actor_id: hostId, via, data: { ...guestRow(id), recorded: true } }]);
    inv = { id };
  }
  return respond(inv.id, status, { by: 'host', userId: hostId, via });
}

/** A stranger answers a public event from its page. */
function publicRsvp(eventId, { name, phone, status }) {
  const r = multiparty._publicRsvpWrite(eventId, { name, phone, status });
  if (!r.ok) return r;
  if (r.created) ripples.ripple([{ type: 'guest_added', event_id: eventId, via: 'public', data: guestRow(r.invitation_id) }]);
  const out = respond(r.invitation_id, status, { by: 'public', via: 'public' });
  return { ok: true, status: out.status };
}

/** The host removes someone from the plan. */
function removeGuest(actorId, eventId, invitationId, { via = 'app' } = {}) {
  const g = guestRow(invitationId);
  if (!g || g.event_id !== eventId) return { error: 'INVITATION_NOT_FOUND' };
  if (g.host_user_id !== actorId) return { error: 'NOT_HOST' };
  let batch;
  db._raw().transaction(() => {
    db._raw().prepare('DELETE FROM event_invitations WHERE id = ?').run(invitationId);
    log(eventId, actorId, via, 'removed', g.name, null);
    batch = ripples.emit([{ type: 'guest_removed', event_id: eventId, actor_id: actorId, via, data: g }]);
  })();
  return { ok: true, ripples: ripples.run(batch) };
}

/** A guest hides an invite from their Events page. */
function dismiss(invitationId, phone, { via = 'app' } = {}) {
  const r = multiparty.dismissInvitation(invitationId, phone);
  if (r.error) return r;
  const g = guestRow(invitationId);
  ripples.ripple([{ type: 'invite_hidden', event_id: g.event_id, via, data: { invitation_id: invitationId, name: g.name } }]);
  return r;
}

/** Pause a guest's answer until they decide (their agent won't answer for them). */
function askOwner(invitationId, { via = 'ripple' } = {}) {
  const g = guestRow(invitationId);
  if (!g || g.needs_owner_decision) return false;
  db._raw().prepare('UPDATE event_invitations SET needs_owner_decision = 1 WHERE id = ?').run(invitationId);
  log(g.event_id, null, via, 'asked_to_decide', null, g.name);
  return true;
}

/**
 * A guest defers on a plan (or takes it back with undo): marks them in, records who
 * decides, and answers open questions about that plan with the fixed line (defer.js).
 */
function deferOn(userId, { invitation_id, defer_to, undo = false }) {
  const user = db.getUser(userId);
  const g = invitation_id && guestRow(invitation_id);
  if (!g || !user?.phone || g.phone !== user.phone) {
    return { error: 'INVITATION_NOT_FOUND', message: 'Use an inv_id from "You have been invited to" in your state.' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (undo) {
    db._raw().transaction(() => {
      db._raw().prepare('UPDATE event_invitations SET defers_to = NULL, deferred_at = NULL WHERE id = ?').run(g.invitation_id);
      log(g.event_id, userId, 'agent', 'deferred', g.defers_to, null);
      ripples.ripple([{ type: 'deferred', event_id: g.event_id, actor_id: userId, via: 'agent', data: { invitation_id: g.invitation_id, name: g.name, undo: true } }]);
    })();
    return { ok: true, undone: true, note: `Questions about "${g.title}" will come to your user again.` };
  }
  // Names only (first names) — never a reason.
  const names = [...new Set((Array.isArray(defer_to) ? defer_to : [defer_to]).map((n) => String(n || '').trim().split(/\s+/)[0]).filter(Boolean))].slice(0, 5);
  if (!names.length) return { error: 'DEFER_TO_REQUIRED', message: 'Who does your user go with? e.g. ["Melanie", "Sean"]' };
  let batch;
  db._raw().transaction(() => {
    db._raw().prepare(`UPDATE event_invitations SET status = 'accepted', responded_at = COALESCE(responded_at, ?),
      defers_to = ?, deferred_at = ?, needs_owner_decision = 0 WHERE id = ?`).run(now, JSON.stringify(names), now, g.invitation_id);
    log(g.event_id, userId, 'agent', 'deferred', g.defers_to, JSON.stringify(names));
    batch = ripples.emit([
      { type: 'deferred', event_id: g.event_id, actor_id: userId, via: 'agent', data: { invitation_id: g.invitation_id, name: g.name, to: names } },
      g.status !== 'accepted' ? { type: 'guest_responded', event_id: g.event_id, actor_id: userId, via: 'agent',
        data: { invitation_id: g.invitation_id, contact_id: g.contact_id, phone: g.phone, name: g.name, source: g.source, status: 'accepted', previous: g.status, by: 'defer' } } : null,
    ]);
  })();
  ripples.run(batch);
  const d = defer.deferralFor(g.event_id, userId);
  // Open questions about this plan, from anyone, get the standing answer now.
  const open = db._raw().prepare(`SELECT * FROM agent_messages WHERE to_user = ? AND kind = 'query' AND processed = 0 AND thread_id = ?`)
    .all(userId, g.event_id);
  for (const q of open) defer.answerWithDeferral(q, userId, d.answer);
  return { ok: true, deferred_to: names, answered_open_questions: open.length,
    note: `Done. Questions about "${g.title}" get "${d.answer}" without bothering your user; they'll only get an FYI if the date, place or plan changes.` };
}

/** Fold `dropId` into `keepId` (people, discussion, dates, place). Host only. */
function merge(actorId, keepId, dropId, { via = 'agent' } = {}) {
  const r = multiparty.mergeEvents(actorId, keepId, dropId);
  if (r.merged) {
    log(keepId, actorId, via, 'merged_in', dropId, r.combined.title); log(dropId, actorId, via, 'status', 'open', 'cancelled');
    ripples.ripple([{ type: 'merged', event_id: keepId, actor_id: actorId, via, data: { from: dropId, title: r.combined.title } }]);
  }
  return r;
}

/**
 * Keep a dateless plan's placeholder date ahead of today so it never drifts into "past"
 * (coord loop). Not a change anyone made — no ripple (the plan still reads "date TBD").
 */
function rollDateTbd() {
  const t = Math.floor(Date.now() / 1000);
  return db._raw().prepare(`UPDATE social_events SET scheduled_at = ? WHERE date_tbd = 1 AND scheduled_at < ?`)
    .run(t + multiparty.DATE_TBD_DAYS * 86400, t + 30 * 86400).changes;
}

/**
 * Cancelled plans are deleted CANCELLED_KEEP_DAYS after they were cancelled (event-map #7:
 * "delete" used to mean "kept forever"). Goes with the plan: its invitations, to-dos,
 * change log, ripples, check-ins, calendar rows and links. People's own chat messages
 * stay — they're the user's conversation — but no longer point at the plan.
 * Calendar entries were already removed when it was cancelled (calendar ripple).
 */
const CANCELLED_KEEP_DAYS = 90;
function purgeCancelled({ days = CANCELLED_KEEP_DAYS } = {}) {
  const ids = db._raw().prepare(`SELECT id FROM social_events WHERE status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_at < ?`)
    .all(Math.floor(Date.now() / 1000) - days * 86400).map((r) => r.id);
  const tables = [['event_invitations', 'event_id'], ['event_todos', 'event_id'], ['plan_changes', 'event_id'], ['plan_ripples', 'event_id'],
    ['attendance_confirmations', 'event_id'], ['calendar_mirror', 'event_id'], ['desire_plans', 'event_id'], ['share_plans', 'event_id'],
    ['lift_observations', 'event_id'], ['contact_mentions', 'event_id']];
  const unlink = [['conversation_history', 'event_id'], ['inbound_messages', 'event_id'], ['agent_messages', 'thread_id']];
  db._raw().transaction(() => {
    for (const id of ids) {
      for (const [t, c] of tables) { try { db._raw().prepare(`DELETE FROM ${t} WHERE ${c} = ?`).run(id); } catch (_) { /* table not in this build */ } }
      for (const [t, c] of unlink) { try { db._raw().prepare(`UPDATE ${t} SET ${c} = NULL WHERE ${c} = ?`).run(id); } catch (_) {} }
      db._raw().prepare('DELETE FROM social_events WHERE id = ?').run(id);
    }
  })();
  return ids.length;
}

/** What changed on a plan, newest first (for the admin / feedback). */
function history(eventId, limit = 50) {
  return db._raw().prepare('SELECT * FROM plan_changes WHERE event_id = ? ORDER BY id DESC LIMIT ?').all(eventId, limit);
}

module.exports = { create, update, invite, merge, history, rollDateTbd, purgeCancelled, CANCELLED_KEEP_DAYS, respond, recordRsvp, publicRsvp, removeGuest, dismiss, askOwner, deferOn, MAX_TITLE };
