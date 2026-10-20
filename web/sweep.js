/**
 * sweep.js — a daily consistency sweep over everyone's plans (2026-10-20, 🐛 #29 — Sean: "it
 * makes me think that these things that you keep saying are being done where you do sweeps
 * through things and make sure that everything is consistent and in order isn't properly
 * implemented yet"). He was right: retro tasks (retro.js) fix one known problem once; nothing
 * re-checked that the data stays consistent.
 *
 * Each check finds a kind of inconsistency and fixes it when the fix is safe and undoable
 * (through planops / the same rules as everywhere else); every finding is written to
 * sweep_log (admin: /api/admin/sweeps) so it's visible that it ran and what it did.
 * Runs from the coord loop, at most once a day. Add a check here whenever a new kind of
 * drift is found — and a test in tests/integration/sweep.test.js.
 *
 * (Things computed live from the plan object — stage, "past", what Home shows — need no sweep:
 * fixing plan.js fixes every existing plan at once, e.g. open invites ending, 🐛 #29.)
 */
'use strict';

const db = require('./db');

const now = () => Math.floor(Date.now() / 1000);
const EVERY = 20 * 3600;
let lastRun = 0;

function log(userId, check, fixed, detail) {
  if (!fixed) return;
  db._raw().prepare('INSERT INTO sweep_log (user_id, check_name, fixed, detail) VALUES (?, ?, ?, ?)').run(userId || null, check, fixed, String(detail || '').slice(0, 500));
}

const CHECKS = [
  {
    name: 'creating-repeats',
    about: 'An open Creating item whose words are all in another open item on the same plan ("Massages" next to "Massages Friday …") — removed; the fuller one stays. Items someone is assigned stay.',
    run() {
      const todos = require('./todos');
      let fixed = 0; const what = [];
      for (const { event_id: e } of db._raw().prepare(`SELECT DISTINCT t.event_id FROM event_todos t JOIN social_events se ON se.id = t.event_id
        WHERE t.done_at IS NULL AND COALESCE(se.status, 'open') != 'cancelled'`).all()) {
        const items = db._raw().prepare('SELECT id, text, assignee_phone FROM event_todos WHERE event_id = ? AND done_at IS NULL ORDER BY length(text) DESC').all(e);
        const kept = [];
        for (const t of items) {
          const mine = todos.keyWords(t.text);
          const dup = mine.length && !t.assignee_phone && kept.find((k) => { const theirs = new Set(todos.keyWords(k.text)); return mine.every((w) => theirs.has(w)); });
          if (dup) { db._raw().prepare('DELETE FROM todo_team WHERE todo_id = ?').run(t.id); db._raw().prepare('DELETE FROM event_todos WHERE id = ?').run(t.id); fixed++; what.push(`"${t.text}" (repeats "${dup.text}")`); }
          else kept.push(t);
        }
      }
      return { fixed, detail: what.join('; ') };
    },
  },
  {
    name: 'same-name-plans',
    about: 'Two open plans with the same name from the same host (case/punctuation aside) — the newer is combined into the older (people, discussion, Creating move; it can be seen in Recent changes).',
    run() {
      const plan = require('./plan'), planops = require('./planops');
      let fixed = 0; const what = [];
      for (const { host_user_id: h } of db._raw().prepare("SELECT DISTINCT host_user_id FROM social_events WHERE COALESCE(status, 'open') != 'cancelled'").all()) {
        const open = db._raw().prepare("SELECT id, title FROM social_events WHERE host_user_id = ? AND COALESCE(status, 'open') != 'cancelled' ORDER BY created_at").all(h);
        const seen = [];
        for (const e of open) {
          const first = seen.find((x) => plan.sameName(x.title, e.title));
          if (!first) { seen.push(e); continue; }
          const r = planops.merge(h, first.id, e.id, { via: 'retro' });
          if (r.merged) { fixed++; what.push(`"${e.title}" → "${first.title}"`); }
        }
      }
      return { fixed, detail: what.join('; ') };
    },
  },
  {
    name: 'stale-questions',
    about: 'A question from a friend\'s ButterflAI unanswered for over 7 days — closed (it no longer shows as waiting on anyone).',
    run() {
      const r = db._raw().prepare("UPDATE agent_messages SET processed = 1 WHERE kind = 'query' AND processed = 0 AND created_at < ?").run(now() - 7 * 86400);
      return { fixed: r.changes, detail: r.changes ? `${r.changes} closed` : '' };
    },
  },
  {
    name: 'calendar-gave-up',
    about: 'Calendar entries that stopped retrying after repeated failures, for people whose calendar connection works — retried.',
    run() {
      const r = db._raw().prepare(`UPDATE calendar_mirror SET attempts = 0 WHERE dirty = 1 AND attempts >= 5
        AND user_id NOT IN (SELECT user_id FROM connection_health WHERE status = 'broken')`).run();
      if (r.changes) require('./calmirror').flushSoon();
      return { fixed: r.changes, detail: r.changes ? `${r.changes} retried` : '' };
    },
  },
];

/** Run every check (once a day unless forced). Returns { check: fixed } for what changed. */
function run({ force = false } = {}) {
  if (!force && now() - lastRun < EVERY) return null;
  lastRun = now();
  const out = {};
  for (const c of CHECKS) {
    try {
      const r = c.run();
      if (r.fixed) { out[c.name] = r.fixed; log(null, c.name, r.fixed, r.detail); }
    } catch (err) {
      console.error(`[sweep] ${c.name}:`, err.message);
      log(null, `${c.name}:error`, 1, err.message);
    }
  }
  return out;
}

function recent(limit = 100) {
  return db._raw().prepare("SELECT check_name, fixed, detail, datetime(created_at, 'unixepoch') at FROM sweep_log ORDER BY id DESC LIMIT ?").all(limit);
}

module.exports = { run, recent, CHECKS };
