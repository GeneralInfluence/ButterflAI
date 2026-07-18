'use strict';

/**
 * db-helpers-isolation.test.js — validates db.js per-user helper routing under SPLIT_MODE=1.
 *
 * The core per-user helpers (preferences, conversation history, wallets, private_data,
 * onboarding, access audit) now route to the owner's shard. This proves two users' state is
 * isolated when the flag is on. Flag-off behavior is covered by the rest of the suite.
 *
 * Run: SPLIT_MODE=1 DB_PATH=:memory: JWT_SECRET=test node --test tests/unit/db-helpers-isolation.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.SPLIT_MODE = '1';
process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'db-helpers-iso';

const db = require('../../db');
const A = 'user-A', B = 'user-B';

describe('db.js per-user helpers isolate by owner shard (SPLIT_MODE=1)', () => {
  test('preferences are per-shard', () => {
    db.upsertPreferences(A, { neighborhood: 'the Mission' });
    db.upsertPreferences(B, { neighborhood: 'SoMa' });
    assert.equal(db.getPreferences(A).neighborhood, 'the Mission');
    assert.equal(db.getPreferences(B).neighborhood, 'SoMa');
    const aOnly = db._raw(A).prepare('SELECT user_id FROM user_preferences').all().map(r => r.user_id);
    assert.deepEqual(aOnly, [A], "A's shard holds only A's preferences");
  });

  test('conversation history is per-shard', () => {
    db.appendConversation(A, 'user', 'hello from A');
    db.appendConversation(B, 'user', 'hello from B');
    const aConv = db.getRecentConversation(A).map(r => r.text);
    const bConv = db.getRecentConversation(B).map(r => r.text);
    assert.deepEqual(aConv, ['hello from A']);
    assert.deepEqual(bConv, ['hello from B']);
  });

  test('wallets are per-shard', () => {
    db.upsertWallet(A, { wallet_address: '0xA' });
    db.upsertWallet(B, { wallet_address: '0xB' });
    assert.equal(db.getWallet(A).wallet_address, '0xA');
    assert.equal(db.getWallet(B).wallet_address, '0xB');
  });

  test('legacy private_data blob is per-shard', () => {
    db.upsertPrivateData(A, { ciphertext: 'ctA', iv: 'i', tag: 't', wrapped_key: 'w' });
    assert.equal(db.getPrivateData(A).ciphertext, 'ctA');
    assert.equal(db.getPrivateData(B), undefined, "B's shard has no private_data row");
  });

  test('pending actions are per-shard (create/get/delete route by owner)', () => {
    db.createPendingAction({ id: 'pa-A', user_id: A, action_type: 'approve_share', payload: {} });
    db.createPendingAction({ id: 'pa-B', user_id: B, action_type: 'approve_share', payload: {} });
    assert.equal(db.getPendingAction(A).id, 'pa-A');
    assert.equal(db.getPendingAction(B).id, 'pa-B');
    db.deletePendingAction('pa-A', A);                 // routes to A's shard
    assert.equal(db.getPendingAction(A), undefined, "A's action deleted");
    assert.equal(db.getPendingAction(B).id, 'pa-B', "B's action untouched");
  });
});
