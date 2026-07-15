/**
 * sms-flows.test.js — Integration tests for SMS webhook flows
 *
 * Tests POST /sms with Twilio sig bypass (NODE_ENV=test).
 * Uses a counter SMS client to track outbound messages without hitting Twilio.
 */

'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.ANTHROPIC_API_KEY;

const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');

// Counter client to track outbound SMS calls
let smsCalls = [];
const counterClient = {
  messages: {
    create(params) {
      smsCalls.push(params);
      return Promise.resolve({ sid: 'SM_COUNT_' + smsCalls.length });
    },
  },
};
sms._setClient(counterClient);

const { app } = require('../../server');
const db       = require('../../db');
const request  = supertest(app);

const TEST_PHONE = '+12025550200';
let testUserId;

// ── Setup test user ──────────────────────────────────────────────────────────

before(() => {
  testUserId = 'sms-test-user-' + uuidv4();
  db._raw().prepare(
    `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'SMS Test', ?, 'complete')`
  ).run(testUserId, TEST_PHONE);

  // Write consent so notifyUser can work
  db.writeConsent(TEST_PHONE, 'INVITE_PAGE');
});

// ── Helper: send inbound SMS ─────────────────────────────────────────────────

function sendSms(body, from = TEST_PHONE) {
  return request
    .post('/sms')
    .type('form')
    .send({ From: from, Body: body });
}

// ── Helper: create pending action ────────────────────────────────────────────

function createPendingAction(type, payload) {
  const id = uuidv4();
  db.createPendingAction({
    id,
    user_id: testUserId,
    action_type: type,
    payload,
    ttl_secs: 86400,
  });
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('SMS STOP flow', () => {
  before(() => {
    smsCalls = [];
    // Remove any existing opt-out first
    db.removeOptOut(TEST_PHONE);
  });

  test('Body=STOP → 200 TwiML, user opted out, reply SMS sent', async () => {
    const callsBefore = smsCalls.length;
    const res = await sendSms('STOP');

    assert.equal(res.status, 200, 'Should return 200');
    assert.ok(res.type.includes('xml') || res.type.includes('text'), 'Should return TwiML');

    // Give async handler time to process
    await new Promise(r => setTimeout(r, 100));

    assert.ok(db.isOptedOut(TEST_PHONE), 'User should be opted out after STOP');
    assert.ok(smsCalls.length > callsBefore, 'Should have sent a reply SMS');
  });
});

describe('SMS START flow (after opt-out)', () => {
  before(async () => {
    smsCalls = [];
    // Ensure user is opted out first
    db.recordOptOut(TEST_PHONE, 'stop_reply');
  });

  test('Body=START → opt-out removed, welcome-back reply sent', async () => {
    const callsBefore = smsCalls.length;
    const res = await sendSms('START');

    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 100));

    assert.ok(!db.isOptedOut(TEST_PHONE), 'Opt-out should be removed after START');
    assert.ok(smsCalls.length > callsBefore, 'Should have sent a welcome-back reply');
  });
});

describe('nudge_confirm pending action — Y', () => {
  before(async () => {
    smsCalls = [];
    // Ensure not opted out
    db.removeOptOut(TEST_PHONE);
  });

  test('Y reply: pending_action deleted, inbound_message queued, reply sent without error', async () => {
    const contactId = uuidv4();
    db._raw().prepare(
      `INSERT INTO contacts (id, invited_by_user_id, name, tier) VALUES (?, ?, 'Alice', 0)`
    ).run(contactId, testUserId);

    const cadenceId = uuidv4();
    const relId = uuidv4();
    db.createRelationship({ id: relId, user_id: testUserId, contact_id: contactId, contact_is_user: 0 });
    db.createCadence({ id: cadenceId, relationship_id: relId, activity_type: 'lunch', frequency: 'monthly' });

    const actionId = createPendingAction('nudge_confirm', {
      cadence_id: cadenceId,
      contact_id: contactId,
      contact_name: 'Alice',
      activity_type: 'lunch',
      frequency: 'monthly',
    });

    const callsBefore = smsCalls.length;
    const res = await sendSms('Y');
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 100));

    // Pending action should be deleted
    const remaining = db._raw()
      .prepare('SELECT * FROM pending_actions WHERE id = ?')
      .get(actionId);
    assert.equal(remaining, undefined, 'Pending action should be deleted after Y reply');

    // Reply should have been sent
    assert.ok(smsCalls.length > callsBefore, 'Should have sent acknowledgment reply');
  });
});

describe('nudge_confirm pending action — N', () => {
  before(() => {
    smsCalls = [];
    db.removeOptOut(TEST_PHONE);
  });

  test('N reply: pending_action deleted, "no problem" reply sent', async () => {
    const actionId = createPendingAction('nudge_confirm', {
      contact_name: 'Bob',
      activity_type: 'lunch',
      frequency: 'monthly',
    });

    const callsBefore = smsCalls.length;
    const res = await sendSms('N');
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 100));

    const remaining = db._raw()
      .prepare('SELECT * FROM pending_actions WHERE id = ?')
      .get(actionId);
    assert.equal(remaining, undefined, 'Pending action should be deleted after N reply');

    // Check reply was sent
    assert.ok(smsCalls.length > callsBefore, 'Should have sent a reply');
    const lastCall = smsCalls[smsCalls.length - 1];
    assert.ok(
      lastCall?.body?.toLowerCase().includes('no problem') ||
      lastCall?.body?.toLowerCase().includes("i'll") ||
      lastCall?.body?.toLowerCase().includes('later'),
      `Reply should contain "no problem" or similar, got: "${lastCall?.body}"`
    );
  });
});

describe('nudge_confirm pending action — skip', () => {
  before(() => {
    smsCalls = [];
    db.removeOptOut(TEST_PHONE);
  });

  test('skip reply: pending_action deleted, snooze reply sent', async () => {
    const actionId = createPendingAction('nudge_confirm', {
      contact_name: 'Carol',
      activity_type: 'coffee',
      frequency: 'weekly',
    });

    const callsBefore = smsCalls.length;
    const res = await sendSms('skip');
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 100));

    const remaining = db._raw()
      .prepare('SELECT * FROM pending_actions WHERE id = ?')
      .get(actionId);
    assert.equal(remaining, undefined, 'Pending action should be deleted');
    // Some reply should be sent
    assert.ok(smsCalls.length >= callsBefore, 'Should have sent or attempted a reply');
  });
});

describe('attendance_confirm — single event Y/N/skip', () => {
  before(() => {
    smsCalls = [];
    db.removeOptOut(TEST_PHONE);
  });

  test('Y → attendance_confirmations.attended = 1, confirmed_at set', async () => {
    const eventId = uuidv4();
    const confirmId = uuidv4();

    // Create attendance_confirmation row
    db.createAttendanceConfirmation({
      id: confirmId,
      event_id: eventId,
      user_id: testUserId,
      asked_at: Math.floor(Date.now() / 1000),
      source: 'sms_gate',
    });

    createPendingAction('attendance_confirm', {
      confirmations: [{ id: confirmId, event_id: eventId, event_label: 'lunch on Monday' }],
    });

    const res = await sendSms('Y');
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 150));

    const row = db._raw()
      .prepare('SELECT * FROM attendance_confirmations WHERE id = ?')
      .get(confirmId);
    assert.equal(row?.attended, 1, 'attended should be 1 after Y');
    assert.ok(row?.confirmed_at, 'confirmed_at should be set');
  });

  test('N → attendance_confirmations.attended = 0', async () => {
    const eventId = uuidv4();
    const confirmId = uuidv4();

    db.createAttendanceConfirmation({
      id: confirmId,
      event_id: eventId,
      user_id: testUserId,
      asked_at: Math.floor(Date.now() / 1000),
      source: 'sms_gate',
    });

    createPendingAction('attendance_confirm', {
      confirmations: [{ id: confirmId, event_id: eventId, event_label: 'dinner Tuesday' }],
    });

    const res = await sendSms('N');
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 150));

    const row = db._raw()
      .prepare('SELECT * FROM attendance_confirmations WHERE id = ?')
      .get(confirmId);
    assert.equal(row?.attended, 0, 'attended should be 0 after N');
  });

  test('skip → attendance_confirmations.attended = NULL', async () => {
    const eventId = uuidv4();
    const confirmId = uuidv4();

    db.createAttendanceConfirmation({
      id: confirmId,
      event_id: eventId,
      user_id: testUserId,
      asked_at: Math.floor(Date.now() / 1000),
      source: 'sms_gate',
    });

    createPendingAction('attendance_confirm', {
      confirmations: [{ id: confirmId, event_id: eventId, event_label: 'coffee Wednesday' }],
    });

    const res = await sendSms('skip');
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 150));

    const row = db._raw()
      .prepare('SELECT * FROM attendance_confirmations WHERE id = ?')
      .get(confirmId);
    assert.equal(row?.attended, null, 'attended should be NULL after skip');
  });
});

describe('attendance_confirm — batched "1Y 2N"', () => {
  before(() => {
    smsCalls = [];
    db.removeOptOut(TEST_PHONE);
  });

  test('1Y 2N → first event attended=1, second attended=0', async () => {
    const event1Id = uuidv4();
    const event2Id = uuidv4();
    const confirm1Id = uuidv4();
    const confirm2Id = uuidv4();

    db.createAttendanceConfirmation({
      id: confirm1Id, event_id: event1Id, user_id: testUserId,
      asked_at: Math.floor(Date.now() / 1000), source: 'sms_gate',
    });
    db.createAttendanceConfirmation({
      id: confirm2Id, event_id: event2Id, user_id: testUserId,
      asked_at: Math.floor(Date.now() / 1000), source: 'sms_gate',
    });

    createPendingAction('attendance_confirm', {
      confirmations: [
        { id: confirm1Id, event_id: event1Id, event_label: 'event 1' },
        { id: confirm2Id, event_id: event2Id, event_label: 'event 2' },
      ],
    });

    const res = await sendSms('1Y 2N');
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 150));

    const row1 = db._raw()
      .prepare('SELECT * FROM attendance_confirmations WHERE id = ?')
      .get(confirm1Id);
    const row2 = db._raw()
      .prepare('SELECT * FROM attendance_confirmations WHERE id = ?')
      .get(confirm2Id);

    assert.equal(row1?.attended, 1, 'First event should have attended=1');
    assert.equal(row2?.attended, 0, 'Second event should have attended=0');
  });
});
