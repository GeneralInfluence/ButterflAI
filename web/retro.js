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

const MAX_PER_TICK = 30;   // grows with the task list (every behavior change adds one)
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
    added: Date.UTC(2026, 9, 12) / 1000,
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
      await tellUser(user, `Each plan now has a "Creating" list everyone in it can see (top of the plan's chat, and on the Events page). I've suggested a few — keep the ones you want:\n${lines.join('\n')}`);
      return `suggested for ${lines.length}`;
    },
  },
  {
    id: '2026-10-12-store-plan-details-from-discussion',
    added: Date.UTC(2026, 9, 12) / 1000,
    kind: 'propose',
    about: 'Say it, store it (plansync.js): details decided in a plan\'s discussion but never saved (dates, place, people) are offered to the host to save.',
    async run(user) {
      const plansync = require('./plansync');
      if (!topics.modelAvailable()) return RETRY;
      const plans = db._raw().prepare(`SELECT id, title FROM social_events WHERE host_user_id = ? AND COALESCE(status, 'open') != 'cancelled'
        AND (scheduled_at > ? OR date_tbd = 1)`).all(user.id, now());
      const lines = [];
      for (const e of plans) {
        await topics.backfill(user.id, e.id);   // make sure its older messages are filed under it
        // The latest 40 messages (oldest first) — recent decisions, not superseded ones.
        const msgs = db._raw().prepare(`SELECT role, text FROM conversation_history WHERE user_id = ? AND event_id = ? AND private_ct IS NULL
          ORDER BY created_at DESC, rowid DESC LIMIT 40`).all(user.id, e.id).reverse();
        if (!msgs.length) continue;
        const missing = await plansync.missingDetails(e.id, msgs.map((m) => `${m.role === 'user' ? 'Person' : 'Assistant'}: ${String(m.text).slice(0, 400)}`).join('\n'));
        if (missing.length) lines.push(`• ${e.title}: ${missing.join('; ')}`);
      }
      if (!lines.length) return 'nothing missing';
      await tellUser(user, `Some things we decided never made it onto your plans:\n${lines.join('\n')}\nWant me to save them? Say yes, or correct me.`);
      return `offered for ${lines.length}`;
    },
  },
  {
    // The first run of the task above read whole discussions and could offer a superseded
    // detail (Sean's offer listed Grover Hot Springs, which he'd dropped). Re-check with the
    // fixed logic (latest 40 messages, latest decision wins) and correct the offer.
    id: '2026-10-12-store-plan-details-correction',
    added: Date.UTC(2026, 9, 12) / 1000,
    kind: 'propose',
    about: 'Correct the first "never made it onto your plans" offer, which could include superseded details.',
    async run(user) {
      const prior = db._raw().prepare(`SELECT outcome FROM retro_runs WHERE task_id = '2026-10-12-store-plan-details-from-discussion' AND user_id = ?`).get(user.id);
      if (!prior || !String(prior.outcome).startsWith('offered')) return 'not needed';
      const plansync = require('./plansync');
      if (!topics.modelAvailable()) return RETRY;
      const plans = db._raw().prepare(`SELECT id, title FROM social_events WHERE host_user_id = ? AND COALESCE(status, 'open') != 'cancelled'
        AND (scheduled_at > ? OR date_tbd = 1)`).all(user.id, now());
      const lines = [];
      for (const e of plans) {
        const msgs = db._raw().prepare(`SELECT role, text FROM conversation_history WHERE user_id = ? AND event_id = ? AND private_ct IS NULL
          ORDER BY created_at DESC, rowid DESC LIMIT 40`).all(user.id, e.id).reverse();
        if (!msgs.length) continue;
        const missing = await plansync.missingDetails(e.id, msgs.map((m) => `${m.role === 'user' ? 'Person' : 'Assistant'}: ${String(m.text).slice(0, 400)}`).join('\n'));
        if (missing.length) lines.push(`• ${e.title}: ${missing.join('; ')}`);
      }
      await tellUser(user, lines.length
        ? `Correction to my earlier message about details missing from your plans — it included things you'd already changed. Here's what's actually missing:\n${lines.join('\n')}\nSave these? Say yes, or correct me.`
        : `Correction: ignore my earlier message about details missing from your plans — it included things you'd already changed.`);
      return `corrected (${lines.length})`;
    },
  },
  {
    id: '2026-10-12-merge-duplicate-plans',
    added: Date.UTC(2026, 9, 12) / 1000,
    kind: 'internal',
    about: 'One plan per name (plan.existingByName): fold duplicates a host created twice into the original — dates, place, people and discussion kept; duplicate invite cards collapse.',
    run(user) {
      const multiparty = require('./multiparty');
      const { sameName } = require('./plan');
      const open = db._raw().prepare(`SELECT id, title FROM social_events WHERE host_user_id = ? AND COALESCE(status, 'open') != 'cancelled'
        ORDER BY created_at, rowid`).all(user.id);
      let merged = 0;
      const kept = [];
      for (const e of open) {
        const original = kept.find((k) => sameName(k.title, e.title));
        if (!original) { kept.push(e); continue; }
        if (require('./planops').merge(user.id, original.id, e.id, { via: 'system' }).merged) merged++;
      }
      return `merged ${merged}`;
    },
  },
  {
    id: '2026-10-12-close-orphan-questions',
    added: Date.UTC(2026, 9, 12) / 1000,
    kind: 'internal',
    about: 'Questions belong to plans (plan.js): close old agent questions not tied to any plan (they showed as "Waiting on …" forever).',
    run(user) {
      const n = db._raw().prepare(`UPDATE agent_messages SET processed = 1 WHERE from_user = ? AND kind = 'query' AND processed = 0
        AND created_at < ? AND (thread_id IS NULL OR thread_id NOT IN (SELECT id FROM social_events))`).run(user.id, now() - 2 * 86400).changes;
      return `closed ${n}`;
    },
  },
  {
    id: '2026-10-13-free-todos-of-guests-who-are-out',
    added: Date.UTC(2026, 9, 13) / 1000,
    kind: 'internal',
    about: 'Ripples (creating): to-dos assigned to someone who said no or was removed go back to "anyone can take it".',
    run(user) {
      const n = db._raw().prepare(`UPDATE event_todos SET assignee_phone = NULL, assignee_name = NULL
        WHERE done_at IS NULL AND assignee_phone IS NOT NULL AND event_id IN (SELECT id FROM social_events WHERE host_user_id = ?)
        AND assignee_phone != COALESCE((SELECT phone FROM users WHERE id = ?), '')
        AND NOT EXISTS (SELECT 1 FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
          WHERE ei.event_id = event_todos.event_id AND c.phone = event_todos.assignee_phone AND ei.status != 'declined')`).run(user.id, user.id).changes;
      return `freed ${n}`;
    },
  },
  {
    id: '2026-10-13-avoid-heads-up-for-existing-yes',
    added: Date.UTC(2026, 9, 13) / 1000,
    kind: 'propose',
    about: 'Ripples (avoid-heads-up): if someone on your avoid list already said yes to a plan you are still deciding on, you get the heads-up now.',
    run(user) {
      if (!user.phone) return 'no phone';
      const avoid = require('./avoid');
      const list = avoid.listAvoid(user.id, { context: 'retro heads-up' });
      if (!list.length) return 'no avoid list';
      const mine = db._raw().prepare(`SELECT ei.id, ei.event_id, se.title FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
        JOIN social_events se ON se.id = ei.event_id WHERE c.phone = ? AND ei.status IN ('invited', 'accepted') AND ei.dismissed_at IS NULL
        AND ei.needs_owner_decision = 0 AND COALESCE(se.status, 'open') != 'cancelled' AND (se.date_tbd = 1 OR se.scheduled_at > ?)`).all(user.phone, now());
      let told = 0;
      for (const m of mine) {
        const yes = db._raw().prepare(`SELECT c.phone FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
          WHERE ei.event_id = ? AND ei.id != ? AND ei.status = 'accepted'`).all(m.event_id, m.id);
        const entry = yes.map((y) => avoid.findByPhone(list, y.phone)).find(Boolean);
        if (!entry) continue;
        require('./planops').askOwner(m.id, { via: 'retro' });
        avoid.recordActivity(user.id, 'needs_decision', { eventId: m.event_id, avoidId: entry.id,
          text: `${entry.name} (on your avoid list) has said yes to "${m.title}". Paused your answer and asked you.` });
        require('./ripples/notice').inApp(user.id, m.event_id, `⚠️ Heads-up: ${String(entry.name).split(/\s+/)[0]} said yes to ${m.title}. Still going? Answer on the plan — your ButterflAI won't answer for you until you do.`,
          { url: `/app/events?event=${encodeURIComponent(m.event_id)}` });
        told++;
      }
      return `told ${told}`;
    },
  },
  {
    id: '2026-10-13-plans-onto-google-calendar',
    added: Date.UTC(2026, 9, 13) / 1000,
    kind: 'internal',
    about: 'Google Calendar mirrors ButterflAI (owner, 2026-10-13): plans people are already in go onto their connected Google Calendar; they are told once and can turn it off in Settings.',
    async run(user) {
      const calmirror = require('./calmirror');
      if (!calmirror.isOn(user.id)) return 'not connected';
      const n = calmirror.markAllFor(user.id);
      if (!n) return 'no plans';
      await calmirror.flush();
      require('./ripples/notice').inApp(user.id, null, `📅 Your ButterflAI plans are now on your Google Calendar (${n}) and will stay up to date as plans change. Proposed dates and invites you haven't answered show as tentative. You can turn this off in Settings → Connections.`,
        { url: '/app/settings' });
      return `marked ${n}`;
    },
  },
  {
    id: '2026-10-13-plans-onto-apple-calendar',
    added: Date.UTC(2026, 9, 13) / 1000,
    kind: 'internal',
    about: 'Apple Calendar mirrors ButterflAI too (2026-10-13): plans people are already in go onto their connected iCloud calendar; told once. (The earlier task only counted Google.)',
    async run(user) {
      if (require('./calendar').getCalendarProvider(user.id) !== 'apple') return 'not apple';
      const calmirror = require('./calmirror');
      if (!calmirror.isOn(user.id)) return 'off';
      const n = calmirror.markAllFor(user.id);
      if (!n) return 'no plans';
      await calmirror.flush();
      require('./ripples/notice').inApp(user.id, null, `📅 Your ButterflAI plans are now on your Apple Calendar (${n}) and will stay up to date as plans change. Proposed dates and invites you haven't answered show as tentative. You can turn this off in Settings → Connections.`,
        { url: '/app/settings' });
      return `marked ${n}`;
    },
  },
  {
    id: '2026-10-13-cases-for-earlier-feedback',
    added: Date.UTC(2026, 9, 13) / 1000,
    kind: 'internal',
    about: 'Every 🐛 becomes a test (owner, 2026-10-13): build the anonymized case for this user\'s earlier feedback while the plan and conversation are still here.',
    run(user) {
      const rows = db._raw().prepare('SELECT id, state_json, agent_message, user_note, page FROM feedback WHERE user_id = ? AND case_json IS NULL').all(user.id);
      const fc = require('./feedbackcase');
      let n = 0;
      for (const r of rows) {
        let state = null; try { state = JSON.parse(r.state_json || 'null'); } catch (_) {}
        try {
          const c = fc.build(user.id, { state, agentMessage: r.agent_message, note: r.user_note, page: r.page });
          db._raw().prepare('UPDATE feedback SET case_json = ? WHERE id = ?').run(JSON.stringify({ ...c, built_later: true }), r.id);
          n++;
        } catch (err) { console.error(`[retro] case for feedback ${r.id}:`, err.message); }
      }
      return `built ${n}`;
    },
  },
  {
    id: '2026-10-13-agent-questions-onto-plans',
    added: Date.UTC(2026, 9, 13) / 1000,
    kind: 'internal',
    about: 'Every agent question is about a plan (owner, 2026-10-13): link this user\'s earlier questions to the one plan both people are in (answers then land on it); close unanswered ones that can\'t be linked or are over a week old.',
    run(user) {
      const rows = db._raw().prepare(`SELECT * FROM agent_messages WHERE from_user = ? AND kind = 'query'
        AND (thread_id IS NULL OR thread_id NOT IN (SELECT id FROM social_events))`).all(user.id);
      const plan = require('./plan');
      let linked = 0, closed = 0;
      for (const q of rows) {
        const shared = plan.plansFor(user.id, { includePast: true }).filter((p) => p.stage !== 'cancelled' && plan.planFor(p.id, q.to_user));
        if (shared.length === 1) {
          const id = shared[0].id;
          db._raw().prepare('UPDATE agent_messages SET thread_id = ? WHERE id = ? OR (kind = \'reply\' AND thread_id IS ? AND from_user = ? AND to_user = ?)')
            .run(id, q.id, q.thread_id, q.to_user, user.id);
          // A reply already given lands on the plan as an answer.
          const reply = db._raw().prepare("SELECT body FROM agent_messages WHERE kind = 'reply' AND from_user = ? AND to_user = ? AND thread_id = ? AND created_at >= ? ORDER BY created_at LIMIT 1")
            .get(q.to_user, user.id, id, q.created_at);
          if (reply) require('./answers').record({ eventId: id, askerId: user.id, answererId: q.to_user, topic: q.topic, question: q.body, answer: reply.body });
          linked++;
        }
        if (!q.processed && (shared.length !== 1 || q.created_at < now() - 7 * 86400)) {
          db._raw().prepare('UPDATE agent_messages SET processed = 1 WHERE id = ?').run(q.id);
          closed++;
        }
      }
      return `linked ${linked}, closed ${closed}`;
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
