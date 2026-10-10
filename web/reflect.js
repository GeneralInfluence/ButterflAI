/**
 * reflect.js — the agent looks back at a conversation once it goes quiet.
 *
 * Owner, 2026-10-09 (after Melanie's "how much is a cabin? probably need to reschedule"
 * was passed on as a decision): "there's always going to be something… I'd rather the
 * ButterflAI come back and say: I said this, but maybe I got it wrong — perhaps you
 * meant that. Not right away; later, once the conversation dies down and it has a
 * chance to reflect."
 *
 * The in-turn guards catch known failure patterns; this catches the rest:
 *  - When: a stretch of conversation where the agent acted for its user (sent or passed
 *    something on) has been quiet QUIET_MINS. Not in quiet hours (9pm–8am, user's time),
 *    at most one follow-up a day, each stretch reviewed once.
 *  - What: a short model review — did it misread them, drop a question, state something
 *    more firmly than they did, or leave them without what they asked for?
 *  - Only if fairly sure (MIN_CONFIDENCE) does it ask: a friendly check-in in the app
 *    (push, never a text — it isn't urgent). If they correct it, the agent fixes it with
 *    the other side (prompt rule REFLECTION FOLLOW-UPS).
 *  - What it noticed is kept for opted-in test users only (admin review); for everyone
 *    else only the outcome is recorded.
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const sse = require('./sse');
const push = require('./push');
const { createAnthropicClient, DEFAULT_MODEL } = require('./anthropic-client');

const QUIET_MINS = 45;
const LOOKBACK_HOURS = 24;
const MIN_CONFIDENCE = 0.7;
const MAX_PER_TICK = 5;
const now = () => Math.floor(Date.now() / 1000);

let _client = null;
let _enabled = process.env.NODE_ENV !== 'test';
function _setClient(c) { _client = c; _enabled = !!c; }
function client() {
  if (!_enabled) return null;
  if (!_client) { try { _client = createAnthropicClient(); } catch (_) { _enabled = false; return null; } }
  return _client;
}

function localHour(user) {
  try { return Number(new Date().toLocaleString('en-US', { timeZone: user.timezone || 'America/Los_Angeles', hour: 'numeric', hour12: false })) % 24; }
  catch (_) { return 12; }
}

/** Users with a quiet, unreviewed stretch in which the agent acted for them. */
function dueUsers() {
  const t = now();
  return db._raw().prepare(`
    SELECT u.*, COALESCE((SELECT max(window_end) FROM reflections r WHERE r.user_id = u.id), 0) AS reviewed_to,
      (SELECT max(created_at) FROM conversation_history h WHERE h.user_id = u.id) AS last_chat
    FROM users u
    WHERE EXISTS (SELECT 1 FROM agent_messages am WHERE am.from_user = u.id AND am.created_at > ?)
       OR EXISTS (SELECT 1 FROM conversation_history h WHERE h.user_id = u.id AND h.kind = 'outgoing' AND h.created_at > ?)`)
    .all(t - LOOKBACK_HOURS * 3600, t - LOOKBACK_HOURS * 3600)
    .filter((u) => u.last_chat && u.last_chat < t - QUIET_MINS * 60 && u.last_chat > u.reviewed_to);
}

function gather(user, since) {
  const convo = db._raw().prepare(`SELECT role, kind, text, created_at FROM conversation_history
    WHERE user_id = ? AND created_at > ? AND private_ct IS NULL ORDER BY created_at, rowid LIMIT 60`).all(user.id, since - 2 * 3600);
  const sent = db._raw().prepare(`SELECT am.kind, am.body, am.created_at, u.name AS to_name FROM agent_messages am JOIN users u ON u.id = am.to_user
    WHERE am.from_user = ? AND am.created_at > ? ORDER BY am.created_at`).all(user.id, since);
  const heard = db._raw().prepare(`SELECT am.kind, am.body, am.created_at, u.name AS from_name FROM agent_messages am JOIN users u ON u.id = am.from_user
    WHERE am.to_user = ? AND am.created_at > ? ORDER BY am.created_at`).all(user.id, since - 2 * 3600);
  return { convo, sent, heard };
}

function prompt(user, { convo, sent, heard }) {
  const first = String(user.name || 'the user').split(/\s+/)[0];
  const line = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 400);
  return `You are reviewing how a personal assistant ("ButterflAI") handled a conversation for ${first}. The conversation is over. Your job: spot an honest mistake worth checking with ${first} — not nitpicks.

Look for: something ${first} said that the assistant passed on to someone else with a different meaning (a question dropped, "probably" turned into a decision, a detail wrong); a question ${first} asked that was never answered; something the assistant told ${first} that it couldn't have known.

Conversation between ${first} and their assistant (oldest first):
${convo.map((m) => `[${m.role === 'user' ? first : 'assistant'}${m.kind ? '/' + m.kind : ''}] ${line(m.text)}`).join('\n') || '(none)'}

What the assistant sent on ${first}'s behalf to other people's assistants:
${sent.map((m) => `[to ${String(m.to_name).split(/\s+/)[0]}'s assistant, ${m.kind}] ${line(m.body)}`).join('\n') || '(none)'}

What other people's assistants said:
${heard.map((m) => `[from ${String(m.from_name).split(/\s+/)[0]}'s assistant, ${m.kind}] ${line(m.body)}`).join('\n') || '(none)'}

Reply with JSON only:
{"concern": true|false, "confidence": 0-1, "what_happened": "one sentence", "followup": "If concern: the short, friendly message the assistant should send ${first} to check — say plainly what it said or did and what ${first} may have meant, and ask. No apology essay. Plain text. Else empty."}`;
}

function parse(text) {
  try {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    return j && typeof j.concern === 'boolean' ? j : null;
  } catch (_) { return null; }
}

/** Review one user's quiet stretch. Returns the outcome. Never throws. */
async function reflectOn(user) {
  const t = now();
  const since = Math.max(user.reviewed_to || 0, t - LOOKBACK_HOURS * 3600);
  const record = (outcome, { confidence = null, followup = null, details = null } = {}) => {
    db._raw().prepare(`INSERT INTO reflections (id, user_id, window_start, window_end, outcome, confidence, followup, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uuidv4(), user.id, since, t, outcome, confidence, followup, user.test_user ? details : null);
    return outcome;
  };
  try {
    const c = client();
    if (!c) return 'disabled';
    const material = gather(user, since);
    if (!material.sent.length && !material.convo.some((m) => m.kind === 'outgoing')) return record('nothing_sent');
    const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: 500, messages: [{ role: 'user', content: prompt(user, material) }] });
    const j = parse((r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    if (!j) return record('unreadable');
    const details = JSON.stringify(j);
    if (!j.concern || !(j.confidence >= MIN_CONFIDENCE) || !String(j.followup || '').trim()) {
      return record(j.concern ? 'unsure' : 'clear', { confidence: j.confidence ?? null, details });
    }
    // At most one follow-up a day.
    const asked = db._raw().prepare(`SELECT 1 FROM reflections WHERE user_id = ? AND outcome = 'asked' AND created_at > ?`).get(user.id, t - 86400);
    if (asked) return record('held_daily_limit', { confidence: j.confidence, details });
    const text = String(j.followup).trim().slice(0, 600);
    db.appendConversation(user.id, 'assistant', text);
    sse.push(user.id, { role: 'assistant', text, ts: t });
    try { await push.notifyUser(db, user.id, { title: 'ButterflAI', body: text, url: '/app/chat' }); } catch (_) {}
    return record('asked', { confidence: j.confidence, followup: text, details });
  } catch (err) {
    console.error(`[reflect] user=${user.id} failed:`, err.message);
    return 'error';
  }
}

/** Run from the coord loop. Skips quiet hours (9pm–8am in the user's timezone). */
async function tick() {
  if (!client()) return 0;
  let n = 0;
  for (const u of dueUsers()) {
    if (n >= MAX_PER_TICK) break;
    const h = localHour(u);
    if (h < 8 || h >= 21) continue;
    await reflectOn(u);
    n++;
  }
  return n;
}

module.exports = { tick, reflectOn, dueUsers, _setClient, QUIET_MINS, MIN_CONFIDENCE };
