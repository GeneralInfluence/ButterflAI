/**
 * referral.test.js — Unit tests for referral token generation and DB helpers
 *
 * Tests getOrCreateReferralToken, createReferral, getReferralByToken,
 * redeemReferral, and rewardReferral.
 *
 * DB: :memory: SQLite for isolation.
 */

'use strict';

process.env.DB_PATH   = ':memory:';
process.env.NODE_ENV  = 'test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const db = require('../../db');

// ── Helper: create a test user in the :memory: DB ────────────────────────────

function createTestUser(suffix = '') {
  const id    = 'ref-user-' + uuidv4();
  const phone = '+1570' + Math.floor(Math.random() * 9000000 + 1000000);
  db._raw().prepare(
    `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'complete')`
  ).run(id, 'Ref Test' + suffix, phone);
  return id;
}

describe('db.getOrCreateReferralToken', () => {
  test('returns a string', () => {
    const userId = createTestUser('-1');
    const token = db.getOrCreateReferralToken(userId);
    assert.equal(typeof token, 'string', 'Token should be a string');
  });

  test('second call with same userId returns identical token (idempotent)', () => {
    const userId = createTestUser('-2');
    const token1 = db.getOrCreateReferralToken(userId);
    const token2 = db.getOrCreateReferralToken(userId);
    assert.equal(token1, token2, 'Token should be idempotent for the same user');
  });

  test('tokens for two different users are different', () => {
    const userId1 = createTestUser('-3a');
    const userId2 = createTestUser('-3b');
    const token1 = db.getOrCreateReferralToken(userId1);
    const token2 = db.getOrCreateReferralToken(userId2);
    assert.notEqual(token1, token2, 'Tokens for different users should differ');
  });

  test('token length is reasonable (6–36 chars)', () => {
    const userId = createTestUser('-4');
    const token = db.getOrCreateReferralToken(userId);
    assert.ok(token.length >= 6 && token.length <= 36,
      `Token length ${token.length} should be between 6 and 36`);
  });
});

describe('db.createReferral + getReferralByToken', () => {
  test('round-trips correctly', () => {
    const referrerId = createTestUser('-5');
    const referralId = uuidv4();
    const referralToken = 'TOKEN-' + uuidv4().slice(0, 8);

    db.createReferral({
      id: referralId,
      referrer_user_id: referrerId,
      referral_token: referralToken,
    });

    const row = db.getReferralByToken(referralToken);
    assert.ok(row, 'Should find referral by token');
    assert.equal(row.id, referralId, 'ID should match');
    assert.equal(row.referrer_user_id, referrerId, 'referrer_user_id should match');
    assert.equal(row.referral_token, referralToken, 'token should match');
    assert.equal(row.status, 'pending', 'Initial status should be pending');
  });

  test('getReferralByToken returns null for unknown token', () => {
    const row = db.getReferralByToken('nonexistent-token-xyz-' + uuidv4());
    assert.equal(row, undefined, 'Should return undefined for unknown token');
  });
});

describe('db.redeemReferral', () => {
  test('sets status=joined and referred_user_id', () => {
    const referrerId  = createTestUser('-6a');
    const referredId  = createTestUser('-6b');
    const referralId  = uuidv4();
    const token       = 'REDEEM-' + uuidv4().slice(0, 8);

    db.createReferral({ id: referralId, referrer_user_id: referrerId, referral_token: token });
    db.redeemReferral(token, referredId);

    const row = db.getReferralByToken(token);
    assert.equal(row.status, 'joined', 'Status should be joined after redeemReferral');
    assert.equal(row.referred_user_id, referredId, 'referred_user_id should be set');
  });
});

describe('db.rewardReferral', () => {
  test('sets status=rewarded and rewarded_at is set', () => {
    const referrerId  = createTestUser('-7a');
    const referredId  = createTestUser('-7b');
    const referralId  = uuidv4();
    const token       = 'REWARD-' + uuidv4().slice(0, 8);

    db.createReferral({ id: referralId, referrer_user_id: referrerId, referral_token: token });
    db.redeemReferral(token, referredId);
    db.rewardReferral(referralId);

    const row = db.getReferralByToken(token);
    assert.equal(row.status, 'rewarded', 'Status should be rewarded');
    assert.ok(row.rewarded_at, 'rewarded_at should be set');
    assert.ok(typeof row.rewarded_at === 'number' || typeof row.rewarded_at === 'string',
      'rewarded_at should be a number or string timestamp');
  });
});
