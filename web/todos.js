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

/**
 * A Creating item's name is short; what was said is its notes (🐛 #82 — "You put exactly what I said into the title of
 * the list. You should summarize what I say and then you have the details … after I click on it"). A sentence becomes
 * its first clause, without "I need to / we should …": "I need to get the exact paperwork so we can review it together
 * and finish it" → "Get the exact paperwork" + the sentence in notes. Short names are left alone.
 */
const SHORT = 40;
function shortName(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= SHORT && t.split(' ').length <= 6) return { name: t, said: null };
  const lead = /^(ok(ay)?|so|and|also|oh|hey)[, ]|^(i|we|you|someone|somebody)\s+(really\s+)?(need|needs|have|has|want|wants|gotta|should|must|ought|will|'ll|'d like|would like)\b|^(need|have|want|remember|don'?t forget) to\b|^(let'?s|please|can you|could you)\s/i;
  const clause = /\s*(?:[.,;:!?(—–]\s|\s-\s|\s(?:so|so that|because|cause|cuz|since|and then|then|which|when|while|before|after|until|if|but)\s)/i;
  // A name that's just a bit long ("Book massages at Carson City Hot Springs") stays; a sentence is shortened.
  if (!lead.test(t) && !clause.test(t) && t.split(' ').length <= 10) return { name: t, said: null };
  let x = t.replace(/^(ok(ay)?|so|and|also|oh|hey)[, ]+/i, '')
    .replace(/^(i|we|you|someone|somebody)\s+(really\s+)?(need|needs|have|has|want|wants|gotta|should|must|ought|will|'ll|'d like|would like)( to)?\s+/i, '')
    .replace(/^(need|have|want|remember|don'?t forget) to\s+/i, '')
    .replace(/^(let'?s|please|can you|could you)\s+/i, '');
  x = x.split(clause)[0];
  const w = x.split(' ');
  if (w.length > 7) x = w.slice(0, 7).join(' ');
  x = x.replace(/[\s,.;:!?]+$/, '');
  for (let y = ''; y !== x;) { y = x; x = x.replace(/\s+(the|a|an|to|for|of|and|with|at|on|in|my|our|his|her|their|your|about|from|by|some|this|that)$/i, ''); }
  if (!x) x = t.split(' ').slice(0, 5).join(' ');
  return { name: x.charAt(0).toUpperCase() + x.slice(1), said: t };
}
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
function view(t, viewerId = null) {
  const crew = t.id ? team(t.id) : [];
  const me = viewerId ? db.getUser(viewerId)?.phone : null;
  return { id: t.id, text: t.text, day: t.day || null, day_label: t.day ? dayName(t.day) : null,
    shown: t.day ? `${dayName(t.day)}: ${t.text}` : t.text,
    assignee: t.assignee_name ? first(t.assignee_name) : null, assignee_phone: t.assignee_phone,
    lead: t.assignee_name ? first(t.assignee_name) : null, team: crew.map((m) => first(m.name)),
    when_text: t.when_text || null, place: t.place || null, status: t.status || 'idea', notes: t.notes || null,
    // Can this viewer edit it? (on its team) — otherwise their changes are suggestions.
    yours: !!me && crew.some((m) => m.phone === me),
    suggested: !!t.suggested, done: !!t.done_at, together_event_id: t.together_event_id || null };
}

// A day the plan covers, or null (to-dos can't be for a day outside the plan).
/**
 * Which day an item is for (🐛 #89 — Melanie, in her Fri–Sat weekend's discussion on the Friday: "Sean to take boys to
 * press start at 5pm … Allie and Mel will be watching practical magic" → her ButterflAI filed them under Saturday;
 * "not saturday tonight"). With no day in their words: the day they opened the plan from; else, while the plan is
 * happening today, today (not another of its days); else the model's day.
 */
function pickDay({ userId, eventId, modelDay = null, said = '', contextDay = null }) {
  if (require('./datetime').saysDay(said)) return modelDay || contextDay || null;
  if (contextDay) return contextDay;
  const tz = db.getUser(userId)?.timezone || 'America/Los_Angeles';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const p = eventId ? require('./plan').planFor(eventId, userId) : null;
  // The plan is happening today: another of its days, unnamed, is a guess → today. Otherwise the model's day stands
  // (it may come from earlier in the conversation).
  if (p?.days?.includes(today) && (!modelDay || p.days.includes(modelDay))) return today;
  return modelDay || null;
}

function planDay(userId, eventId, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return null;
  const p = require('./plan').planFor(eventId, userId);
  return p && (p.days || []).includes(day) ? day : null;
}

/**
 * Over: its plan is past, or its own day has gone by (Sean, 2026-10-21: "Why do I see lunch with Allie from yesterday on my
 * creating list … I can't turn back time … This should be … constantly updated as … time passes"). Worked out live from
 * the date — nothing to clean up — so the moment a day passes, its items stop being things to do.
 */
function overFor(userId) {
  const tz = db.getUser(userId)?.timezone || 'America/Los_Angeles';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const planOver = new Map();
  return (t) => {
    if (t.day && t.day < today) return true;
    if (!planOver.has(t.event_id)) { let o = false; try { o = require('./plan').planFor(t.event_id, userId)?.stage === 'past'; } catch (_) {} planOver.set(t.event_id, o); }
    return planOver.get(t.event_id);
  };
}

function list(userId, eventId) {
  if (!topics.canSee(userId, eventId)) return { error: 'NOT_IN_PLAN' };
  const rows = db._raw().prepare('SELECT * FROM event_todos WHERE event_id = ? ORDER BY suggested, done_at IS NOT NULL, created_at, rowid').all(eventId);
  const kept = rows.filter((t) => !t.suggested);
  const over = overFor(userId);
  return { todos: rows.map((t) => ({ ...view(t, userId), over: over(t) })), over: rows.length > 0 && rows.every((t) => t.done_at || over(t)), suggestions: require('./suggestions').forPlan(eventId, userId), progress: { done: kept.filter((t) => t.done_at).length, total: kept.length },
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

/**
 * Items have a lead and a team (owner, 2026-10-19): "people can suggest a thing and they
 * would automatically become that lead, but anybody can decide to try to do something about
 * it. And once they start taking action, they can make that edit. But unless they're actively
 * trying to solve a thing, people shouldn't be able to accidentally edit stuff that they're
 * not focusing on."
 *   lead  = assignee (whoever added it, unless they gave it to someone)
 *   team  = the lead + everyone who said "I'm on it" (todo_team)
 * Only the team edits the item (text, when, place, status, notes, done). Anyone else's
 * change becomes a suggestion to the team (suggestions.js) — unless they're taking it on
 * (join: true), which puts them on the team first. ButterflAI's own suggestions (suggested=1)
 * have no lead until someone keeps one; keeping makes them its lead.
 */
function team(todoId) {
  const t = db._raw().prepare('SELECT assignee_phone, assignee_name FROM event_todos WHERE id = ?').get(todoId);
  if (!t) return [];
  const out = t.assignee_phone ? [{ phone: t.assignee_phone, name: t.assignee_name, lead: true }] : [];
  for (const m of db._raw().prepare('SELECT phone, name FROM todo_team WHERE todo_id = ? ORDER BY joined_at').all(todoId)) {
    if (!out.some((x) => x.phone === m.phone)) out.push({ phone: m.phone, name: m.name });
  }
  return out;
}
function onTeam(userId, todoId) {
  const u = db.getUser(userId);
  return !!u?.phone && team(todoId).some((m) => m.phone === u.phone);
}
const canRemove = (userId, t) => t.suggested || onTeam(userId, t.id) || require('./plan').canEdit(t.event_id, userId);

/** "I'm on it": leads it if nobody does, else joins its team. */
function join(userId, todoId) {
  const t = own(userId, todoId);
  if (!t) return { error: 'NOT_FOUND' };
  try { require('./planops').inferInterested(t.event_id, userId, 'you took on part of it'); } catch (_) {}
  const me = members(t.event_id).find((m) => m.phone === db.getUser(userId)?.phone);
  if (!me) return { error: 'NOT_IN_PLAN' };
  if (!t.assignee_phone) db._raw().prepare('UPDATE event_todos SET assignee_phone = ?, assignee_name = ?, suggested = 0 WHERE id = ?').run(me.phone, me.name, t.id);
  else if (t.assignee_phone !== me.phone) db._raw().prepare('INSERT OR IGNORE INTO todo_team (todo_id, phone, name) VALUES (?, ?, ?)').run(t.id, me.phone, me.name);
  return { ok: true, todo: view(db._raw().prepare('SELECT * FROM event_todos WHERE id = ?').get(t.id), userId) };
}
/** Step off it (the lead hands it to the next on the team, or to nobody). */
function leave(userId, todoId) {
  const t = own(userId, todoId);
  if (!t) return { error: 'NOT_FOUND' };
  const phone = db.getUser(userId)?.phone;
  db._raw().prepare('DELETE FROM todo_team WHERE todo_id = ? AND phone = ?').run(t.id, phone);
  if (t.assignee_phone === phone) {
    const next = db._raw().prepare('SELECT phone, name FROM todo_team WHERE todo_id = ? ORDER BY joined_at LIMIT 1').get(t.id);
    db._raw().prepare('UPDATE event_todos SET assignee_phone = ?, assignee_name = ? WHERE id = ?').run(next?.phone || null, next?.name || null, t.id);
    if (next) db._raw().prepare('DELETE FROM todo_team WHERE todo_id = ? AND phone = ?').run(t.id, next.phone);
  }
  return { ok: true };
}

function add(userId, eventId, { text, assignee, suggested = false, day = null, when_text, place, notes }) {
  if (!topics.canSee(userId, eventId)) return { error: 'NOT_IN_PLAN' };
  if (!suggested) { try { require('./planops').inferInterested(eventId, userId, 'you added to what we’re making happen'); } catch (_) {} }
  const sn = shortName(String(text || '').slice(0, MAX_TEXT));
  const t = sn.name;
  if (!t) return { error: 'EMPTY' };
  if (sn.said && !String(notes || '').includes(sn.said)) notes = notes ? `${sn.said} — ${notes}` : sn.said;
  const dup = repeats(eventId, t);
  if (dup) return { error: 'ALREADY_ON_LIST', todo_id: dup, message: `Already on the list: "${db._raw().prepare('SELECT text FROM event_todos WHERE id = ?').get(dup).text}" — add to that item (manage_todos update with its todo_id) instead.` };
  // Whoever suggests a thing leads it, unless they gave it to someone (ButterflAI's own suggestions: nobody yet).
  const a = resolveAssignee(eventId, assignee ?? (suggested ? null : 'me'), userId);
  if (a.error && assignee != null) return a;
  const lead = a.error ? { phone: null, name: null } : a;
  const id = uuidv4();
  db._raw().prepare(`INSERT INTO event_todos (id, event_id, text, assignee_phone, assignee_name, suggested, created_by, day, when_text, place, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, eventId, t, lead.phone, lead.name, suggested ? 1 : 0, userId, planDay(userId, eventId, day), clip(when_text), clip(place), clip(notes, 500));
  return { ok: true, todo: view(db._raw().prepare('SELECT * FROM event_todos WHERE id = ?').get(id), userId) };
}
const clip = (v, n = 120) => (v == null || String(v).trim() === '' ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, n));
const STATUSES = ['idea', 'options', 'chosen', 'booked'];

function own(userId, todoId) {
  const t = db._raw().prepare('SELECT * FROM event_todos WHERE id = ?').get(todoId);
  return t && topics.canSee(userId, t.event_id) ? t : null;
}

/**
 * { done, keep, text, when_text, place, status, notes, day, assignee } — any of them.
 * Only the item's team makes them; anyone else's becomes a suggestion to the team, unless
 * join: true (they're taking it on). decided: applied from an accepted suggestion.
 */
function update(userId, todoId, changes, { join: taking = false, decided = false } = {}) {
  const t = own(userId, todoId);
  if (!t) return { error: 'NOT_FOUND' };
  changes = Object.fromEntries(Object.entries(changes || {}).filter(([, v]) => v !== undefined));
  if (changes.keep && t.suggested) {   // keeping one of ButterflAI's suggestions = suggesting it: you lead it
    join(userId, t.id);
    const { keep, ...rest } = changes;
    if (!Object.keys(rest).length) return { ok: true, todo: view(db._raw().prepare('SELECT * FROM event_todos WHERE id = ?').get(t.id), userId) };
    changes = rest;
  }
  const edits = Object.keys(changes).filter((k) => ['done', 'text', 'when_text', 'place', 'status', 'notes', 'day', 'assignee'].includes(k));
  if (edits.length && !decided && !onTeam(userId, t.id)) {
    const isPlanDecider = require('./plan').canEdit(t.event_id, userId);
    // Nobody leads it yet, or they're taking it on: they join, then edit.
    if (taking || !t.assignee_phone) { const j = join(userId, t.id); if (j.error) return j; }
    // Hosts / co-hosts may (re)assign it.
    else if (!(isPlanDecider && edits.every((k) => k === 'assignee'))) {
      return require('./suggestions').create(userId, t.event_id, Object.fromEntries(edits.map((k) => [k, changes[k]])), { todoId: t.id });
    }
  }
  if (changes.done === true) db._raw().prepare('UPDATE event_todos SET done_at = ?, done_by = ?, suggested = 0 WHERE id = ?').run(now(), userId, t.id);
  if (changes.done === false) db._raw().prepare('UPDATE event_todos SET done_at = NULL, done_by = NULL WHERE id = ?').run(t.id);
  if (changes.text !== undefined) {
    const txt = String(changes.text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!txt) return { error: 'EMPTY' };
    db._raw().prepare('UPDATE event_todos SET text = ? WHERE id = ?').run(txt, t.id);
  }
  for (const k of ['when_text', 'place']) if (changes[k] !== undefined) db._raw().prepare(`UPDATE event_todos SET ${k} = ? WHERE id = ?`).run(clip(changes[k]), t.id);
  if (changes.notes !== undefined) db._raw().prepare('UPDATE event_todos SET notes = ? WHERE id = ?').run(clip(changes.notes, 500), t.id);
  if (changes.status !== undefined) {
    if (!STATUSES.includes(changes.status)) return { error: 'BAD_STATUS', message: `status is one of ${STATUSES.join(', ')}` };
    db._raw().prepare('UPDATE event_todos SET status = ? WHERE id = ?').run(changes.status, t.id);
  }
  if (changes.day !== undefined) db._raw().prepare('UPDATE event_todos SET day = ? WHERE id = ?').run(changes.day ? planDay(userId, t.event_id, changes.day) : null, t.id);
  if (changes.assignee !== undefined) {
    const a = resolveAssignee(t.event_id, changes.assignee, userId);
    if (a.error) return a;
    db._raw().prepare('UPDATE event_todos SET assignee_phone = ?, assignee_name = ? WHERE id = ?').run(a.phone, a.name, t.id);
  }
  return { ok: true, todo: view(db._raw().prepare('SELECT * FROM event_todos WHERE id = ?').get(t.id), userId) };
}

function remove(userId, todoId) {
  const t = own(userId, todoId);
  if (!t) return { error: 'NOT_FOUND' };
  if (!canRemove(userId, t)) return { error: 'NOT_YOURS', message: 'Only whoever is working on it (or the host / co-hosts) can remove it — suggest it instead.' };
  db._raw().prepare('DELETE FROM todo_team WHERE todo_id = ?').run(t.id);
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
    .filter((t) => topics.canSee(userId, t.event_id)).filter((t) => !overFor(userId)(t));
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
  const over = overFor(userId);
  const rows = db._raw().prepare(q).all(...plans).filter((t) => !over(t));   // past days and past plans aren't to-dos any more
  const item = (t, who) => ({ todo_id: t.id, event_id: t.event_id, text: view(t).shown, day: t.day || null, title: t.event_title, at: t.date_tbd ? null : t.scheduled_at, who });
  const items = [
    // Yours: you lead it or you're on its team.
    ...rows.filter((t) => !t.suggested && (t.assignee_phone === u.phone || db._raw().prepare('SELECT 1 FROM todo_team WHERE todo_id = ? AND phone = ?').get(t.id, u.phone))).map((t) => item(t, 'you')),
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

/**
 * 🍻 Do it together (🐛 #44): a Creating item becomes its own small plan — a drink, coffee or a call to
 * figure it out together — with the people involved: whoever else is on the item; if nobody, the plan's
 * host and co-hosts. Tentative, no date yet; you're its host. One per item (asking again opens it).
 */
async function together(userId, todoId) {
  const t = own(userId, todoId);
  if (!t) return { error: 'NOT_FOUND' };
  const me = db.getUser(userId);
  if (!members(t.event_id).some((m) => m.phone === me?.phone)) return { error: 'NOT_IN_PLAN' };
  if (t.together_event_id) {
    const e = db._raw().prepare("SELECT id FROM social_events WHERE id = ? AND COALESCE(status, 'open') != 'cancelled'").get(t.together_event_id);
    if (e) return { ok: true, event_id: e.id, existing: true };
  }
  const parent = db._raw().prepare('SELECT title FROM social_events WHERE id = ?').get(t.event_id);
  let people = team(t.id).filter((m) => m.phone !== me.phone);
  if (!people.length) {
    people = require('./suggestions').deciders(t.event_id).filter((u) => u !== userId).map((u) => db.getUser(u)).filter(Boolean)
      .map((u) => ({ phone: u.phone, name: members(t.event_id).find((m) => m.phone === u.phone)?.name || u.name }));
  }
  const contactIds = people.slice(0, 6).map((p) => db._raw().prepare('SELECT id FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(userId, p.phone)?.id
    || db.upsertContact({ invited_by_user_id: userId, name: p.name, phone: p.phone, tier: 1 }));
  const title = `${t.text} — together`.slice(0, 80);
  const r = await require('./planops').create(userId, { title, activity_type: 'hangout', tentative: true,
    notes: `To figure out “${t.text}” for ${parent?.title || 'the plan'} together — over a drink, coffee or a call.`, contact_ids: contactIds }, { via: 'app' });
  const eventId = r.eventId || null;
  if (!eventId) return { error: r.error || 'NOT_CREATED', message: r.message };
  db._raw().prepare('UPDATE event_todos SET together_event_id = ? WHERE id = ?').run(eventId, t.id);
  return { ok: true, event_id: eventId, with: people.slice(0, 6).map((p) => first(p.name)) };
}

module.exports = { pickDay, shortName, together, list, add, update, remove, join, leave, team, onTeam, mine, forHome, members, progressFor, repeats, keyWords, STATUSES };
