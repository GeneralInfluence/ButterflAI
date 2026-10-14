/**
 * lift.test.js — Unit tests for the Lift estimator module
 *
 * Tests estimateDiscovery, estimateQuality, computeAndLogLift,
 * and DB write correctness.
 *
 * DB: :memory: SQLite for isolation.
 */

'use strict';

process.env.DB_PATH   = ':memory:';
process.env.NODE_ENV  = 'test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const db   = require('../../db');
const lift = require('../../lift');

// ── Shared test fixtures ──────────────────────────────────────────────────────
// Since 2026-10-13 lift measures plans (social_events), not the old `activities` table
// (nothing writes it any more). A plan's cadence is found through the people in it.

const multiparty = require('../../multiparty');
let testUserId;
let testEventId;
let friendPhone;
let cadenceId;

function pastPlan(hoursAgo) {
  const id = multiparty.createEvent(testUserId, { title: 'Lunch ' + uuidv4().slice(0, 6), activity_type: 'lunch',
    scheduled_at: Math.floor(Date.now() / 1000) - hoursAgo * 3600 });
  const cid = db._raw().prepare('SELECT id FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(testUserId, friendPhone).id;
  db._raw().prepare(`INSERT INTO event_invitations (id, event_id, contact_id, status) VALUES (?, ?, ?, 'accepted')`).run(uuidv4(), id, cid);
  return id;
}

before(() => {
  testUserId = 'lift-user-' + uuidv4();
  const phone = '+1560' + Math.floor(Math.random() * 9000000 + 1000000);
  friendPhone = '+1561' + Math.floor(Math.random() * 9000000 + 1000000);

  // Create minimal user
  db._raw().prepare(
    `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Lift Test', ?, 'complete')`
  ).run(testUserId, phone);

  // A friend (contact) with a relationship + monthly cadence
  const relId = uuidv4();
  const contactId = uuidv4();
  db._raw().prepare(
    `INSERT INTO contacts (id, invited_by_user_id, name, phone, tier) VALUES (?, ?, 'Contact', ?, 1)`
  ).run(contactId, testUserId, friendPhone);
  db.createRelationship({ id: relId, user_id: testUserId, contact_id: contactId, contact_is_user: 0 });
  cadenceId = uuidv4();
  db.createCadence({
    id: cadenceId,
    relationship_id: relId,
    activity_type: 'lunch',
    frequency: 'monthly',
    group_size: 'one_on_one',
  });

  // A past plan with that friend in it
  testEventId = pastPlan(24);
});

describe('cadenceFor (plans → cadence through the people in them)', () => {
  test('finds the cadence with someone in the plan', () => {
    assert.equal(lift.cadenceFor(testEventId, testUserId)?.id, cadenceId);
  });
});

describe('estimateDiscovery', () => {
  test('returns null (stub, blocked on Q2)', () => {
    const result = lift.estimateDiscovery(testEventId, testUserId);
    assert.equal(result.value, null, 'estimateDiscovery should return null (stub)');
    assert.ok('inputs' in result, 'Should have inputs field');
    assert.ok('confidence' in result, 'Should have confidence field');
  });
});

describe('estimateQuality', () => {
  test('0 prior attendance records → returns null (insufficient data)', () => {
    const freshEventId = uuidv4();
    // No prior attendance_confirmations exist for testUserId + this event's cadence
    const result = lift.estimateQuality(freshEventId, testUserId);
    assert.equal(result.value, null, 'estimateQuality should return null with no prior attendance');
    assert.ok('inputs' in result, 'Should have inputs field');
  });
});

describe('computeAndLogLift', () => {
  test('runs without throwing for a valid event+user', async () => {
    await assert.doesNotReject(
      () => lift.computeAndLogLift(testEventId, testUserId),
      'computeAndLogLift should not throw for a valid event+user'
    );
  });

  test('writes at least one row to lift_observations', async () => {
    const freshEventId = pastPlan(1);

    const countBefore = db._raw()
      .prepare('SELECT COUNT(*) as cnt FROM lift_observations WHERE event_id = ?')
      .get(freshEventId)?.cnt || 0;

    await lift.computeAndLogLift(freshEventId, testUserId);

    const countAfter = db._raw()
      .prepare('SELECT COUNT(*) as cnt FROM lift_observations WHERE event_id = ?')
      .get(freshEventId)?.cnt || 0;

    assert.ok(countAfter > countBefore, `Expected at least one new lift_observation row, got ${countAfter - countBefore}`);
  });

  test('inputs field on every written observation is valid JSON (not empty string)', async () => {
    const freshEventId2 = pastPlan(2);

    await lift.computeAndLogLift(freshEventId2, testUserId);

    const rows = db._raw()
      .prepare('SELECT inputs FROM lift_observations WHERE event_id = ?')
      .all(freshEventId2);

    assert.ok(rows.length > 0, 'Should have at least one observation row');
    for (const row of rows) {
      assert.ok(row.inputs && row.inputs !== '', 'inputs field should not be empty string');
      // Verify it's valid JSON
      assert.doesNotThrow(() => JSON.parse(row.inputs), `inputs should be valid JSON: "${row.inputs}"`);
      const parsed = JSON.parse(row.inputs);
      assert.equal(typeof parsed, 'object', 'inputs should parse to an object');
    }
  });
});
