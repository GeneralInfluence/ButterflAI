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
  {
    id: '2026-10-12-dates-for-undated-plans',
    added: Date.UTC(2026, 9, 12) / 1000,
    kind: 'propose',
    about: 'Calendar by stage + proposed dates (migration 045): plans created with no date get the dates found in their discussion offered as proposed dates.',
    async run(user) {
      const c = client();
      if (!c) return RETRY;
      const undated = db._raw().prepare(`SELECT id, title FROM social_events WHERE host_user_id = ? AND date_tbd = 1
        AND proposed_dates IS NULL AND COALESCE(status, 'open') != 'cancelled'`).all(user.id);
      if (!undated.length) return 'none undated';
      const msgs = db._raw().prepare(`SELECT role, text FROM conversation_history WHERE user_id = ? AND private_ct IS NULL
        AND created_at > ? ORDER BY created_at, rowid LIMIT 200`).all(user.id, now() - 30 * 86400);
      const year = new Date().getUTCFullYear();
      const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: 500, messages: [{ role: 'user', content:
        `Today is ${new Date().toISOString().slice(0, 10)}. For each plan below, find the dates mentioned for it in the chat (only dates clearly about that plan, upcoming). `
        + `Plans:\n${undated.map((e, i) => `${i + 1}. ${e.title}`).join('\n')}\n\nChat:\n`
        + msgs.map((m) => `[${m.role}] ${String(m.text).replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')
        + `\n\nReply with JSON only: {"dates":[{"plan":1,"from":"${year}-MM-DD","to":"${year}-MM-DD"}]} — omit plans with no clear dates.` }] });
      let found = [];
      try { found = JSON.parse(String((r.content || []).map((b) => b.text || '').join('')).match(/\{[\s\S]*\}/)[0]).dates || []; } catch (_) { return 'unreadable'; }
      const fmt = (s) => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      const lines = [];
      for (const d of found) {
        const e = undated[(d.plan | 0) - 1];
        let p;
        try { p = require('./multiparty').normalizeProposals([{ from: d.from, to: d.to }]); } catch (_) { continue; }
        if (!e || !p || Date.parse(p[0].to) < Date.now() - 86400e3) continue;
        lines.push(`• ${e.title}: ${p[0].from === p[0].to ? fmt(p[0].from) : `${fmt(p[0].from)}–${fmt(p[0].to)}`}`);
      }
      if (!lines.length) return 'no dates found';
      await tellUser(user, `Your plans now show on the calendar by stage. ${lines.length === 1 ? 'This one has' : 'These have'} no date yet, but our chats mention ${lines.length === 1 ? 'one' : 'some'}:\n${lines.join('\n')}\nPut ${lines.length === 1 ? 'it' : 'them'} on the calendar as proposed dates? Say yes, or correct me.`);
      return `proposed ${lines.length}`;
    },
  },
  {
    id: '2026-10-12-suggest-todos-for-existing-plans',
    added: Date.UTC(2026, 9, 12, 12) / 1000,
    kind: 'propose',
    about: 'Plan to-dos (migration 046): existing upcoming plans with no to-dos get a few SUGGESTED (kept only if someone keeps them).',
    async run(user) {
      const c = client();
      if (!c) return RETRY;
      const todos = require('./todos');
      const plans = db._raw().prepare(`SELECT id, title, activity_type, venue_name, notes FROM social_events se WHERE host_user_id = ?
        AND COALESCE(status, 'open') != 'cancelled' AND (scheduled_at > ? OR date_tbd = 1)
        AND NOT EXISTS (SELECT 1 FROM event_todos t WHERE t.event_id = se.id)`).all(user.id, now());
      if (!plans.length) return 'no plans need it';
      const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: 600, messages: [{ role: 'user', content:
        'Suggest 2–4 concrete to-dos for each plan (things someone has to do to make it happen: book, buy, decide, bring). Short, imperative.\n'
        + plans.map((e, i) => `${i + 1}. ${e.title} (${e.activity_type}${e.venue_name ? ', ' + e.venue_name : ''})${e.notes ? ' — ' + String(e.notes).slice(0, 150) : ''}`).join('\n')
        + '\nReply with JSON only: {"todos":[{"plan":1,"items":["Book the campsite"]}]}' }] });
      let found = [];
      try { found = JSON.parse(String((r.content || []).map((b) => b.text || '').join('')).match(/\{[\s\S]*\}/)[0]).todos || []; } catch (_) { return 'unreadable'; }
      const lines = [];
      for (const f of found) {
        const e = plans[(f.plan | 0) - 1];
        if (!e) continue;
        const added = (f.items || []).slice(0, 4).map((t) => todos.add(user.id, e.id, { text: t, suggested: true })).filter((x) => x.ok).map((x) => x.todo.text);
        if (added.length) lines.push(`• ${e.title}: ${added.join('; ')}`);
      }
      if (!lines.length) return 'none suggested';
      await tellUser(user, `Each plan now has a to-do list everyone in it can see (top of the plan's chat, and on the Events page). I've suggested a few — keep the ones you want:\n${lines.join('\n')}`);
      return `suggested for ${lines.length}`;
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
