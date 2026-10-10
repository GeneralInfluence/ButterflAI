/**
 * topics.js — which event (plan, trip) each chat message belongs to, so the chat can be
 * filtered to one discussion (owner, 2026-10-09: "if I'm talking with these groups about
 * a particular event, it should filter out any other side things I might have done").
 *
 *  - In code: a turn whose tools work on exactly one event is tagged with it.
 *  - Otherwise, a small model call matches the turn to one of the user's current events
 *    (or none) — follow-ups like "who said anything about a heated shift pod?".
 *  - Older messages are sorted once per discussion, the first time it is opened.
 * Messages are only ever tagged with events the user hosts or is invited to.
 */
'use strict';

const db = require('./db');
const { createAnthropicClient, DEFAULT_MODEL } = require('./anthropic-client');

const now = () => Math.floor(Date.now() / 1000);
const BACKFILL_DAYS = 14;
const BACKFILL_MAX = 120;

// Model calls are off in tests unless a test injects a client (no billed calls in tests).
let _client = null;
let _enabled = process.env.NODE_ENV !== 'test';
function _setClient(c) { _client = c; _enabled = !!c; }
function client() {
  if (!_enabled) return null;
  if (!_client) { try { _client = createAnthropicClient(); } catch (_) { _enabled = false; return null; } }
  return _client;
}

/** Events this user hosts or was invited to, from a week ago to 90 days out. */
function eventsFor(userId) {
  const user = db.getUser(userId);
  const t = now();
  return db._raw().prepare(`
    SELECT DISTINCT se.id, se.title, se.scheduled_at FROM social_events se
    LEFT JOIN event_invitations ei ON ei.event_id = se.id
    LEFT JOIN contacts c ON c.id = ei.contact_id
    WHERE COALESCE(se.status, 'open') != 'cancelled'
      AND (se.host_user_id = ? OR (c.phone = ? AND ei.status != 'declined'))
      AND se.scheduled_at BETWEEN ? AND ?
    ORDER BY se.scheduled_at`).all(userId, user?.phone || '', t - 7 * 86400, t + 90 * 86400);
}

/**
 * The plan pills along the top of chat: upcoming plans (yours and ones you're invited
 * to) plus any plan discussed in the last 30 days. Most recently active first, then soonest.
 */
function discussionsFor(userId) {
  const t = now();
  const byId = new Map(eventsFor(userId).map((e) => [e.id, { ...e, messages: 0, last_at: 0 }]));
  const talked = db._raw().prepare(`SELECT event_id, count(*) n, max(created_at) last_at FROM conversation_history
    WHERE user_id = ? AND event_id IS NOT NULL AND created_at > ? GROUP BY event_id`).all(userId, t - 30 * 86400);
  for (const r of talked) {
    if (!byId.has(r.event_id)) {
      if (!canSee(userId, r.event_id)) continue;
      const e = db._raw().prepare(`SELECT id, title, scheduled_at FROM social_events WHERE id = ? AND COALESCE(status, 'open') != 'cancelled'`).get(r.event_id);
      if (!e) continue;
      byId.set(e.id, { ...e, messages: 0, last_at: 0 });
    }
    Object.assign(byId.get(r.event_id), { messages: r.n, last_at: r.last_at });
  }
  return [...byId.values()].map((e) => {
    const x = db._raw().prepare('SELECT tentative, host_user_id FROM social_events WHERE id = ?').get(e.id);
    return { event_id: e.id, title: e.title, scheduled_at: e.scheduled_at, tentative: !!x?.tentative, messages: e.messages, last_at: e.last_at || null,
      can_rename: x?.host_user_id === userId };   // the host renames a plan for everyone
  }).sort((a, b) => (b.last_at || 0) - (a.last_at || 0) || a.scheduled_at - b.scheduled_at);
}

/** May this user see this event's discussion? (host or invited) */
function canSee(userId, eventId) {
  const user = db.getUser(userId);
  if (!user || !eventId) return false;
  return !!db._raw().prepare(`
    SELECT 1 FROM social_events se WHERE se.id = ? AND (se.host_user_id = ? OR EXISTS (
      SELECT 1 FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
      WHERE ei.event_id = se.id AND c.phone = ?))`).get(eventId, userId, user.phone);
}

/** Event ids a turn's tools worked on (only ones this user can see). */
function eventsTouched(userId, toolLog) {
  const ids = new Set();
  for (const { name, input = {}, result = {} } of toolLog) {
    if (result?.error) continue;
    if (name === 'create_social_event' && result.eventId) ids.add(result.eventId);
    if (['update_event', 'record_rsvp', 'get_event_rsvp_status', 'message_agent'].includes(name) && input.event_id) ids.add(input.event_id);
    if (name === 'confirm_coordination_invite' && input.invitation_id) {
      const r = db._raw().prepare('SELECT event_id FROM event_invitations WHERE id = ?').get(input.invitation_id);
      if (r) ids.add(r.event_id);
    }
    if (name === 'tell_my_user' && result.event_id) ids.add(result.event_id);
  }
  return [...ids].filter((id) => canSee(userId, id));
}

/** Tag this user's untagged chat rows written since `sinceTs`. */
function tagSince(userId, sinceTs, eventId) {
  return db._raw().prepare(`UPDATE conversation_history SET event_id = ?
    WHERE user_id = ? AND created_at >= ? AND event_id IS NULL`).run(eventId, userId, sinceTs).changes;
}

async function ask(prompt, maxTokens) {
  const c = client();
  if (!c) return null;
  const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
  return (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

const list = (events) => events.map((e, i) => `${i + 1}. ${e.title} (${new Date(e.scheduled_at * 1000).toISOString().slice(0, 10)})`).join('\n');

/**
 * After a turn: tag it. Tools that worked on one event decide; otherwise ask the model
 * which of the user's events (if any) the exchange was about. Never throws.
 */
async function tagTurn({ userId, sinceTs, toolLog, userText, replyText, isPrivate, eventId = null }) {
  try {
    // Sent from inside a plan's discussion: it belongs there.
    if (eventId && canSee(userId, eventId)) return tagSince(userId, sinceTs, eventId);
    const touched = eventsTouched(userId, toolLog || []);
    if (touched.length === 1) return tagSince(userId, sinceTs, touched[0]);
    if (touched.length > 1 || isPrivate) return 0;
    const events = eventsFor(userId);
    if (!events.length || !userText) return 0;
    const out = await ask(
      `A person is chatting with their assistant. Their current plans:\n${list(events)}\n\n`
      + `Person: ${String(userText).slice(0, 600)}\nAssistant: ${String(replyText || '').slice(0, 600)}\n\n`
      + 'Which plan is this exchange about? Answer with just the number, or 0 if none or unclear.', 5);
    const n = parseInt(out, 10);
    return n >= 1 && n <= events.length ? tagSince(userId, sinceTs, events[n - 1].id) : 0;
  } catch (err) {
    console.error('[topics] tagTurn failed:', err.message);
    return 0;
  }
}

/** Sort recent untagged messages into this discussion — once per (user, event). */
async function backfill(userId, eventId) {
  try {
    if (!canSee(userId, eventId)) return 0;
    if (db._raw().prepare('SELECT 1 FROM chat_topic_backfill WHERE user_id = ? AND event_id = ?').get(userId, eventId)) return 0;
    const event = db._raw().prepare('SELECT title, scheduled_at FROM social_events WHERE id = ?').get(eventId);
    const rows = db._raw().prepare(`SELECT id, role, text FROM conversation_history
      WHERE user_id = ? AND event_id IS NULL AND private_ct IS NULL AND created_at > ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(userId, now() - BACKFILL_DAYS * 86400, BACKFILL_MAX).reverse();
    if (!client()) return 0;   // no model available: try again next time
    let tagged = 0;
    if (rows.length) {
      const out = await ask(
        `Plan: "${event.title}" (${new Date(event.scheduled_at * 1000).toISOString().slice(0, 10)}).\n`
        + 'Below are chat messages between a person and their assistant. List the numbers of the messages that are '
        + 'part of the discussion about THIS plan (including follow-ups about it). Answer with comma-separated numbers only, or "none".\n\n'
        + rows.map((r, i) => `${i + 1}. [${r.role}] ${String(r.text).replace(/\s+/g, ' ').slice(0, 240)}`).join('\n'), 400);
      const nums = [...new Set((out || '').match(/\d+/g) || [])].map(Number).filter((n) => n >= 1 && n <= rows.length);
      const set = db._raw().prepare('UPDATE conversation_history SET event_id = ? WHERE id = ? AND event_id IS NULL');
      for (const n of nums) tagged += set.run(eventId, rows[n - 1].id).changes;
    }
    db._raw().prepare('INSERT OR IGNORE INTO chat_topic_backfill (user_id, event_id) VALUES (?, ?)').run(userId, eventId);
    return tagged;
  } catch (err) {
    console.error('[topics] backfill failed:', err.message);
    return 0;
  }
}

module.exports = { discussionsFor, eventsFor, canSee, eventsTouched, tagSince, tagTurn, backfill, _setClient };
