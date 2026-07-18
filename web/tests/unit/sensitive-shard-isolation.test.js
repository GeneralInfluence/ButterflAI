'use strict';

/**
 * sensitive-shard-isolation.test.js — validates sensitive.js routing under SPLIT_MODE=1.
 *
 * Every private-data operation now routes to the OWNER's shard. This proves, under real
 * isolation, that (a) two users' private data live in separate shards, (b) the audit log
 * lands in the owner's shard, and (c) the per-edge sharing gate still works when the owner's
 * datum lives in the owner's shard. Complements the flag-off privacy.test.js.
 *
 * Run: SPLIT_MODE=1 DB_PATH=:memory: JWT_SECRET=test node --test tests/unit/sensitive-shard-isolation.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.SPLIT_MODE = '1';
process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'sens-iso-test';

const db = require('../../db');
const sensitive = require('../../sensitive');
const KEY = sensitive.HEALTH_NOTES_KEY;

const A = 'owner-A';
const B = 'owner-B';

describe('sensitive.js isolates private data per owner shard (SPLIT_MODE=1)', () => {
  test('each owner stores/reads only their own encrypted data', () => {
    sensitive.storePrivateData(A, KEY, 'A: HIV negative', 'HEALTH');
    sensitive.storePrivateData(B, KEY, 'B: on medication', 'HEALTH');
    assert.equal(sensitive.readPrivateData(A, KEY), 'A: HIV negative');
    assert.equal(sensitive.readPrivateData(B, KEY), 'B: on medication');
    // A's shard physically holds only A's row.
    const aRows = db._raw(A).prepare('SELECT user_id FROM user_private_data').all().map(r => r.user_id);
    assert.deepEqual([...new Set(aRows)], [A], "A's shard contains only A's rows");
  });

  test('audit log lands in the owner shard, not shared', () => {
    const aLog = db._raw(A).prepare('SELECT count(*) c FROM private_data_access_log').get().c;
    const bLog = db._raw(B).prepare('SELECT count(*) c FROM private_data_access_log').get().c;
    assert.ok(aLog > 0 && bLog > 0, 'both owners have their own audit rows');
    // A's audit rows are all about A.
    const aOwners = db._raw(A).prepare('SELECT DISTINCT user_id FROM private_data_access_log').all().map(r => r.user_id);
    assert.deepEqual(aOwners, [A]);
  });

  test('per-edge sharing gate works with data in the owner shard', () => {
    // B not approved → withheld; approve B → allowed; all resolved in A's shard.
    assert.equal(sensitive.readPrivateDataForSharing(A, KEY, B).allowed, false);
    sensitive.approveSharing(A, KEY, B);
    const shared = sensitive.readPrivateDataForSharing(A, KEY, B);
    assert.equal(shared.allowed, true);
    assert.equal(shared.value, 'A: HIV negative');
    // The approval lives in A's shard, invisible to B's shard.
    assert.deepEqual(sensitive.listSharingApprovals(A, KEY), [B]);
    assert.deepEqual(sensitive.listSharingApprovals(B, KEY), []);
  });
});
