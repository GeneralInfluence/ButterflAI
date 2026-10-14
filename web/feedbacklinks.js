/**
 * feedbacklinks.js — a fix ships with its link to the 🐛 it fixes (owner, 2026-10-13:
 * every 🐛 becomes a test). tests/fixtures/feedback-links.json maps a report's id to the
 * test that covers it; on server start each listed report whose note matches gets that
 * test_ref and is marked fixed. Matching the note keeps a different database (dev, tests)
 * from being touched.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');

const FILE = path.join(__dirname, 'tests/fixtures/feedback-links.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return {}; }
}

function apply(links = load()) {
  let n = 0;
  for (const [id, l] of Object.entries(links)) {
    if (!/^\d+$/.test(id) || !l?.test || !l?.note_starts) continue;
    n += db._raw().prepare(`UPDATE feedback SET test_ref = ?, status = 'fixed' WHERE id = ? AND test_ref IS NULL AND substr(user_note, 1, ?) = ?`)
      .run(l.test, Number(id), l.note_starts.length, l.note_starts).changes;
  }
  return n;
}

module.exports = { apply, load, FILE };
