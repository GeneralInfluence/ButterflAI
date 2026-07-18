'use strict';

/**
 * db-shard-isolation.test.js — Phase 1: prove the seam ACTUALLY isolates under SPLIT_MODE=1.
 *
 * This is the safety net for every later routing change. With the flag OFF, all users share
 * one DB, so a mis-routed query still "passes" — routing correctness is only testable with the
 * flag ON. Here, two users get separate shards and we prove one user's shard cannot see the
 * other's rows, and that a fresh shard has the full schema. See docs/PHASE1_DB_SPLIT.md.
 *
 * Run: SPLIT_MODE=1 DB_PATH=:memory: JWT_SECRET=test node --test tests/unit/db-shard-isolation.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.SPLIT_MODE = '1';      // seam ON
process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'shard-iso-test';

const db = require('../../db');

const A = 'user-A-id';
const B = 'user-B-id';
const INSERT = "INSERT INTO user_private_data (id, user_id, category, data_key, encrypted_v, iv, auth_tag) VALUES (?, ?, 'HEALTH', ?, 'ct', 'iv', 'tag')";

describe('SPLIT_MODE=1: per-user shards are isolated', () => {
  test('the flag is on and each user gets a distinct handle', () => {
    assert.equal(db._splitMode(), true);
    assert.notStrictEqual(db._raw(A), db._raw(B), 'A and B must be different databases');
    assert.strictEqual(db._raw(A), db._raw(A), 'same user → same cached handle');
    assert.notStrictEqual(db._raw(A), db._raw(null), 'a user shard is not the main/directory DB');
  });

  test("one user's shard cannot see another user's rows", () => {
    db._raw(A).prepare(INSERT).run('rowA', A, 'health.note');
    db._raw(B).prepare(INSERT).run('rowB', B, 'health.note');

    const aIds = db._raw(A).prepare('SELECT id FROM user_private_data').all().map(r => r.id);
    const bIds = db._raw(B).prepare('SELECT id FROM user_private_data').all().map(r => r.id);

    assert.deepEqual(aIds, ['rowA'], "A's shard holds only A's row");
    assert.deepEqual(bIds, ['rowB'], "B's shard holds only B's row — no cross-user visibility");
  });

  test('a freshly-created shard has the full schema (incl. folded lazy tables)', () => {
    const tables = new Set(db._raw(A).prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    for (const t of ['user_private_data', 'user_preferences', 'contacts', 'conversation_history',
                     'calendar_tokens', 'venue_favorites', 'desires', 'pending_actions']) {
      assert.ok(tables.has(t), `shard must have ${t}`);
    }
  });
});
