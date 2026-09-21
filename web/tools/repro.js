#!/usr/bin/env node
/**
 * repro.js — turn a flagged feedback item into simulator input.
 *
 * A tester's 👎 captured the agent reply, their note, and the recent conversation.
 * This reads that row from the DB (DB_PATH) and prints the user's message sequence
 * as `a:` lines you can paste into the simulator (`npm run sim`) to replay the
 * interaction and watch the miss happen — then fix it and add a test.
 *
 *   node tools/repro.js <feedbackId>
 *
 * Runs against whatever DB_PATH points at (the prod machine, or a local copy).
 */
'use strict';

const db = require('../db');

const id = process.argv[2];
if (!id) {
  console.error('usage: node tools/repro.js <feedbackId>');
  process.exit(1);
}

const row = db._raw().prepare('SELECT * FROM feedback WHERE id = ?').get(id);
if (!row) {
  console.error(`No feedback row #${id} in ${process.env.DB_PATH || '(default DB)'}.`);
  process.exit(1);
}

let turns = [];
try { turns = JSON.parse(row.context_json || '[]'); } catch (_) { /* ignore */ }
const userTurns = turns.filter((t) => t && t.role === 'user');

const when = row.created_at ? new Date(row.created_at * 1000).toISOString() : '(unknown)';
console.log(`\n=== Feedback #${row.id}  [${row.status}]  model=${row.model || '?'}  at ${when} ===`);
console.log(`Note        : ${row.user_note || '(none)'}`);
console.log(`Flagged reply: ${String(row.agent_message || '(empty)').replace(/\s+/g, ' ')}`);
console.log(`\n--- Simulator input (paste into \`npm run sim\`) ---`);
if (!userTurns.length) {
  console.log('# (no user turns were captured for this item)');
} else {
  for (const t of userTurns) {
    console.log('a: ' + String(t.text || '').replace(/\s+/g, ' ').trim());
  }
}
console.log('');
process.exit(0);
