/**
 * understand.js — what did they ask for? Decided before the agent replies.
 *
 * Owner, 2026-10-14: "we need to somehow map people's conversation into actions in a more
 * consistent way." Until now the reply model read a message, chose tools and wrote the
 * reply in one go, and code caught known misreadings afterwards (ACTION_CLAIMS, the idea
 * guard, actioncheck, plansync…). Each new misreading got through until it had a guard.
 * 🐛 #19: Melanie asked for massage places and got two clarifying questions.
 *
 * Now every user message is read first into a short list of typed actions, each quoting
 * the words it came from:
 *   add_todo      an idea / thing to do for a plan            → applied in code (todos.js)
 *   rsvp          going / interested / not going              → applied in code (planops.respond)
 *   set_details   date, proposed dates, place, length (host)  → applied in code (planops.update)
 *   lock_in       the host makes it final                     → applied in code (planops.update)
 *   find_options  "find me massage places"                    → the agent must search and list options
 *   message       tell / ask someone                          → the agent does it (approval rules stay)
 *   cancel        cancel a plan                               → the agent confirms first
 * Code decides each one: no quote from their words → dropped; a plan they're not in, or a
 * different plan than the discussion they're in without naming it → dropped; host-only
 * changes from a guest → dropped; unsure → one question with the choices. What was applied
 * shows under their message as a chip ("✓ Massage · Fri · Undo"); an undo or a change is a
 * labelled correction (kept 90 days) for the eval set (tests/eval-understand.js).
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { createAnthropicClient, DEFAULT_MODEL } = require('./anthropic-client');

let _client = null;
let _enabled = process.env.NODE_ENV !== 'test';
function _setClient(c) { _client = c; _enabled = !!c; }
function client() {
  if (!_enabled) return null;
  if (!_client) { try { _client = createAnthropicClient(); } catch (_) { _enabled = false; return null; } }
  return _client;
}

const KINDS = ['add_todo', 'update_item', 'rsvp', 'set_details', 'lock_in', 'find_options', 'message', 'cancel'];
const APPLIED_KINDS = new Set(['add_todo', 'update_item', 'rsvp', 'set_details', 'lock_in']);
const APPLY_AT = 0.75;   // at or above: done in code
const ASK_AT = 0.5;      // between: one question with the choices
const KEEP_DAYS = 90;

const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
/** The quote must be their own words (a small slip in punctuation is fine). */
function quoted(text, quote) {
  const q = norm(quote).replace(/[^a-z0-9' ]/g, '');
  const t = norm(text).replace(/[^a-z0-9' ]/g, '');
  return q.length >= 2 && t.includes(q);
}

function fmtDay(d) { return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }); }

/** What the model sees: the message, the plan they're in, their plans, recent chat. */
function contextFor(userId, { eventId, contextDay }) {
  const plan = require('./plan');
  const plans = plan.plansFor(userId).slice(0, 12);
  const here = eventId ? plans.find((p) => p.id === eventId) || plan.planFor(eventId, userId) : null;
  const line = (p) => `- eventId="${p.id}" "${p.title}" — you're ${p.role === 'host' ? 'the host' : p.my_role === 'cohost' ? 'a co-host' : `a guest (${p.invitation?.going ? 'going' : p.invitation?.status === 'accepted' ? 'interested' : p.invitation?.status || 'invited'})`}; ${p.dates?.label || 'date TBD'}${p.days?.length ? ` (days: ${p.days.join(', ')})` : ''}${p.place ? `; at ${p.place}` : ''}${p.tentative ? '; tentative' : ''}`;
  const recent = db._raw().prepare(`SELECT role, text FROM conversation_history WHERE user_id = ? AND private_ct IS NULL ${eventId ? 'AND event_id = ?' : ''}
    ORDER BY created_at DESC, rowid DESC LIMIT 6`).all(...(eventId ? [userId, eventId] : [userId])).reverse()
    .map((m) => `${m.role === 'user' ? 'Them' : 'ButterflAI'}: ${String(m.text).slice(0, 300)}`);
  let creating = [];
  if (here) creating = db._raw().prepare('SELECT id, text, day, when_text, place, status, assignee_name FROM event_todos WHERE event_id = ? AND done_at IS NULL').all(here.id)
    .map((t) => `\n  - item_id="${t.id}" ${t.day ? fmtDay(t.day) + ': ' : ''}${t.text}${t.when_text ? ` | when: ${t.when_text}` : ''}${t.place ? ` | place: ${t.place}` : ''} | ${t.status || 'idea'}${t.assignee_name ? ` | led by ${String(t.assignee_name).split(' ')[0]}` : ''}`);
  return { plans, here, text: [
    here ? `They are in the discussion of: ${line(here)}${contextDay ? `\nThey opened it from the calendar day ${contextDay} (${fmtDay(contextDay)}).` : ''}\nIts Creating list:${creating.join('') || ' empty'}` : 'They are in their general chat (not a plan\'s discussion).',
    `Their plans:\n${plans.map(line).join('\n') || '(none)'}`,
    recent.length ? `Recent messages:\n${recent.join('\n')}` : '',
  ].filter(Boolean).join('\n\n') };
}

const PROMPT = `You turn one message a person sent their planning assistant (ButterflAI) into the actions it asks for. Read it like a friend would; don't add anything they didn't say.

Kinds:
- add_todo {event_id, text, day?}: a NEW idea or thing to do/bring for a plan ("thinking about getting a massage", "someone should bring chairs"). text = a short item ("Massage"). day only if they named one or opened the plan from a day. If it's already on the Creating list, use update_item instead.
- update_item {item_id, when_text?, place?, status?: "idea"|"options"|"chosen"|"booked", notes?, taking_on?}: more about an item already on the Creating list ("massages before 3pm" → when_text "before 3pm"; "let's do the spa at the hot springs" → place). taking_on: true only if they say they're doing it themselves ("I'll book the massages", "I'm calling the spa").
- rsvp {event_id, answer: "going"|"interested"|"declined"}: their own answer to a plan they're invited to. "I'm going"/"count me in" = going; "sounds fun, maybe"/"I'm interested" = interested.
- set_details {event_id, when?, proposed_dates?: [{from,to}], venue_name?, duration_mins?}: the HOST deciding details. when = their words for a single date/time ("Friday Oct 23 at noon"). Not options still being discussed.
- lock_in {event_id}: the host making it final.
- find_options {event_id?, what, near?}: they want suggestions or places looked up ("find massage places", "any good spas near there?", "what's open late"). The assistant should search and list options — don't treat it as a question to them.
- message {who, gist}: tell or ask a specific person something.
- cancel {event_id}: cancel a plan.

Rules:
- Every action needs "quote": the exact words of THEIR message it comes from. No quote → no action.
- A question they ask is not a decision. "How much is a cabin? probably need to reschedule" is NOT set_details.
- In a plan's discussion, what they say is about that plan unless they name another.
- confidence 0–1. If two readings are plausible, give your best with lower confidence and "ask": one short question with the choices (e.g. "Going, or just interested?").
- Nothing actionable (thanks, chit-chat, a question about their plans) → no actions.

Reply with JSON only: {"actions":[{"kind":"add_todo","event_id":"…","text":"Massage","day":"2026-10-23","quote":"thinking about getting a massage","confidence":0.9}]}`;

/** The model's reading of one message. Returns raw actions ([] if no model). */
async function extract({ userText, context, today }) {
  const c = client();
  if (!c || !String(userText || '').trim()) return [];
  const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: 500, system: PROMPT, messages: [{ role: 'user', content:
    `Today is ${today}.\n\n${context}\n\nTheir message:\n"""${String(userText).slice(0, 1500)}"""` }] });
  try {
    const j = JSON.parse(String((r.content || []).map((b) => b.text || '').join('')).match(/\{[\s\S]*\}/)[0]);
    return (Array.isArray(j.actions) ? j.actions : []).filter((a) => a && KINDS.includes(a.kind)).slice(0, 6);
  } catch (_) { return []; }
}

/**
 * Code decides what happens to each action. Returns them with a `decision`:
 * apply | ask | agent (the agent does it) | drop, and `why` when dropped.
 */
function decide(actions, { userId, userText, eventId, plans, isNamed }) {
  const byId = new Map(plans.map((p) => [p.id, p]));
  return actions.map((a) => {
    const out = { ...a, confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)) };
    if (!quoted(userText, a.quote)) return { ...out, decision: 'drop', why: 'not in their words' };
    if (a.kind === 'update_item') {
      const it = db._raw().prepare('SELECT event_id FROM event_todos WHERE id = ?').get(a.item_id);
      if (!it) return { ...out, decision: 'drop', why: 'no such item' };
      out.event_id = a.event_id = it.event_id;
    }
    if (a.event_id && !byId.has(a.event_id)) return { ...out, decision: 'drop', why: 'not one of their plans' };
    // In a plan's discussion: another plan only if they named it (MEMORY.md §22).
    if (a.event_id && eventId && a.event_id !== eventId && !isNamed(userText, byId.get(a.event_id).title)) {
      return { ...out, decision: 'drop', why: 'a different plan than this discussion' };
    }
    if (!a.event_id && eventId && ['add_todo', 'rsvp', 'set_details', 'lock_in', 'cancel'].includes(a.kind) && byId.has(eventId)) out.event_id = eventId;
    const p = out.event_id ? byId.get(out.event_id) : null;
    if (['add_todo', 'update_item', 'rsvp', 'set_details', 'lock_in', 'cancel'].includes(a.kind) && !p) return { ...out, decision: 'drop', why: 'no plan' };
    // Guests suggest, hosts and co-hosts decide (2026-10-19): a guest's set_details / lock_in
    // still "applies" — planops turns it into a suggestion. Only the host cancels.
    if (a.kind === 'cancel' && p.role !== 'host') return { ...out, decision: 'agent', why: 'only the host can cancel' };
    if (a.kind === 'rsvp' && (p.role !== 'guest' || !['going', 'interested', 'declined'].includes(a.answer))) return { ...out, decision: 'drop', why: 'not an answer they can give' };
    if (a.kind === 'add_todo' && !String(a.text || '').trim()) return { ...out, decision: 'drop', why: 'no item' };
    if (a.kind === 'lock_in' && !(p.dates?.kind === 'set' || (p.dates?.kind === 'proposed' && p.dates.proposals.length === 1))) return { ...out, decision: 'agent', why: 'no date set yet' };
    if (!APPLIED_KINDS.has(a.kind)) return { ...out, decision: 'agent' };
    if (out.confidence >= APPLY_AT) return { ...out, decision: 'apply' };
    if (out.confidence >= ASK_AT && a.ask) return { ...out, decision: 'ask' };
    return { ...out, decision: 'drop', why: 'unsure' };
  });
}

function record(userId, msg, a, fields) {
  const id = uuidv4();
  db._raw().prepare(`INSERT INTO understood (id, user_id, msg_id, history_id, event_id, kind, quote, payload_json, decision, status, ref, label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, msg.id || null, msg.history_id || null, a.event_id || null, a.kind, String(a.quote || '').slice(0, 300),
    JSON.stringify(a).slice(0, 2000), a.decision, fields.status || a.decision, fields.ref || null, fields.label || null);
  return id;
}

/** Apply one action through the one door for it. Returns { ok, label, ref, toolLog } or { error }. */
function applyOne(userId, a, { contextDay }) {
  const planops = require('./planops');
  const todos = require('./todos');
  const title = db._raw().prepare('SELECT title FROM social_events WHERE id = ?').get(a.event_id)?.title || 'the plan';
  if (a.kind === 'add_todo') {
    const named = a.day && /^\d{4}-\d{2}-\d{2}$/.test(a.day) ? a.day : null;
    const r = todos.add(userId, a.event_id, { text: a.text, day: named || contextDay || null });
    if (r.error === 'ALREADY_ON_LIST') return { error: r.error };
    if (r.error) return r;
    return { ok: true, ref: r.todo.id, label: `${r.todo.text}${r.todo.day ? ' · ' + fmtDay(r.todo.day) : ''} → Creating`,
      toolLog: { name: 'manage_todos', input: { event_id: a.event_id, action: 'add', items: [r.todo.text], day: r.todo.day }, result: { added: [r.todo.text] } } };
  }
  if (a.kind === 'update_item') {
    const changes = {};
    for (const k of ['when_text', 'place', 'notes']) if (a[k]) changes[k] = String(a[k]);
    if (['idea', 'options', 'chosen', 'booked'].includes(a.status)) changes.status = a.status;
    if (!Object.keys(changes).length && !a.taking_on) return { error: 'NOTHING' };
    const before = db._raw().prepare('SELECT when_text, place, notes, status FROM event_todos WHERE id = ?').get(a.item_id) || {};
    const r = Object.keys(changes).length ? todos.update(userId, a.item_id, changes, { join: true })   /* their own words about the item = taking action (🐛 #75) */ : todos.join(userId, a.item_id);
    if (r.error) return r;
    const item = db._raw().prepare('SELECT text FROM event_todos WHERE id = ?').get(a.item_id)?.text || 'item';
    if (r.suggested) return suggestedResult(r, item, a);
    const what = Object.entries(changes).map(([k, v]) => (k === 'status' ? v : k === 'when_text' ? v : k === 'place' ? `at ${v}` : 'notes')).join(', ');
    return { ok: true, ref: JSON.stringify({ item: a.item_id, before: Object.fromEntries(Object.keys(changes).map((k) => [k, before[k] ?? (k === 'status' ? 'idea' : '')])) }), label: `${item}${what ? ': ' + what : ''}${a.taking_on ? ' · you\'re on it' : ''}`,
      toolLog: { name: 'manage_todos', input: { event_id: a.event_id, action: 'update', todo_id: a.item_id, ...changes }, result: r } };
  }
  if (a.kind === 'rsvp') {
    const u = db.getUser(userId);
    const inv = db._raw().prepare(`SELECT ei.id, ei.status, ei.going FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?`).get(a.event_id, u.phone);
    if (!inv) return { error: 'NOT_INVITED' };
    const status = a.answer === 'declined' ? 'declined' : 'accepted';
    const r = planops.respond(inv.id, status, { by: 'guest', phone: u.phone, userId, via: 'understood', going: status === 'accepted' ? a.answer === 'going' : undefined });
    if (!r.ok) return { error: r.error };
    const word = { going: 'Going', interested: 'Interested', declined: 'Not going' }[a.answer];
    return { ok: true, ref: inv.id, label: `${word} · ${title}`,
      toolLog: { name: 'confirm_coordination_invite', input: { invitation_id: inv.id, status, going: a.answer === 'going' }, result: { action_status: 'RSVP_CONFIRMED', rsvp_status: status } } };
  }
  if (a.kind === 'set_details' || a.kind === 'lock_in') {
    const changes = a.kind === 'lock_in' ? { tentative: false } : {};
    if (a.kind === 'set_details') {
      if (a.when) changes.when = String(a.when);
      if (Array.isArray(a.proposed_dates) && a.proposed_dates.length && !a.when) changes.proposed_dates = a.proposed_dates;
      if (a.venue_name) changes.venue_name = String(a.venue_name).slice(0, 120);
      if (Number(a.duration_mins) > 0) changes.duration_mins = Number(a.duration_mins);
      if (!Object.keys(changes).length) return { error: 'NOTHING' };
    }
    const r = planops.update(userId, a.event_id, changes, { via: 'understood' });
    if (r.error) return r;
    if (r.suggested) return suggestedResult(r, title, a);
    if (!r.updated?.length) return { error: 'NOTHING_CHANGED' };
    const at = db._raw().prepare('SELECT max(created_at) at FROM plan_changes WHERE event_id = ? AND via = ?').get(a.event_id, 'understood').at;
    const what = a.kind === 'lock_in' ? 'Locked in' : [changes.when && 'date', changes.proposed_dates && 'proposed dates', changes.venue_name && `place: ${changes.venue_name}`, changes.duration_mins && 'length'].filter(Boolean).join(', ');
    return { ok: true, ref: String(at), label: `${a.kind === 'lock_in' ? what : 'Saved ' + what} · ${title}`,
      toolLog: { name: 'update_event', input: { event_id: a.event_id, ...changes }, result: r } };
  }
  return { error: 'UNKNOWN' };
}

/** A guest's change went to the deciders as a suggestion (suggestions.js) — the chip says so; Undo withdraws it. */
function suggestedResult(r, what, a) {
  return { ok: true, ref: `suggestion:${r.suggestion_id}`, label: `Suggested to ${r.to.join(' & ') || 'the host'}: ${r.summary} (${what})`,
    toolLog: { name: a.kind === 'update_item' ? 'manage_todos' : 'update_event', input: { event_id: a.event_id }, result: { suggested: true, message: r.message } } };
}

/**
 * Read a user's message and act on it. Called by the agent before it replies.
 * @returns {{ applied: object[], asks: object[], agent: object[], toolLog: object[], note: string }}
 */
async function run({ userId, msg, isNamed }) {
  const empty = { applied: [], asks: [], agent: [], toolLog: [], note: '' };
  if (!client()) return empty;
  const eventId = msg.event_id && msg.event_id !== 'general' ? msg.event_id : null;
  const ctx = contextFor(userId, { eventId, contextDay: msg.context_day || null });
  const tz = db.getUser(userId)?.timezone || 'America/Los_Angeles';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  let raw;
  try { raw = await extract({ userText: msg.text, context: ctx.text, today }); } catch (err) { console.warn('[understand]', err.message); return empty; }
  const decided = decide(raw, { userId, userText: msg.text, eventId, plans: ctx.plans, isNamed });
  const out = { ...empty };
  for (const a of decided) {
    if (a.decision === 'apply') {
      const r = applyOne(userId, a, { contextDay: msg.context_day || null });
      if (r.ok) {
        const id = record(userId, msg, a, { status: 'applied', ref: r.ref, label: r.label });
        out.applied.push({ id, kind: a.kind, label: r.label, event_id: a.event_id });
        out.toolLog.push({ ...r.toolLog, by: 'understood' });
      } else {
        record(userId, msg, { ...a, decision: 'drop' }, { status: 'failed', label: r.error });
      }
    } else if (a.decision === 'ask') {
      record(userId, msg, a, { status: 'asked' });
      out.asks.push({ kind: a.kind, ask: String(a.ask).slice(0, 200) });
    } else if (a.decision === 'agent') {
      record(userId, msg, a, { status: 'agent' });
      out.agent.push(a);
    } else {
      record(userId, msg, a, { status: 'dropped', label: a.why });
    }
  }
  out.note = noteFor(out);
  return out;
}

/** What the reply model is told about this message (added to it, not shown to anyone). */
function noteFor({ applied, asks, agent }) {
  const lines = [];
  if (applied.length) lines.push(`Already done in code for the message above — don't do these again; confirm them in a few words: ${applied.map((a) => `✓ ${a.label}`).join('; ')}.`);
  for (const a of agent) {
    if (a.kind === 'find_options') lines.push(`They want options: ${a.what}${a.near ? ` near ${a.near}` : ''}. Search the web now and list 3–5 real options with links (and anything that matters: price, hours). Don't ask clarifying questions first — give options, then ask if they want any changes.`);
    else if (a.kind === 'message') lines.push(`They want you to message ${a.who}: ${a.gist}. Do it with the usual tools and rules.`);
    else if (a.kind === 'cancel') lines.push(`They want to cancel ${a.event_id ? `eventId="${a.event_id}"` : 'a plan'}. Confirm once, then update_event cancel.`);
    else if (a.why === 'say yes first') lines.push(`They want to change a plan they haven't said yes to (${a.kind}). Offer to mark them as in (then they can change it), or to pass it on to the host.`);
    else if (a.why === 'only the host can cancel') lines.push('They want to cancel a plan someone else hosts. Only the host can cancel — offer to tell the host, or to take them off it (decline).');
    else if (a.why === 'no date set yet') lines.push('They want to lock in a plan that has no date yet — ask which date.');
  }
  for (const q of asks) lines.push(`Ask them exactly one short question: ${q.ask}`);
  return lines.length ? `[ButterflAI — not from the user]\n${lines.join('\n')}` : '';
}

/** Chips for the user's chat rows (by conversation_history id). */
function chipsForMessages(userId, historyIds) {
  if (!historyIds.length) return new Map();
  const rows = db._raw().prepare(`SELECT id, history_id, kind, label, status, event_id FROM understood WHERE user_id = ? AND history_id IN (${historyIds.map(() => '?').join(',')})
    AND status IN ('applied', 'undone', 'corrected') ORDER BY created_at`).all(userId, ...historyIds);
  const m = new Map();
  for (const r of rows) { if (!m.has(r.history_id)) m.set(r.history_id, []); m.get(r.history_id).push(view(r)); }
  return m;
}
const view = (r) => ({ id: r.id, kind: r.kind, label: r.label, status: r.status, event_id: r.event_id });

/**
 * Undo (or change) something done for the user. A correction is kept as a label for the
 * eval set. rsvp takes `answer` (going | interested | declined): changing it is the undo.
 */
function undo(userId, id, { answer } = {}) {
  const r = db._raw().prepare('SELECT * FROM understood WHERE id = ? AND user_id = ?').get(id, userId);
  if (!r) return { error: 'NOT_FOUND' };
  if (r.status !== 'applied' && !(r.kind === 'rsvp' && r.status === 'corrected')) return { error: 'ALREADY_UNDONE' };
  const planops = require('./planops');
  let res;
  if (String(r.ref || '').startsWith('suggestion:')) res = require('./suggestions').withdraw(userId, r.ref.slice(11));
  else if (r.kind === 'add_todo') res = require('./todos').remove(userId, r.ref);
  else if (r.kind === 'update_item') { const x = JSON.parse(r.ref); res = require('./todos').update(userId, x.item, x.before, { decided: true }); }
  else if (r.kind === 'rsvp') {
    if (!['going', 'interested', 'declined'].includes(answer)) return { error: 'ANSWER_REQUIRED' };
    const u = db.getUser(userId);
    const status = answer === 'declined' ? 'declined' : 'accepted';
    res = planops.respond(r.ref, status, { by: 'guest', phone: u.phone, userId, via: 'app', going: status === 'accepted' ? answer === 'going' : undefined });
  } else res = planops.revert(userId, r.event_id, { at: Number(r.ref), via: 'undo' });
  if (res?.error || res?.ok === false) return { error: res.error || 'FAILED' };
  const status = r.kind === 'rsvp' ? 'corrected' : 'undone';
  const label = r.kind === 'rsvp' ? `${{ going: 'Going', interested: 'Interested', declined: 'Not going' }[answer]} · ${r.label.split(' · ').slice(1).join(' · ')}` : r.label;
  db._raw().prepare("UPDATE understood SET status = ?, correction = ?, label = ?, corrected_at = strftime('%s','now') WHERE id = ?")
    .run(status, answer || 'undo', label, id);
  return { ok: true, chip: view({ ...r, status, label }) };
}

/** Corrections (for the admin and the eval set). */
function corrections(limit = 100) {
  return db._raw().prepare(`SELECT u.id, u.kind, u.quote, u.payload_json, u.status, u.correction, u.label, u.created_at, im.text AS message
    FROM understood u LEFT JOIN inbound_messages im ON im.id = u.msg_id WHERE u.status IN ('undone', 'corrected') ORDER BY u.created_at DESC LIMIT ?`).all(limit);
}

/** Kept 90 days (they hold people's words). */
function purgeOld({ days = KEEP_DAYS } = {}) {
  return db._raw().prepare("DELETE FROM understood WHERE created_at < strftime('%s','now') - ?").run(days * 86400).changes;
}

module.exports = { run, extract, decide, noteFor, quoted, chipsForMessages, undo, corrections, purgeOld, contextFor, PROMPT, KINDS, _setClient };
