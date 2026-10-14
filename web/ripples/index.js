/**
 * ripples — every change to a plan cascades through the system.
 *
 * Owner, 2026-10-13: "every change to an event should cascade through the entire system."
 * An RSVP updates the guest list, but also the plan's Creating list, which agents count as
 * insiders, and anyone in the plan who'd rather not be around that person. Remembering
 * each ripple by hand is how they got missed, so:
 *
 *   1. planops.js (the only code that changes a plan) records each change here, in the
 *      same transaction as the change: emit(changes) → one row per change, one batch id.
 *   2. run(batch) gives each reaction the changes it listens to, once per batch.
 *      Reactions are small modules in ./reactions, safe to run twice.
 *   3. A reaction that throws leaves the batch pending; the coord loop retries it
 *      (retryPending), up to MAX_ATTEMPTS.
 *   4. matrix.js says, for every kind of change and every part of the system, which
 *      reaction handles it or why nothing needs to. The test fails when a cell is missing.
 *
 * Screens (Home, calendar, Events, chat pills) read plan.js live, so they need no reaction.
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');

/** Every kind of change planops records. */
const TYPES = {
  created:          'A plan was created',
  renamed:          'Its name changed',
  dates_changed:    'Its date, proposed dates or time changed',
  place_changed:    'Its place changed',
  details_changed:  'What it is, notes, group, visibility, or whether the host is going changed',
  locked_in:        'The host locked in the plan (no longer tentative)',
  cancelled:        'The plan was cancelled',
  merged:           'Another plan was folded into this one',
  guest_added:      'Someone was invited',
  guest_responded:  'Someone said yes or no (data.status)',
  guest_removed:    'The host removed someone',
  deferred:         'A guest said they go with whatever certain people decide (or took it back)',
  invite_hidden:    'A guest hid the invite from their Events page',
};

const REACTIONS = [
  require('./reactions/host-notice'),
  require('./reactions/deferrers-fyi'),
  require('./reactions/creating'),
  require('./reactions/avoid-heads-up'),
];
const MAX_ATTEMPTS = 5;

const parse = (s) => { try { return JSON.parse(s || 'null'); } catch (_) { return null; } };

/**
 * Record changes. Call inside the same transaction as the write. changes: [{ type,
 * event_id, actor_id, via, data }]. Returns the batch id (or null if nothing to record).
 */
function emit(changes) {
  const list = (changes || []).filter(Boolean);
  if (!list.length) return null;
  const batch = uuidv4();
  const ins = db._raw().prepare('INSERT INTO plan_ripples (batch, event_id, type, actor_id, via, data) VALUES (?, ?, ?, ?, ?, ?)');
  for (const c of list) {
    if (!TYPES[c.type]) throw new Error(`Unknown plan change type: ${c.type}`);
    ins.run(batch, c.event_id, c.type, c.actor_id || null, c.via || null, JSON.stringify(c.data || {}));
  }
  return batch;
}

/**
 * Run the reactions for a batch. Synchronous, so callers can report what happened
 * (e.g. how many FYIs went out). Returns { [reaction name]: result }.
 */
function run(batch) {
  if (!batch) return {};
  const rows = db._raw().prepare('SELECT * FROM plan_ripples WHERE batch = ? ORDER BY id').all(batch);
  if (!rows.length || rows.every((r) => r.done_at)) return {};
  const changes = rows.map((r) => ({ id: r.id, type: r.type, event_id: r.event_id, actor_id: r.actor_id, via: r.via, data: parse(r.data) || {} }));
  const done = parse(rows[0].results) || {};   // reactions that already succeeded on an earlier attempt
  const results = { ...done };
  let error = null;
  for (const r of REACTIONS) {
    if (done[r.name] !== undefined) continue;
    const mine = changes.filter((c) => r.on.includes(c.type));
    if (!mine.length) continue;
    try { results[r.name] = r.run(mine) ?? null; }
    catch (err) { error = `${r.name}: ${err.message}`; console.error(`[ripples] ${error}`); }
  }
  const upd = db._raw().prepare('UPDATE plan_ripples SET results = ?, attempts = attempts + 1, last_error = ?, done_at = ? WHERE batch = ?');
  upd.run(JSON.stringify(results), error, error ? null : Math.floor(Date.now() / 1000), batch);
  return results;
}

/** Emit and run (for callers outside a larger transaction). */
function ripple(changes) { return run(emit(changes)); }

/** Retry batches a reaction failed on (coord loop). */
function retryPending() {
  const batches = db._raw().prepare(`SELECT DISTINCT batch FROM plan_ripples WHERE done_at IS NULL AND attempts < ?
    AND created_at < strftime('%s','now') - 30 LIMIT 50`).all(MAX_ATTEMPTS).map((r) => r.batch);
  for (const b of batches) run(b);
  return batches.length;
}

/** What rippled from changes to a plan, newest first (admin / feedback). */
function history(eventId, limit = 50) {
  return db._raw().prepare('SELECT * FROM plan_ripples WHERE event_id = ? ORDER BY id DESC LIMIT ?').all(eventId, limit)
    .map((r) => ({ ...r, data: parse(r.data), results: parse(r.results) }));
}

module.exports = { TYPES, REACTIONS, emit, run, ripple, retryPending, history, MAX_ATTEMPTS };
