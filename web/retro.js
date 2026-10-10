/**
 * retro.js — apply behavior changes to what already exists, not just to what comes next.
 *
 * Owner, 2026-10-10: "When we make updates to this app, we need to be retrospective about
 * its applications, in perpetuity." (Grover and Melanie's birthday weekend weren't chat
 * pills: "every conversation is about a plan" only acted on new messages.)
 *
 * Every behavior change ships with a task here (or says in its commit why none is needed).
 * Each task runs once per user who existed before it was added, from the coord loop:
 *  - kind 'internal': fixes our own data (filing messages, linking plans). Runs directly.
 *  - kind 'propose':  would create something or reach people. NEVER done silently — the
 *    user is asked once in chat; their agent acts if they say yes. Daytime only.
 * A task that can't run yet (no model available) is retried on a later tick.
 */
'use strict';

const db = require('./db');
const sse = require('./sse');
const push = require('./push');
const topics = require('./topics');
const { createAnthropicClient, DEFAULT_MODEL } = require('./anthropic-client');

const MAX_PER_TICK = 10;
const now = () => Math.floor(Date.now() / 1000);
const RETRY = Symbol('retry');

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

// A message from the user's own agent, in their chat (General — about no plan yet).
async function tellUser(user, text) {
  db.appendConversation(user.id, 'assistant', text);
  sse.push(user.id, { role: 'assistant', text, ts: now() });
  try { await push.notifyUser(db, user.id, { title: 'ButterflAI', body: text, url: '/app/chat' }); } catch (_) {}
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
// `added` = unix time the task was added; it applies to users created before then.

const TASKS = [
  {
    id: '2026-10-10-file-past-messages-into-plans',
    added: Date.UTC(2026, 9, 10) / 1000,
    kind: 'internal',
    about: 'Chat by plan (migration 036): sort older messages into each existing plan\'s discussion, not only when a pill is first opened.',
    async run(user) {
      if (!topics.modelAvailable()) return RETRY;
      let n = 0;
      for (const e of topics.eventsFor(user.id)) n += await topics.backfill(user.id, e.id);
      return `filed ${n}`;
    },
  },
  {
    id: '2026-10-10-link-group-plans',
    added: Date.UTC(2026, 9, 10) / 1000,
    kind: 'internal',
    about: 'Group plans (migration 038): link existing plans that invite a whole group to that group.',
    run(user) {
      const groups = require('./groups');
      let n = 0;
      for (const g of db.getContactGroups(user.id)) {
        const before = db._raw().prepare('SELECT count(*) c FROM social_events WHERE host_user_id = ? AND group_id = ?').get(user.id, g.id).c;
        n += groups.upcomingPlans(user.id, g.id).length - before;
      }
      return `linked ${Math.max(0, n)}`;
    },
  },
  {
    id: '2026-10-10-plans-from-past-chats',
    added: Date.UTC(2026, 9, 10) / 1000,
    kind: 'propose',
    about: 'Every conversation is about a plan (migration 043): find plans discussed in the last 14 days that were never set up, and offer to set them up.',
    async run(user) {
      const c = client();
      if (!c) return RETRY;
      const msgs = db._raw().prepare(`SELECT role, text FROM conversation_history WHERE user_id = ? AND private_ct IS NULL
        AND created_at > ? AND kind IS NULL ORDER BY created_at, rowid LIMIT 200`).all(user.id, now() - 14 * 86400);
      if (msgs.filter((m) => m.role === 'user').length < 2) return 'too little to go on';
      const existing = db._raw().prepare(`SELECT title FROM social_events WHERE host_user_id = ? AND COALESCE(status, 'open') != 'cancelled'`).all(user.id).map((e) => e.title);
      const first = String(user.name || 'the user').split(/\s+/)[0];
      const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: 600, messages: [{ role: 'user', content:
        `Below is ${first}'s recent chat with their social-planning assistant. List the plans ${first} is actually making (trips, dinners, parties, outings — with or without a date) that are NOT already one of these plans: ${existing.length ? existing.map((t) => `"${t}"`).join(', ') : '(none)'}.\n`
        + 'Skip anything that already happened, was cancelled, or was only a passing idea. If two names are the same plan (e.g. a trip that IS someone\'s birthday weekend), list it once.\n\n'
        + msgs.map((m) => `[${m.role === 'user' ? first : 'assistant'}] ${String(m.text).replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')
        + '\n\nReply with JSON only: {"plans":[{"title":"short name","when":"dates as said, or \\"\\"","who":["first names"],"notes":"one short line or \\"\\""}]}' }] });
      let found = [];
      try { found = JSON.parse(String((r.content || []).map((b) => b.text || '').join('')).match(/\{[\s\S]*\}/)[0]).plans || []; } catch (_) { return 'unreadable'; }
      found = found.filter((p) => p && p.title).slice(0, 5);
      if (!found.length) return 'none found';
      const lines = found.map((p) => `• ${p.title}${p.when ? ` — ${p.when}` : ''}${p.who?.length ? ` (with ${p.who.join(', ')})` : ''}${p.notes ? `. ${p.notes}` : ''}`);
      await tellUser(user, `I now keep a plan for everything we talk about, with its own place in chat. From our recent conversations, ${found.length === 1 ? 'this one isn\'t' : 'these aren\'t'} set up yet:\n${lines.join('\n')}\nWant me to set ${found.length === 1 ? 'it' : 'them'} up? Say yes, or tell me which.`);
      return `proposed ${found.length}`;
    },
  },
];

/** Run pending tasks for existing users (coord loop). Proposals only in daytime. */
async function tick() {
  let ran = 0;
  for (const task of TASKS) {
    const users = db._raw().prepare(`SELECT * FROM users u WHERE u.created_at < ? AND u.onboarding_state = 'complete'
      AND NOT EXISTS (SELECT 1 FROM retro_runs r WHERE r.task_id = ? AND r.user_id = u.id)`).all(task.added, task.id);
    for (const user of users) {
      if (ran >= MAX_PER_TICK) return ran;
      if (task.kind === 'propose') { const h = localHour(user); if (h < 9 || h >= 20) continue; }
      let outcome;
      try { outcome = await task.run(user); } catch (err) { console.error(`[retro] ${task.id} user=${user.id}:`, err.message); outcome = 'error'; }
      if (outcome === RETRY) continue;
      db._raw().prepare('INSERT OR IGNORE INTO retro_runs (task_id, user_id, outcome) VALUES (?, ?, ?)').run(task.id, user.id, String(outcome).slice(0, 200));
      ran++;
    }
  }
  return ran;
}

module.exports = { TASKS, tick, _setClient };
