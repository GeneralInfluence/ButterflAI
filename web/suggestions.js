/**
 * suggestions.js — guests suggest, hosts and co-hosts decide (owner, 2026-10-19).
 *
 * A change from someone who can't make it for everyone becomes a suggestion instead of an
 * edit: a guest's change to a plan goes to its host and co-hosts; a change to a Creating
 * item from someone not working on it goes to the item's lead and team (todos.js). The
 * deciders get an in-app notice ("Melanie suggests: place → Steamboat") and accept or decline
 * with one tap (or by telling their agent); accepting applies it through planops / todos as
 * the person who accepted, so it is logged and ripples like any change. The suggester is
 * told the outcome.
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const first = (s) => String(s || '').trim().split(/\s+/)[0] || 'Someone';
const now = () => Math.floor(Date.now() / 1000);

const WORDS = { title: 'name', venue_name: 'place', venue_address: 'address', notes: 'notes', activity_type: 'what it is',
  when: 'date', scheduled_at: 'date', proposed_dates: 'proposed dates', duration_mins: 'how long', text: 'item',
  when_text: 'when', place: 'place', status: 'status', done: 'done' };
function summarize(changes) {
  const parts = [];
  for (const [k, v] of Object.entries(changes || {})) {
    if (k === 'merge_from') { parts.push(`combine "${db._raw().prepare('SELECT title FROM social_events WHERE id = ?').get(v)?.title || 'another plan'}" into it`); continue; }
    if (k === 'tentative') { parts.push(v ? 'make it tentative' : 'lock it in'); continue; }
    if (k === 'cancel' || k === 'status' && v === 'cancelled') { parts.push('cancel it'); continue; }
    if (k === 'done') { parts.push(v ? 'mark it done' : 'reopen it'); continue; }
    if (k === 'proposed_dates' && Array.isArray(v)) { parts.push(`proposed dates → ${v.map((p) => (p.from === p.to ? p.from : `${p.from}–${p.to}`)).join(' or ')}`); continue; }
    if (k === 'scheduled_at') { parts.push(`date → ${String(v).slice(0, 16).replace('T', ' ')}`); continue; }
    if (WORDS[k]) parts.push(`${WORDS[k]} → ${String(v).slice(0, 120)}`);
  }
  return parts.join('; ') || 'a change';
}

/** Who decides: host + co-hosts for the plan; lead + team for an item (host + co-hosts if nobody leads it). */
function deciders(eventId, todoId) {
  const e = db._raw().prepare('SELECT host_user_id FROM social_events WHERE id = ?').get(eventId);
  if (!e) return [];
  const planDeciders = () => {
    const ids = [e.host_user_id];
    for (const r of db._raw().prepare(`SELECT c.phone FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
      WHERE ei.event_id = ? AND ei.role = 'cohost' AND ei.status != 'declined'`).all(eventId)) {
      const u = r.phone && db.getUserByPhone(r.phone);
      if (u && !ids.includes(u.id)) ids.push(u.id);
    }
    return ids;
  };
  if (!todoId) return planDeciders();
  const phones = require('./todos').team(todoId).map((m) => m.phone);
  const ids = phones.map((p) => db.getUserByPhone(p)?.id).filter(Boolean);
  return ids.length ? [...new Set(ids)] : planDeciders();
}

/** Record a suggestion and tell whoever decides. Returns what the caller reports back. */
function create(fromUserId, eventId, changes, { todoId = null } = {}) {
  const e = db._raw().prepare('SELECT title FROM social_events WHERE id = ?').get(eventId);
  if (!e) return { error: 'EVENT_NOT_FOUND' };
  const item = todoId ? db._raw().prepare('SELECT text FROM event_todos WHERE id = ?').get(todoId) : null;
  const summary = summarize(changes);
  const id = uuidv4();
  db._raw().prepare('INSERT INTO plan_suggestions (id, event_id, todo_id, from_user_id, changes_json, summary) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, eventId, todoId, fromUserId, JSON.stringify(changes), summary);
  const to = deciders(eventId, todoId).filter((u) => u !== fromUserId);
  const { inApp } = require('./ripples/notice');
  const { nameFor } = require('./people');
  for (const u of to) inApp(u, eventId, `💡 ${nameFor(u, fromUserId, { first: true })} suggests for ${item ? `"${item.text}" (${e.title})` : e.title}: ${summary}. Accept or decline it on the plan, or tell me.`);
  return { ok: true, suggested: true, suggestion_id: id, summary, to: to.map((u) => first(db.getUser(u)?.name)),
    message: `Not changed yet — sent as a suggestion to ${to.map((u) => first(db.getUser(u)?.name)).join(' and ') || 'the host'}, who decide${to.length === 1 ? 's' : ''}.` };
}

const view = (r, viewerId) => ({ id: r.id, event_id: r.event_id, todo_id: r.todo_id, from: r.from_user_id === viewerId ? 'you' : require('./people').nameFor(viewerId, r.from_user_id, { first: true }),
  summary: r.summary, status: r.status, at: r.created_at,
  item: r.todo_id ? db._raw().prepare('SELECT text FROM event_todos WHERE id = ?').get(r.todo_id)?.text || null : null,
  can_decide: deciders(r.event_id, r.todo_id).includes(viewerId) });

/** Pending suggestions on a plan the viewer can see: all of them for deciders, their own otherwise. */
function forPlan(eventId, viewerId) {
  return db._raw().prepare("SELECT * FROM plan_suggestions WHERE event_id = ? AND status = 'pending' ORDER BY created_at").all(eventId)
    .map((r) => view(r, viewerId)).filter((s) => s.can_decide || s.from === 'you');
}

/** Accept (applied as the person accepting) or decline. */
function decide(actorId, id, accept) {
  const r = db._raw().prepare('SELECT * FROM plan_suggestions WHERE id = ?').get(id);
  if (!r) return { error: 'NOT_FOUND' };
  if (r.status !== 'pending') return { error: 'ALREADY_DECIDED', status: r.status };
  if (!deciders(r.event_id, r.todo_id).includes(actorId)) return { error: 'NOT_YOURS_TO_DECIDE', message: 'The host, co-hosts (or for an item, whoever is working on it) decide.' };
  let applied = null;
  if (accept) {
    const changes = JSON.parse(r.changes_json);
    if (r.todo_id) applied = require('./todos').update(actorId, r.todo_id, changes, { decided: true });
    else if (changes.merge_from) applied = require('./planops').merge(actorId, r.event_id, changes.merge_from, { via: 'suggestion' });
    else applied = require('./planops').update(actorId, r.event_id, changes, { via: 'suggestion' });
    if (applied?.error) return { error: applied.error, message: applied.message };
  }
  db._raw().prepare('UPDATE plan_suggestions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(accept ? 'accepted' : 'declined', actorId, now(), id);
  const title = db._raw().prepare('SELECT title FROM social_events WHERE id = ?').get(r.event_id)?.title || 'the plan';
  if (r.from_user_id !== actorId) {
    require('./ripples/notice').inApp(r.from_user_id, r.event_id, `${require('./people').nameFor(r.from_user_id, actorId, { first: true })} ${accept ? 'accepted' : 'passed on'} your suggestion for ${title}: ${r.summary}.`);
  }
  return { ok: true, status: accept ? 'accepted' : 'declined', summary: r.summary };
}

/** The suggester takes it back. */
function withdraw(userId, id) {
  const r = db._raw().prepare("SELECT * FROM plan_suggestions WHERE id = ? AND from_user_id = ? AND status = 'pending'").get(id, userId);
  if (!r) return { error: 'NOT_FOUND' };
  db._raw().prepare("UPDATE plan_suggestions SET status = 'withdrawn', decided_at = ? WHERE id = ?").run(now(), id);
  return { ok: true };
}

module.exports = { create, decide, withdraw, forPlan, deciders, summarize };
