/**
 * todos.js — what needs to happen for each plan (owner, 2026-10-12).
 *
 * Owner decisions: everyone in the plan (host + invitees) sees and changes the list; a
 * to-do can be assigned to someone in the plan; ButterflAI SUGGESTS to-dos and people keep
 * the ones they want (suggested = 1 until kept). Seen at the top of the plan's chat, on
 * the Events card, on Home (the ones assigned to you), and through the agent.
 * Access is checked here (topics.canSee) for every read and write.
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const topics = require('./topics');
const names = require('./names');

const MAX_TEXT = 200;
const now = () => Math.floor(Date.now() / 1000);
const first = (s) => String(s || '').trim().split(/\s+/)[0] || 'Someone';

/** People in the plan: host + invitees who haven't declined. */
function members(eventId) {
  const e = db._raw().prepare('SELECT host_user_id FROM social_events WHERE id = ?').get(eventId);
  if (!e) return [];
  const host = db.getUser(e.host_user_id);
  const out = host ? [{ name: host.name, phone: host.phone, host: true }] : [];
  for (const r of db._raw().prepare(`SELECT COALESCE(c.nickname, c.name) AS name, c.phone FROM event_invitations ei
    JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND ei.status != 'declined' AND c.phone IS NOT NULL`).all(eventId)) {
    if (!out.some((m) => m.phone === r.phone)) out.push({ name: r.name, phone: r.phone });
  }
  return out;
}

function resolveAssignee(eventId, assignee, userId) {
  if (assignee == null || assignee === '') return { phone: null, name: null };
  const ms = members(eventId);
  if (/^(me|myself|i)$/i.test(String(assignee).trim())) {
    const me = db.getUser(userId);
    const m = ms.find((x) => x.phone === me?.phone);
    if (m) return { phone: m.phone, name: m.name };
  }
  const scored = ms.map((m) => ({ m, s: names.matchScore({ name: m.name }, assignee) })).filter((x) => x.s >= 80).sort((a, b) => b.s - a.s);
  if (!scored.length || (scored[1] && scored[1].s === scored[0].s)) {
    return { error: 'ASSIGNEE_NOT_IN_PLAN', message: `Assign to someone in the plan: ${ms.map((m) => first(m.name)).join(', ')}.` };
  }
  return { phone: scored[0].m.phone, name: scored[0].m.name };
}

const dayName = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
function view(t) {
  return { id: t.id, text: t.text, day: t.day || null, day_label: t.day ? dayName(t.day) : null,
    shown: t.day ? `${dayName(t.day)}: ${t.text}` : t.text,
    assignee: t.assignee_name ? first(t.assignee_name) : null, assignee_phone: t.assignee_phone,
    suggested: !!t.suggested, done: !!t.done_at };
}

// A day the plan covers, or null (to-dos can't be for a day outside the plan).
function planDay(userId, eventId, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return null;
  const p = require('./plan').planFor(eventId, userId);
  return p && (p.days || []).includes(day) ? day : null;
}

function list(userId, eventId) {
  if (!topics.canSee(userId, eventId)) return { error: 'NOT_IN_PLAN' };
  const rows = db._raw().prepare('SELECT * FROM event_todos WHERE event_id = ? ORDER BY suggested, done_at IS NOT NULL, created_at, rowid').all(eventId);
  const kept = rows.filter((t) => !t.suggested);
  return { todos: rows.map(view), progress: { done: kept.filter((t) => t.done_at).length, total: kept.length },
    members: members(eventId).map((m) => ({ name: first(m.name) })) };
}

// The words that matter in an item ("Massages - before 3:00 PM Friday" → massage, before, 3:00, friday).
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'at', 'in', 'on', 'with', 'get', 'some', 'our', 'we', 'pm', 'am']);
const keyWords = (s) => String(s || '').toLowerCase().split(/[^a-z0-9:]+/).filter((w) => w && !STOP.has(w)).map((w) => w.replace(/(?<=[a-z]{3})s$/, ''));
/**
 * An open item on the plan that this text repeats: same words, or all of its words already
 * in one item ("Massages" next to "Massages Friday (while kids at school)" — 🐛 #20, the
 * weekend had five massage items). Returns its id or null.
 */
function repeats(eventId, text) {
  const mine = keyWords(text);
  if (!mine.length) return null;
  for (const t of db._raw().prepare('SELECT id, text FROM event_todos WHERE event_id = ? AND done_at IS NULL').all(eventId)) {
    const theirs = new Set(keyWords(t.text));
    if (mine.every((w) => theirs.has(w))) return t.id;
  }
  return null;
}

function add(userId, eventId, { text, assignee, suggested = false, day = null }) {
  if (!topics.canSee(userId, eventId)) return { error: 'NOT_IN_PLAN' };
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!t) return { error: 'EMPTY' };
  const dup = repeats(eventId, t);
  if (dup) return { error: 'ALREADY_ON_LIST', todo_id: dup, message: `Already on the list: "${db._raw().prepare('SELECT text FROM event_todos WHERE id = ?').get(dup).text}"` };
  const a = resolveAssignee(eventId, assignee, userId);
  if (a.error) return a;
  const id = uuidv4();
  db._raw().prepare(`INSERT INTO event_todos (id, event_id, text, assignee_phone, assignee_name, suggested, created_by, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, eventId, t, a.phone, a.name, suggested ? 1 : 0, userId, planDay(userId, eventId, day));
  return { ok: true, todo: view(db._raw().prepare('SELECT * FROM event_todos WHERE id = ?').get(id)) };
}

function own(userId, todoId) {
  const t = db._raw().prepare('SELECT * FROM event_todos WHERE id = ?').get(todoId);
  return t && topics.canSee(userId, t.event_id) ? t : null;
}

/** { done, keep, text, assignee } — any of them. */
function update(userId, todoId, changes) {
  const t = own(userId, todoId);
  if (!t) return { error: 'NOT_FOUND' };
  if (changes.keep) db._raw().prepare('UPDATE event_todos SET suggested = 0 WHERE id = ?').run(t.id);
  if (changes.done === true) db._raw().prepare('UPDATE event_todos SET done_at = ?, done_by = ?, suggested = 0 WHERE id = ?').run(now(), userId, t.id);
  if (changes.done === false) db._raw().prepare('UPDATE event_todos SET done_at = NULL, done_by = NULL WHERE id = ?').run(t.id);
  if (changes.text !== undefined) {
    const txt = String(changes.text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!txt) return { error: 'EMPTY' };
    db._raw().prepare('UPDATE event_todos SET text = ? WHERE id = ?').run(txt, t.id);
  }
  if (changes.assignee !== undefined) {
    const a = resolveAssignee(t.event_id, changes.assignee, userId);
    if (a.error) return a;
    db._raw().prepare('UPDATE event_todos SET assignee_phone = ?, assignee_name = ? WHERE id = ?').run(a.phone, a.name, t.id);
  }
  return { ok: true, todo: view(db._raw().prepare('SELECT * FROM event_todos WHERE id = ?').get(t.id)) };
}

function remove(userId, todoId) {
  const t = own(userId, todoId);
  if (!t) return { error: 'NOT_FOUND' };
  db._raw().prepare('DELETE FROM event_todos WHERE id = ?').run(t.id);
  return { ok: true };
}

/** Open to-dos assigned to this user, on upcoming plans — for Home. */
function mine(userId) {
  const u = db.getUser(userId);
  if (!u?.phone) return [];
  return db._raw().prepare(`SELECT t.*, se.title AS event_title, se.scheduled_at, se.date_tbd FROM event_todos t
    JOIN social_events se ON se.id = t.event_id
    WHERE t.assignee_phone = ? AND t.done_at IS NULL AND t.suggested = 0 AND COALESCE(se.status, 'open') != 'cancelled'
      AND (se.scheduled_at > ? OR se.date_tbd = 1)`).all(u.phone, now() - 86400)
    .filter((t) => topics.canSee(userId, t.event_id));
}

/**
 * Home's "Creating" section (2026-10-12: Sean saw items in the plan's chat but nothing on
 * Home — they were all suggestions, and Home only showed items assigned to him):
 *  - mine: assigned to you · anyone: unassigned, open · suggestions: per plan, awaiting keep.
 */
function forHome(userId) {
  const u = db.getUser(userId);
  if (!u?.phone) return { items: [], suggestions: [] };
  const plans = topics.eventsFor(userId).map((e) => e.id);
  if (!plans.length) return { items: [], suggestions: [] };
  const q = `SELECT t.*, se.title AS event_title, se.scheduled_at, se.date_tbd FROM event_todos t JOIN social_events se ON se.id = t.event_id
    WHERE t.event_id IN (${plans.map(() => '?').join(',')}) AND t.done_at IS NULL AND COALESCE(se.status, 'open') != 'cancelled'`;
  const rows = db._raw().prepare(q).all(...plans);
  const item = (t, who) => ({ todo_id: t.id, event_id: t.event_id, text: view(t).shown, day: t.day || null, title: t.event_title, at: t.date_tbd ? null : t.scheduled_at, who });
  const items = [
    ...rows.filter((t) => !t.suggested && t.assignee_phone === u.phone).map((t) => item(t, 'you')),
    ...rows.filter((t) => !t.suggested && !t.assignee_phone).map((t) => item(t, 'anyone')),
  ];
  const by = new Map();
  for (const t of rows.filter((x) => x.suggested)) {
    const s = by.get(t.event_id) || { event_id: t.event_id, title: t.event_title, count: 0 };
    s.count++; by.set(t.event_id, s);
  }
  return { items, suggestions: [...by.values()] };
}

/** { done, total } of kept to-dos per event id. */
function progressFor(eventIds) {
  const out = {};
  for (const id of eventIds) {
    const r = db._raw().prepare('SELECT count(*) total, sum(done_at IS NOT NULL) done FROM event_todos WHERE event_id = ? AND suggested = 0').get(id);
    if (r.total) out[id] = { done: r.done || 0, total: r.total };
  }
  return out;
}

module.exports = { list, add, update, remove, mine, forHome, members, progressFor, repeats, keyWords };
