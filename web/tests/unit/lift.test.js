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

let testUserId;
let testEventId;

before(() => {
  testUserId = 'lift-user-' + uuidv4();
  const phone = '+1560' + Math.floor(Math.random() * 9000000 + 1000000);

  // Create minimal user
  db._raw().prepare(
    `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Lift Test', ?, 'complete')`
  ).run(testUserId, phone);

  // Create a relationship
  const relId = uuidv4();
  const contactId = uuidv4();
  // Create a dummy contact first
  db._raw().prepare(
    `INSERT INTO contacts (id, invited_by_user_id, name, tier) VALUES (?, ?, 'Contact', 0)`
  ).run(contactId, testUserId);
  db.createRelationship({ id: relId, user_id: testUserId, contact_id: contactId, contact_is_user: 0 });

  // Create a cadence
  const cadenceId = uuidv4();
  db.createCadence({
    id: cadenceId,
    relationship_id: relId,
    activity_type: 'lunch',
    frequency: 'monthly',
    group_size: 'one_on_one',
  });

  // Create a minimal activity (social event)
  testEventId = uuidv4();
  db._raw().prepare(
    `INSERT INTO activities (id, cadence_id, status, scheduled_at, activity_type, participants)
     VALUES (?, ?, 'completed', ?, 'lunch', ?)`
  ).run(testEventId, cadenceId, Math.floor(Date.now() / 1000) - 86400, JSON.stringify([testUserId]));
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
    const freshEventId = uuidv4();
    // Use existing cadence from setup — create a fresh activity
    const activity = db._raw()
      .prepare('SELECT cadence_id FROM activities WHERE id = ?')
      .get(testEventId);

    db._raw().prepare(
      `INSERT INTO activities (id, cadence_id, status, scheduled_at, activity_type, participants)
       VALUES (?, ?, 'completed', ?, 'lunch', ?)`
    ).run(freshEventId, activity?.cadence_id || null, Math.floor(Date.now() / 1000) - 3600, JSON.stringify([testUserId]));

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
    const freshEventId2 = uuidv4();
    const activity = db._raw()
      .prepare('SELECT cadence_id FROM activities WHERE id = ?')
      .get(testEventId);

    db._raw().prepare(
      `INSERT INTO activities (id, cadence_id, status, scheduled_at, activity_type, participants)
       VALUES (?, ?, 'completed', ?, 'lunch', ?)`
    ).run(freshEventId2, activity?.cadence_id || null, Math.floor(Date.now() / 1000) - 7200, JSON.stringify([testUserId]));

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
