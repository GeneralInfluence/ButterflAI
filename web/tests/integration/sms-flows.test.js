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

// ── Contact routing: relay, dual-identity, dead-end fix ──────────────────────

const { routeInboundSms } = require('../../server');
const agent = require('../../agent');

describe('Inbound routing — pure contact relay', () => {
  const CONTACT_PHONE = '+12025550333';
  let contactId;

  before(() => {
    smsCalls = [];
    db.removeOptOut(CONTACT_PHONE);
    // A contact of the test user, NOT itself a registered user.
    contactId = db.upsertContact({
      invited_by_user_id: testUserId, name: 'Relay Contact', phone: CONTACT_PHONE, tier: 1,
    });
  });

  test('non-user contact with no open invite → honest ACK + queued contact row', async () => {
    assert.equal(db.getUserByPhone(CONTACT_PHONE), undefined, 'precondition: not a user');

    const reply = await routeInboundSms(CONTACT_PHONE, 'what time is the dinner?');
    assert.match(reply, /pass that along/i, 'contact gets the honest ACK');

    const row = db._raw().prepare(
      `SELECT * FROM inbound_messages WHERE from_id = ? AND from_type = 'contact'
       ORDER BY created_at DESC LIMIT 1`
    ).get(contactId);
    assert.ok(row, 'a contact-typed inbound row is queued for the agent loop');
    assert.equal(row.channel, 'sms');
    assert.equal(row.processed, 0, 'row is left for the agent loop to relay');
  });
});

describe('Inbound routing — dual identity (user + contact) is handled by their own agent', () => {
  const DUAL_PHONE = '+12025550444';
  let dualUserId, dualContactId, dualInviteId;

  before(() => {
    smsCalls = [];
    db.removeOptOut(DUAL_PHONE);
    dualUserId = 'dual-user-' + uuidv4();
    db._raw().prepare(
      `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Dual', ?, 'complete')`
    ).run(dualUserId, DUAL_PHONE);
    // Same phone also exists as a contact invited to the test user's event.
    dualContactId = db.upsertContact({ invited_by_user_id: testUserId, name: 'Dual', phone: DUAL_PHONE, tier: 1 });
    const eventId = 'dual-evt-' + uuidv4();
    db._raw().prepare(
      `INSERT INTO social_events (id, host_user_id, title, activity_type, scheduled_at, status)
       VALUES (?, ?, 'Dinner', 'dinner', strftime('%s','now') + 3600, 'open')`
    ).run(eventId, testUserId);
    dualInviteId = 'dual-inv-' + uuidv4();
    db._raw().prepare(
      `INSERT INTO event_invitations (id, event_id, contact_id, status, notified_at)
       VALUES (?, ?, ?, 'invited', strftime('%s','now'))`
    ).run(dualInviteId, eventId, dualContactId);
  });

  test('non-RSVP message routes to the user path (from_type=user), not the contact relay', async () => {
    const reply = await routeInboundSms(DUAL_PHONE, 'hey whats up');
    assert.equal(reply, null, 'established user → agent replies async, no sync ACK');

    const row = db._raw().prepare(
      `SELECT * FROM inbound_messages WHERE from_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(dualUserId);
    assert.ok(row, 'inbound row queued under the user id');
    assert.equal(row.from_type, 'user', 'dual identity is handled as the user, not a contact relay');
  });

  test('even an RSVP-like reply goes to their own agent; the router does NOT record it contact-side', async () => {
    // Rule B: a registered user acts only through their own agent. The router must
    // NOT short-circuit via handleRsvpReply — it leaves the invitation untouched
    // and queues the message for the user's own agent (which RSVPs via
    // confirm_coordination_invite). This also proves handleRsvpReply (and its
    // Claude call) is bypassed for dual-identity phones.
    const reply = await routeInboundSms(DUAL_PHONE, 'yes im in!');
    assert.equal(reply, null, 'no contact-side RSVP confirmation string');

    const inv = db._raw().prepare(`SELECT status FROM event_invitations WHERE id = ?`).get(dualInviteId);
    assert.equal(inv.status, 'invited', 'router left the invitation for the own-agent path to RSVP');

    const row = db._raw().prepare(
      `SELECT * FROM inbound_messages WHERE from_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(dualUserId);
    assert.equal(row.from_type, 'user', 'RSVP-like message still routed to the user, not relayed');
  });
});

describe('resolveContactRelay — the dead-end fix', () => {
  test('contact with a recent event invite relays to that event host', () => {
    const hostId = 'relay-host-' + uuidv4();
    db._raw().prepare(
      `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Host', '+12025550555', 'complete')`
    ).run(hostId);
    const cId = db.upsertContact({ invited_by_user_id: hostId, name: 'Guest', phone: '+12025550666', tier: 1 });

    const eventId = 'relay-evt-' + uuidv4();
    db._raw().prepare(
      `INSERT INTO social_events (id, host_user_id, title, activity_type, scheduled_at, status)
       VALUES (?, ?, 'Taco Tuesday', 'dinner', strftime('%s','now') + 3600, 'open')`
    ).run(eventId, hostId);
    db._raw().prepare(
      `INSERT INTO event_invitations (id, event_id, contact_id, status, notified_at)
       VALUES (?, ?, ?, 'invited', strftime('%s','now'))`
    ).run('relay-inv-' + uuidv4(), eventId, cId);

    const relayed = agent.resolveContactRelay({
      id: 'm1', from_type: 'contact', from_id: cId, channel: 'sms', text: 'what time?',
    });
    assert.ok(relayed, 'relay resolves');
    assert.equal(relayed.from_id, hostId, 'routed to the event host');
    assert.equal(relayed.from_type, 'user', 're-typed so processMessage resolves a user');
    assert.match(relayed.text, /\[Relayed SMS from your contact/, 'framed as a relay');
    assert.match(relayed.text, /Taco Tuesday/, 'includes the event context');
    assert.match(relayed.text, /what time\?/, 'carries the contact message');
  });

  test('contact with no event falls back to the inviter', () => {
    const inviterId = 'relay-inviter-' + uuidv4();
    db._raw().prepare(
      `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Inviter', '+12025550777', 'complete')`
    ).run(inviterId);
    const cId = db.upsertContact({ invited_by_user_id: inviterId, name: 'Orphan', phone: '+12025550888', tier: 1 });

    const relayed = agent.resolveContactRelay({
      id: 'm2', from_type: 'contact', from_id: cId, channel: 'sms', text: 'hi',
    });
    assert.ok(relayed, 'relay resolves via inviter fallback');
    assert.equal(relayed.from_id, inviterId, 'falls back to invited_by_user_id');
  });

  test('unknown contact id resolves to null (message is dropped, not dead-ended)', () => {
    const relayed = agent.resolveContactRelay({
      id: 'm3', from_type: 'contact', from_id: 'does-not-exist', channel: 'sms', text: 'hi',
    });
    assert.equal(relayed, null, 'no target → null (processMessage marks processed)');
  });
});
