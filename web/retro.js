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

const MAX_PER_TICK = 60;   // grows with the task list (every behavior change adds one)
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
      // Plans they host AND plans they're invited to (2026-10-13: Bam Bam was offered to "set
      // up" Grover — the same weekend as Melanie's Birthday Weekend, which he was already in).
      const existing = require('./plan').plansFor(user.id, { includePast: true })
        .map((p) => `${p.title}${p.dates.label ? ` (${p.dates.label}${p.role === 'guest' ? `, ${p.host.name}'s plan` : ''})` : ''}`);
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
    id: '2026-10-13-going-not-just-interested',
    added: Date.UTC(2026, 9, 13) / 1000,
    kind: 'internal',
    about: 'Going vs interested (2026-10-13): a yes to a plan from someone who said "I\'m going" in its discussion is going (Bam Bam showed as interested).',
    run(user) {
      if (!user.phone) return 'no phone';
      const rows = db._raw().prepare(`SELECT ei.id, ei.event_id FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
        WHERE c.phone = ? AND ei.status = 'accepted' AND ei.going = 0`).all(user.phone);
      let n = 0;
      for (const r of rows) {
        const said = db._raw().prepare("SELECT 1 FROM conversation_history WHERE user_id = ? AND event_id = ? AND role = 'user' AND (lower(text) LIKE '%i''m going%' OR lower(text) LIKE '%im going%' OR lower(text) LIKE '%i am going%' OR lower(text) LIKE '%count me in%' OR lower(text) LIKE '%i''ll be there%')").get(user.id, r.event_id);
        if (said) { require('./planops').respond(r.id, 'accepted', { by: 'guest', phone: user.phone, via: 'retro', going: true }); n++; }
      }
      return `going ${n}`;
    },
  },
  {
    id: '2026-10-13-correct-setup-offers',
    added: Date.UTC(2026, 9, 14) / 1000,
    kind: 'propose',
    about: 'Offers to "set up" plans from earlier chats only looked at plans the person hosts (2026-10-13: Bam Bam was offered Grover — the weekend he was already in). Anyone who got such an offer and is in plans hears which ones already exist.',
    async run(user) {
      const offer = db._raw().prepare(`SELECT created_at FROM conversation_history WHERE user_id = ? AND role = 'assistant' AND text LIKE 'I now keep a plan for everything%'
        AND created_at >= ? ORDER BY created_at DESC LIMIT 1`).get(user.id, Date.UTC(2026, 9, 13) / 1000);
      if (!offer) return 'no offer';
      const when = (p) => p.at || (p.dates.proposals?.[0] ? Date.parse(p.dates.proposals[0].from) / 1000 : Infinity);
      const theirs = require('./plan').plansFor(user.id).filter((p) => p.role === 'guest').sort((a, b) => when(a) - when(b));
      if (!theirs.length) return 'not in any';
      await tellUser(user, `A correction: when I offered to set up plans from our chats, I missed the ones you're already in — ${theirs.map((p) => `${p.title} (${p.dates.label}, ${p.host.name}'s plan)`).join('; ')}. If what I listed is one of these, there's nothing to set up — it's already on your Events.`);
      return `corrected (${theirs.length})`;
    },
  },
  {
    id: '2026-10-19-fold-massages-into-melanies-weekend',
    added: Date.UTC(2026, 9, 19) / 1000,
    kind: 'internal',
    about: '🐛 #20 (Sean, 2026-10-19: "you now have two separate events when they should be one event") — Melanie\'s "Massages" (she hosts, Sean said yes) couldn\'t be combined into Sean\'s Melanie\'s Birthday Weekend because only a host could combine their own plans. Combine them now (Melanie is told). Only where report #20 exists and both plans are still open.',
    run(user) {
      if (!db._raw().prepare("SELECT 1 FROM feedback WHERE id = 20 AND user_note LIKE 'Melanie had tried to add massages to her birthday weekend%'").get()) return 'no report';
      const weekend = db._raw().prepare("SELECT id FROM social_events WHERE host_user_id = ? AND title = 'Melanie''s Birthday Weekend' AND COALESCE(status, 'open') != 'cancelled'").get(user.id);
      if (!weekend) return 'no weekend';
      const massages = db._raw().prepare(`SELECT se.id FROM social_events se JOIN event_invitations ei ON ei.event_id = se.id JOIN contacts c ON c.id = ei.contact_id
        WHERE se.title = 'Massages' AND se.host_user_id != ? AND COALESCE(se.status, 'open') != 'cancelled' AND c.phone = ? AND ei.status = 'accepted'`).get(user.id, user.phone || '');
      if (!massages) return 'no massages plan';
      // As Melanie (she hosts Massages and is the weekend's co-host) — since roles (2026-10-19) a
      // guest's combine is only a suggestion.
      const actor = db._raw().prepare('SELECT host_user_id FROM social_events WHERE id = ?').get(massages.id).host_user_id;
      require('./planops').autoCohost(weekend.id, { via: 'retro' });
      const r = require('./planops').merge(actor, weekend.id, massages.id, { via: 'retro' });
      return r.merged ? 'combined' : `not combined: ${r.error}`;
    },
  },
  {
    id: '2026-10-19-creating-repeats',
    added: Date.UTC(2026, 9, 19) / 1000,
    kind: 'internal',
    about: 'Creating doesn\'t repeat itself (🐛 #20 — Melanie\'s weekend had five massage items). On plans this user hosts, an open item whose words are all in another open item ("Massages" next to "Massages Friday (while kids at school)") is removed; the fuller one stays. Items assigned to someone are kept.',
    run(user) {
      const todos = require('./todos');
      let removed = 0;
      for (const e of db._raw().prepare("SELECT id FROM social_events WHERE host_user_id = ? AND COALESCE(status, 'open') != 'cancelled'").all(user.id)) {
        const items = db._raw().prepare('SELECT id, text, assignee_phone FROM event_todos WHERE event_id = ? AND done_at IS NULL ORDER BY length(text) DESC').all(e.id);
        const kept = [];
        for (const t of items) {
          const mine = todos.keyWords(t.text);
          const dupOf = mine.length && !t.assignee_phone && kept.find((k) => { const theirs = new Set(todos.keyWords(k.text)); return mine.every((w) => theirs.has(w)); });
          if (dupOf) { db._raw().prepare('DELETE FROM event_todos WHERE id = ?').run(t.id); removed++; } else kept.push(t);
        }
      }
      return `removed ${removed}`;
    },
  },
  {
    id: '2026-10-19-cohosts-and-leads',
    added: Date.UTC(2026, 9, 19) / 1000,
    kind: 'internal',
    about: 'Roles (owner, 2026-10-19): the person a plan is for becomes its co-host ("Melanie\'s Birthday Weekend" → Melanie), and every Creating item someone added gets them as its lead (items had no lead before).',
    run(user) {
      const planops = require('./planops');
      let cohosts = 0, leads = 0;
      for (const e of db._raw().prepare("SELECT id FROM social_events WHERE host_user_id = ? AND COALESCE(status, 'open') != 'cancelled'").all(user.id)) {
        if (planops.autoCohost(e.id, { via: 'retro' })) cohosts++;
        const ms = require('./todos').members(e.id);
        for (const t of db._raw().prepare('SELECT id, created_by FROM event_todos WHERE event_id = ? AND assignee_phone IS NULL AND suggested = 0').all(e.id)) {
          const m = ms.find((x) => x.phone && x.phone === db.getUser(t.created_by)?.phone);
          if (m) { db._raw().prepare('UPDATE event_todos SET assignee_phone = ?, assignee_name = ? WHERE id = ?').run(m.phone, m.name, t.id); leads++; }
        }
      }
      return `co-hosts ${cohosts}, leads ${leads}`;
    },
  },
  {
    id: '2026-10-19-one-massages-item',
    added: Date.UTC(2026, 9, 19) / 1000,
    kind: 'internal',
    about: 'Owner, 2026-10-19 ("these are all roughly the same thing … multiple people collaborating on a single thing, like massages"): the massage items on Melanie\'s Birthday Weekend become one "Massages" item — Friday, before 3pm while the kids are at school — led by Melanie, with Sean on it, and the other wordings kept in its notes. Only where report #20 exists.',
    run(user) {
      if (!db._raw().prepare("SELECT 1 FROM feedback WHERE id = 20 AND user_note LIKE 'Melanie had tried to add massages to her birthday weekend%'").get()) return 'no report';
      const e = db._raw().prepare("SELECT id FROM social_events WHERE host_user_id = ? AND title = 'Melanie''s Birthday Weekend' AND COALESCE(status, 'open') != 'cancelled'").get(user.id);
      if (!e) return 'no weekend';
      const items = db._raw().prepare("SELECT * FROM event_todos WHERE event_id = ? AND done_at IS NULL AND suggested = 0 AND (lower(text) LIKE '%massage%' OR lower(text) LIKE '%spa %' OR lower(text) LIKE '%spas %')").all(e.id);
      if (items.length < 2) return 'nothing to collapse';
      const mel = require('./todos').members(e.id).find((m) => /^melanie\b/i.test(m.name || ''));
      const day = items.map((t) => t.day).find(Boolean) || null;
      const notes = `Ideas so far: ${items.map((t) => t.text).filter((x) => !/^massages?$/i.test(x)).join(' · ')}`.slice(0, 500);
      const id = require('uuid').v4();
      db._raw().transaction(() => {
        for (const t of items) { db._raw().prepare('DELETE FROM todo_team WHERE todo_id = ?').run(t.id); db._raw().prepare('DELETE FROM event_todos WHERE id = ?').run(t.id); }
        db._raw().prepare(`INSERT INTO event_todos (id, event_id, text, assignee_phone, assignee_name, created_by, day, when_text, notes, status) VALUES (?, ?, 'Massages', ?, ?, ?, ?, ?, ?, 'idea')`)
          .run(id, e.id, mel?.phone || null, mel?.name || null, user.id, day, day ? 'before 3pm (kids at school)' : 'Fri before 3pm (kids at school)', notes);
        if (user.phone) db._raw().prepare('INSERT OR IGNORE INTO todo_team (todo_id, phone, name) VALUES (?, ?, ?)').run(id, user.phone, user.name);
      })();
      return `collapsed ${items.length}`;
    },
  },
  {
    id: '2026-10-19-rocky-horror-on-the-30th',
    added: Date.UTC(2026, 9, 19) / 1000,
    kind: 'internal',
    about: 'Sean, 2026-10-19: "the weekend of the 30th we got tickets to The Rocky Horror Picture Show" was saved as Saturday Oct 24, 7pm — the date reader took "Saturday" and ignored "October 30" (fixed: a named date wins). Put the plan on the weekend of the 30th (Oct 30 – Nov 1, proposed) — only if it is still on that wrong date.',
    run(user) {
      const e = db._raw().prepare("SELECT id FROM social_events WHERE host_user_id = ? AND title LIKE 'Rocky Horror%' AND scheduled_at = ? AND proposed_dates IS NULL AND COALESCE(status, 'open') != 'cancelled'")
        .get(user.id, Date.UTC(2026, 9, 25, 2) / 1000);
      if (!e) return 'not found as saved';
      const r = require('./planops').update(user.id, e.id, { proposed_dates: [{ from: '2026-10-30', to: '2026-11-01' }] }, { via: 'retro' });
      return r.ok ? 'moved to the weekend of the 30th' : `not moved: ${r.error}`;
    },
  },
  {
    id: '2026-10-19-rocky-horror-alex',
    added: Date.UTC(2026, 9, 19) / 1000,
    kind: 'propose',
    about: 'Sean, 2026-10-19: "Allie and Alex from my favorite Mama\'s group" — the agent found Allie but asked "which Alex?" (Alexandria Spargo is in that group; lookups now check the group / plan named). Offer to add the two of them to Rocky Horror if they aren\'t on it.',
    async run(user) {
      const e = db._raw().prepare("SELECT id, title FROM social_events WHERE host_user_id = ? AND title LIKE 'Rocky Horror%' AND COALESCE(status, 'open') != 'cancelled' ORDER BY created_at DESC").get(user.id);
      if (!e) return 'no plan';
      const g = db._raw().prepare("SELECT id FROM contact_groups WHERE user_id = ? AND name = 'Favorite Mama''s'").get(user.id);
      if (!g) return 'no group';
      const want = db._raw().prepare(`SELECT c.id, c.name FROM contact_group_members m JOIN contacts c ON c.id = m.contact_id WHERE m.group_id = ?
        AND (c.name LIKE 'Allie%' OR c.name LIKE 'Alex%') AND c.id NOT IN (SELECT contact_id FROM event_invitations WHERE event_id = ?)`).all(g.id, e.id);
      if (!want.length) return 'already on it';
      const text = `About ${e.title}: "Alex from Favorite Mama's" is ${want.find((c) => /^alex/i.test(c.name))?.name || 'in that group'} — I should have found her from the group instead of asking. Want me to add ${want.map((c) => c.name.split(' ')[0]).join(' and ')} to it?`;
      const id = db.appendConversation(user.id, 'assistant', text);
      db._raw().prepare('UPDATE conversation_history SET event_id = ? WHERE id = ?').run(e.id, id);
      sse.push(user.id, { role: 'assistant', text, ts: now() });
      return `offered (${want.length})`;
    },
  },
  {
    id: '2026-10-19-rocky-horror-just-the-30th',
    added: Date.UTC(2026, 9, 19) / 1000,
    kind: 'internal',
    about: '🐛 #22 (Sean: "Why is there a Rocky Horror Picture Show on the 30th and the 31st? I only said the 30th. I also didn\'t give a time") — my earlier retro put it on Oct 30 – Nov 1. Make it Fri Oct 30, time TBD, and add Allie, Alexandria and Melanie as guests (he asked: "add them both as well as Melanie"; the agent had only texted them). Only if the plan is still as that retro left it.',
    async run(user) {
      const e = db._raw().prepare(`SELECT id FROM social_events WHERE host_user_id = ? AND title LIKE 'Rocky Horror%' AND COALESCE(status, 'open') != 'cancelled'
        AND proposed_dates = '[{"from":"2026-10-30","to":"2026-11-01"}]'`).get(user.id);
      if (!e) return 'not as left';
      const planops = require('./planops');
      const r = planops.update(user.id, e.id, { when: '2026-10-30', time_tbd: true, proposed_dates: [] }, { via: 'retro' });
      if (r.error) return `not changed: ${r.error}`;
      const ids = db._raw().prepare(`SELECT c.id FROM contacts c JOIN users u ON u.phone = c.phone WHERE c.invited_by_user_id = ?
        AND (u.name LIKE 'Allie%' OR u.name LIKE 'Alexandria%' OR u.name LIKE 'Melanie%') AND c.id NOT IN (SELECT contact_id FROM event_invitations WHERE event_id = ?)
        GROUP BY c.phone`).all(user.id, e.id).map((x) => x.id);
      const inv = ids.length ? await planops.invite(user.id, e.id, ids, { via: 'retro', quiet: true }) : null;
      return `Oct 30, time TBD; invited ${inv?.sent ?? inv?.invited?.length ?? ids.length}`;
    },
  },
  {
    id: '2026-10-19-rocky-horror-correction',
    added: Date.UTC(2026, 9, 19) / 1000,
    kind: 'propose',
    about: '🐛 #22: the messages ButterflAI sent Allie, Alexandria and Melanie about Rocky Horror said "Fri Oct 30 through Sun Nov 1" and that they all have tickets — neither was said. Offer Sean a correction to send.',
    async run(user) {
      const e = db._raw().prepare("SELECT id, title FROM social_events WHERE host_user_id = ? AND title LIKE 'Rocky Horror%' AND COALESCE(status, 'open') != 'cancelled'").get(user.id);
      if (!e) return 'no plan';
      const sent = db._raw().prepare("SELECT count(*) n FROM conversation_history WHERE user_id = ? AND text LIKE '📤 To %Rocky Horror%through Sun Nov 1%'").get(user.id).n;
      if (!sent) return 'nothing sent';
      const text = `About ${e.title}: the messages I sent Allie, Alexandria and Melanie said it's Fri Oct 30 through Sun Nov 1 and that they all have tickets — you didn't say either. It's on Fri, Oct 30 (time TBD) now, and they're invited on the plan. Want me to send them a quick correction, e.g. "Correction: Rocky Horror is Friday, Oct 30 — time TBD. Sean will confirm who has tickets"?`;
      const id = db.appendConversation(user.id, 'assistant', text);
      db._raw().prepare('UPDATE conversation_history SET event_id = ? WHERE id = ?').run(e.id, id);
      sse.push(user.id, { role: 'assistant', text, ts: now() });
      return 'offered';
    },
  },
  {
    id: '2026-10-20-weekend-keeps-saturday',
    added: Date.UTC(2026, 9, 20) / 1000,
    kind: 'internal',
    about: '🐛 #25 (Sean: "You locked it into just Friday which destroys all the Saturday events"): "Friday October 23 through Saturday October 24" was read as Friday, which dropped the weekend\'s Fri–Sat range. Put Melanie\'s Birthday Weekend back on Fri Oct 23 – Sat Oct 24, locked in (confirmed), keeping the new notes. Only if it is still as that change left it.',
    run(user) {
      if (!db._raw().prepare("SELECT 1 FROM feedback WHERE id = 25 AND user_note LIKE 'You locked it into just Friday%'").get()) return 'no report';
      const e = db._raw().prepare(`SELECT id FROM social_events WHERE host_user_id = ? AND title = 'Melanie''s Birthday Weekend' AND COALESCE(status, 'open') != 'cancelled'
        AND proposed_dates IS NULL AND time_tbd = 1`).get(user.id);
      if (!e) return 'not as left';
      const r = require('./planops').update(user.id, e.id, { proposed_dates: [{ from: '2026-10-23', to: '2026-10-24' }], tentative: false }, { via: 'retro' });
      return r.ok ? 'Fri–Sat, locked in' : `not changed: ${r.error}`;
    },
  },
  {
    id: '2026-10-20-names-from-inviters',
    added: Date.UTC(2026, 9, 20) / 1000,
    kind: 'internal',
    about: 'Owner, 2026-10-20: "you should be able to use the name from the person who invited them" — an account still named "New user" takes the name whoever invited it saved (Alexandria → "Alexandria Spargo"); they can change it in Settings.',
    run(user) {
      const n = require('./people').fillName(user);
      return n ? `named ${n}` : 'kept';
    },
  },
  {
    id: '2026-10-20-using-it-means-signed-up',
    added: Date.UTC(2026, 9, 20) / 1000,
    kind: 'internal',
    about: 'Sign-up is just your name (owner, 2026-10-20: "she\'s using the app. She gets notices."). Anyone using ButterflAI — in a plan, or with a chat — whose account was still "not finished" (Alexandria: "New user", logged in with a code, never saw the old 3-contacts wizard) counts as signed up, so check-ins and nudges include them. Anyone still on a placeholder name is asked it in the app (name-prompt.js).',
    run(user) {
      if (user.onboarding_state === 'complete') return 'already';
      const inPlan = db._raw().prepare(`SELECT 1 FROM social_events WHERE host_user_id = ? UNION SELECT 1 FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE c.phone = ? LIMIT 1`).get(user.id, user.phone || '');
      const chatted = db._raw().prepare('SELECT 1 FROM conversation_history WHERE user_id = ? LIMIT 1').get(user.id);
      if (!inPlan && !chatted) return 'not using it';
      db.updateUser(user.id, { onboarding_state: 'complete' });
      return 'signed up';
    },
  },
  {
    id: '2026-10-19-options-asked-for-not-given',
    added: Date.UTC(2026, 9, 19) / 1000,
    kind: 'propose',
    about: '🐛 #19 (Melanie, 2026-10-18: "expecting list of massage places") — she asked for options and got questions instead. Now a request for options is read before the reply and the reply must search (understand.js). Anyone who asked for places or options in the last week and got no links back is offered them now, in that plan\'s discussion.',
    async run(user) {
      const since = now() - 7 * 86400;
      const rows = db._raw().prepare(`SELECT role, text, event_id, created_at FROM conversation_history WHERE user_id = ? AND created_at >= ? AND private_ct IS NULL
        ORDER BY created_at, rowid`).all(user.id, since);
      const ASKS = /\b(find|look up|recommend|suggest(ions)?|options|any good|where (can|should|could) (we|i))\b[^?.!]*\b(places?|spots?|spas?|restaurants?|bars?|massages?|cabins?|hotels?|options?)\b/i;
      let missed = null;
      rows.forEach((m, i) => {
        if (m.role !== 'user' || !ASKS.test(m.text)) return;
        const reply = rows.slice(i + 1).find((r) => r.role === 'assistant');
        if (!reply || !/https?:\/\//.test(reply.text)) missed = m;
      });
      if (!missed) return 'nothing missed';
      const what = String(missed.text).replace(/\s+/g, ' ').slice(0, 120);
      const text = `Earlier you asked: "${what}" — I asked you questions instead of giving you options. Want me to look them up now? Just say yes.`;
      const id = db.appendConversation(user.id, 'assistant', text);
      if (missed.event_id) db._raw().prepare('UPDATE conversation_history SET event_id = ? WHERE id = ?').run(missed.event_id, id);
      sse.push(user.id, { role: 'assistant', text, ts: now() });
      try { await push.notifyUser(db, user.id, { title: 'ButterflAI', body: 'Want me to look up those options now?', url: missed.event_id ? `/app/chat?event=${missed.event_id}` : '/app/chat' }); } catch (_) {}
      return 'offered';
    },
  },
  {
    id: '2026-10-14-melanies-massage-on-friday',
    added: Date.UTC(2026, 9, 14) / 1000,
    kind: 'internal',
    about: '🐛 #15 (Sean, 2026-10-13: "the massages were meant for Friday") — "I still see the massage on Saturday": move the massage in Melanie\'s Birthday Weekend (its notes and its Creating item) to Friday. Only where report #15 exists and the plan matches.',
    run(user) {
      const reported = db._raw().prepare("SELECT 1 FROM feedback WHERE id = 15 AND user_note LIKE 'It says Saturday plans, but the massages were meant for Friday%'").get();
      if (!reported) return 'no report';
      const e = db._raw().prepare("SELECT id, notes, proposed_dates FROM social_events WHERE host_user_id = ? AND title = 'Melanie''s Birthday Weekend' AND COALESCE(status, 'open') != 'cancelled'").get(user.id);
      if (!e) return 'no plan';
      const friday = (JSON.parse(e.proposed_dates || '[]')[0] || {}).from;
      if (!friday) return 'no dates';
      let changed = 0;
      // The Creating item: on Friday, and its text no longer says Saturday.
      for (const t of db._raw().prepare("SELECT id, text FROM event_todos WHERE event_id = ? AND lower(text) LIKE '%massage%' AND done_at IS NULL").all(e.id)) {
        db._raw().prepare('UPDATE event_todos SET day = ?, text = ? WHERE id = ?').run(friday, t.text.replace(/\s*(for|on) saturday\b/i, '').trim(), t.id);
        changed++;
      }
      // The notes: the massage moves to Friday; the rest of Saturday stays.
      if (/massage/i.test(e.notes || '') && /saturday/i.test(e.notes || '')) {
        const sat = String(e.notes).replace(/^\s*saturday:\s*/i, '').split(/\s*,\s*|\s*\+\s*/).filter((x) => x && !/massage/i.test(x));
        const notes = `Friday: massage. Saturday: ${sat.join(', ')}`;
        const r = require('./planops').update(user.id, e.id, { notes }, { via: 'retro' });
        if (r.ok) changed++;
      }
      return `moved ${changed}`;
    },
  },
  {
    id: '2026-10-14-undo-melanie-changes-from-liams-chat',
    added: Date.UTC(2026, 9, 14) / 1000,
    kind: 'internal',
    about: '2026-10-13: in Liam\'s Birthday Party\'s discussion the agent also rewrote Melanie\'s Birthday Weekend (notes, proposed dates, a wrong date). Put it back from the change log — only that exact change.',
    run(user) {
      const e = db._raw().prepare("SELECT id FROM social_events WHERE host_user_id = ? AND title = 'Melanie''s Birthday Weekend'").get(user.id);
      if (!e) return 'no plan';
      const bad = db._raw().prepare(`SELECT created_at FROM plan_changes WHERE event_id = ? AND field = 'notes' AND via = 'agent'
        AND old_value = 'Friday: massage. Saturday: Hot springs, dinner at Sassafras' AND new_value LIKE 'Carson City Hot Springs + massage%'`).get(e.id);
      if (!bad) return 'nothing to undo';
      const r = require('./planops').revert(user.id, e.id, { at: bad.created_at, via: 'undo' });
      return !r.ok ? r.error : r.reverted.length ? `reverted ${r.reverted.join(',')}` : 'already undone';
    },
  },
  {
    id: '2026-10-14-lock-in-liams-party',
    added: Date.UTC(2026, 9, 14) / 1000,
    kind: 'internal',
    about: 'Sean, 2026-10-13: "yes, it should be locked in" — ButterflAI told him Liam\'s Birthday Party was locked in for Sunday at noon but left it tentative and 2 hours long (he said ~3 hours). Lock it in for 3 hours — only if it\'s still exactly as found.',
    run(user) {
      const e = db._raw().prepare("SELECT id FROM social_events WHERE host_user_id = ? AND title = 'Liam''s Birthday Party' AND tentative = 1 AND date_tbd = 0 AND scheduled_at = ?").get(user.id, Date.UTC(2026, 9, 25, 19) / 1000);
      if (!e) return 'not as found';
      const r = require('./planops').update(user.id, e.id, { tentative: false, duration_mins: 180 }, { via: 'retro' });
      return r.ok ? `locked in (${r.updated.join(',')})` : r.error;
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
    // Everyone who uses ButterflAI — finished sign-up, or has talked to their agent (Bam Bam's
    // account still said "new" and was skipped by every task until 2026-10-13).
    const users = db._raw().prepare(`SELECT * FROM users u WHERE u.created_at < ?
      AND (u.onboarding_state = 'complete' OR EXISTS (SELECT 1 FROM conversation_history h WHERE h.user_id = u.id))
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
