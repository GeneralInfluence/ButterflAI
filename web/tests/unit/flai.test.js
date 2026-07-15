/**
 * flai.test.js — Unit tests for the FLAI ledger module
 *
 * Tests appendFlaiLedger, getFlaiBalance, burnForUser, checkThrottle,
 * capEarnRate, and the baseline grant on user creation.
 *
 * DB: :memory: SQLite for isolation.
 */

'use strict';

process.env.DB_PATH   = ':memory:';
process.env.NODE_ENV  = 'test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.ANTHROPIC_API_KEY;

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

// Load db + flai after setting DB_PATH
const db = require('../../db');
const flai = require('../../flai');
const { BASELINE_GRANT, burnForUser, checkThrottle, capEarnRate } = flai;

describe('FLAI ledger — appendFlaiLedger', () => {
  test('positive delta: row exists and SUM equals delta', () => {
    const userId = 'flai-test-pos-' + uuidv4();
    // Create the user first (which also writes a baseline grant)
    db._raw().prepare(
      `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'complete')`
    ).run(userId, 'Test User', '+1555' + Math.floor(Math.random() * 9000000 + 1000000));

    // Zero out the baseline so we can test cleanly
    db._raw().prepare(`DELETE FROM flai_ledger WHERE user_id = ?`).run(userId);

    db.appendFlaiLedger({ user_id: userId, delta: 42, reason: 'test_positive', ref_id: null, metadata: {} });

    const row = db._raw().prepare('SELECT SUM(delta) as total FROM flai_ledger WHERE user_id = ?').get(userId);
    assert.equal(row.total, 42, 'SUM should equal delta after one positive entry');
  });

  test('negative delta (burn): SUM reflects burn correctly', () => {
    const userId = 'flai-test-neg-' + uuidv4();
    db._raw().prepare(
      `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'complete')`
    ).run(userId, 'Test User', '+1556' + Math.floor(Math.random() * 9000000 + 1000000));

    db._raw().prepare(`DELETE FROM flai_ledger WHERE user_id = ?`).run(userId);

    db.appendFlaiLedger({ user_id: userId, delta: 100, reason: 'test_grant', ref_id: null, metadata: {} });
    db.appendFlaiLedger({ user_id: userId, delta: -25, reason: 'test_burn', ref_id: null, metadata: {} });

    const row = db._raw().prepare('SELECT SUM(delta) as total FROM flai_ledger WHERE user_id = ?').get(userId);
    assert.equal(row.total, 75, 'SUM should be 75 after 100 grant and -25 burn');
  });
});

describe('FLAI ledger — getFlaiBalance', () => {
  test('multiple entries: returns correct sum', () => {
    const userId = 'flai-test-sum-' + uuidv4();
    db._raw().prepare(
      `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'complete')`
    ).run(userId, 'Test User', '+1557' + Math.floor(Math.random() * 9000000 + 1000000));

    db._raw().prepare(`DELETE FROM flai_ledger WHERE user_id = ?`).run(userId);

    db.appendFlaiLedger({ user_id: userId, delta: 50, reason: 'a', ref_id: null, metadata: {} });
    db.appendFlaiLedger({ user_id: userId, delta: 30, reason: 'b', ref_id: null, metadata: {} });
    db.appendFlaiLedger({ user_id: userId, delta: -10, reason: 'c', ref_id: null, metadata: {} });

    const balance = db.getFlaiBalance(userId);
    assert.equal(balance, 70, 'Balance should be 70 across multiple entries');
  });

  test('unknown user: returns 0 or null (handles both)', () => {
    const balance = db.getFlaiBalance('non-existent-user-id-' + uuidv4());
    // db returns 0 for unknown users (COALESCE SUM)
    assert.ok(balance === 0 || balance === null,
      `Expected 0 or null for unknown user, got ${balance}`);
  });
});

describe('FLAI — burnForUser', () => {
  test('valid userId: never throws, appends negative row', async () => {
    const userId = 'flai-burn-valid-' + uuidv4();
    db._raw().prepare(
      `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'complete')`
    ).run(userId, 'Test User', '+1558' + Math.floor(Math.random() * 9000000 + 1000000));

    db._raw().prepare(`DELETE FROM flai_ledger WHERE user_id = ?`).run(userId);

    await assert.doesNotReject(() => burnForUser(userId, 'burn:llm'));

    const rows = db._raw()
      .prepare('SELECT * FROM flai_ledger WHERE user_id = ? AND delta < 0')
      .all(userId);
    assert.ok(rows.length > 0, 'Should have at least one negative row after burn');
  });

  test('null userId: never throws (logs, does not crash)', async () => {
    await assert.doesNotReject(() => burnForUser(null, 'burn:sms'));
  });
});

describe('FLAI — checkThrottle', () => {
  test('always returns { throttled: false }', async () => {
    const result = await checkThrottle('any-user-id');
    assert.equal(result.throttled, false, 'checkThrottle stub should always return throttled=false');
  });

  test('works for any userId including unknown', async () => {
    const result = await checkThrottle('completely-unknown-user-' + uuidv4());
    assert.equal(result.throttled, false);
  });
});

describe('FLAI — capEarnRate', () => {
  test('returns proposed value unchanged (stub)', () => {
    assert.equal(capEarnRate('any-user', 100), 100);
    assert.equal(capEarnRate('any-user', 0), 0);
    assert.equal(capEarnRate('any-user', 999), 999);
  });
});

describe('FLAI — baseline grant on user creation', () => {
  test('createUser writes BASELINE_GRANT to flai_ledger', () => {
    const userId = 'flai-baseline-' + uuidv4();
    const phone  = '+1559' + Math.floor(Math.random() * 9000000 + 1000000);

    db.createUser({ id: userId, name: 'Test', phone, onboarding_state: 'complete' });

    const balance = db.getFlaiBalance(userId);
    assert.ok(balance >= BASELINE_GRANT,
      `Expected balance >= BASELINE_GRANT (${BASELINE_GRANT}), got ${balance}`);
  });
});
