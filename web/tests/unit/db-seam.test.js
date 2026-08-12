'use strict';

/**
 * db-seam.test.js — Phase 1 Stage 1: the per-user data-access seam.
 *
 * The seam makes "which user is this query for?" an explicit, routed parameter
 * (db._raw(userId)). Until SPLIT_MODE=1, shardFor() returns the single `main` database for
 * everyone, so behavior is byte-for-byte identical to today — this file pins that invariant
 * and proves initDatabase() builds a full schema on an empty handle (so per-user shards can
 * be created cleanly when the split is flipped on). See docs/PHASE1_DB_SPLIT.md.
 *
 * Run: DB_PATH=:memory: JWT_SECRET=test node --test tests/unit/db-seam.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH  = ':memory:';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'seam-test';
delete process.env.SPLIT_MODE; // seam OFF for this suite (single-DB behavior)

const Database = require('better-sqlite3');
const db = require('../../db');
const { v4: uuid } = require('uuid');

describe('per-user access seam (SPLIT_MODE off → single DB)', () => {
  test('SPLIT_MODE is off in this suite', () => {
    assert.equal(db._splitMode(), false);
  });

  test('_raw() and _raw(userId) resolve to the SAME physical handle when off', () => {
    const noArg = db._raw();
    assert.ok(noArg, '_raw() returns a handle');
    assert.strictEqual(db._raw('any-user-id'), noArg, 'a user routes to main when off');
    assert.strictEqual(db._raw(null), noArg, 'null routes to main');
    assert.strictEqual(db._shardFor('another-user'), noArg, 'shardFor also returns main when off');
  });

  test('routing is transparent: write via _raw(), read via _raw(userId)', () => {
    const id = uuid();
    db._raw().prepare("INSERT INTO users (id, phone, name, onboarding_state) VALUES (?, ?, ?, 'done')")
      .run(id, '+15550009999', 'Seam User');
    const row = db._raw(id).prepare('SELECT name FROM users WHERE id = ?').get(id);
    assert.equal(row.name, 'Seam User', 'same DB underneath, so the row is visible either way');
  });

  test('initDatabase builds a full schema on an empty handle (shards can be created cleanly)', () => {
    const fresh = db._initDatabase(new Database(':memory:'));
    const tables = new Set(fresh.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    for (const t of [
      'users', 'user_preferences', 'user_private_data', 'private_data_access_log',
      'contacts', 'conversation_history', 'pending_actions', 'desires',
      'coordination_sessions', 'access_audit', '_migrations',
    ]) {
      assert.ok(tables.has(t), `initDatabase must create ${t} on an empty DB (self-sufficient migrations)`);
    }
    fresh.close();
  });
});
