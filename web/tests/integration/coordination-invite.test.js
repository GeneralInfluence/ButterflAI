/**
 * coordination-invite.test.js — regression test for the confirm_coordination_invite
 * host-notification bug (found 2026-07-21 via the multi-agent simulator).
 *
 * Bug: executeTool('confirm_coordination_invite') referenced a bare `user` (and
 * `userTimezone`) that were never in scope — executeTool only receives `userId`.
 * `db.getContactByPhone(user.phone)` threw a ReferenceError AFTER the RSVP row was
 * written but BEFORE the host-notify inbound_message was queued. Net effect in prod:
 * the invitee showed "accepted", yet the host was never notified, and the agent
 * confabulated a calendar excuse from the swallowed error.
 *
 * Fix: resolve `const user = db.getUser(userId)` + `userTimezone` locally, matching
 * the message_agent case idiom. Before the fix this test throws (ReferenceError) and
 * no host-notify message is queued; after the fix it passes.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.ANTHROPIC_API_KEY;

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create() { return Promise.resolve({ sid: 'SM_TEST' }); } } });

const db         = require('../../db');
const multiparty = require('../../multiparty');
const agent      = require('../../agent');

function createUser(phone, name, timezone = 'America/New_York') {
  const existing = db.getUserByPhone(phone);
  if (existing) return existing;
  const id = uuidv4();
  db._raw().prepare(
    `INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', ?)`
  ).run(id, name, phone, timezone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}

// Host invites invitee; returns the invitation row id (the invitee's RSVP handle).
async function makeInvite(host, invitee, title) {
  const contactId = db.upsertContact({ invited_by_user_id: host.id, name: invitee.name, phone: invitee.phone, tier: 2 });
  const eventId = multiparty.createEvent(host.id, {
    title,
    activity_type: 'dinner',
    scheduled_at: Math.floor(Date.now() / 1000) + 3 * 24 * 3600,
  });
  await multiparty.inviteContacts(eventId, [contactId]);
  const inv = db._raw().prepare(
    `SELECT ei.id FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id=? AND c.phone=?`
  ).get(eventId, invitee.phone);
  return inv?.id;
}

describe('confirm_coordination_invite — host notification regression', () => {
  let host, invitee, acceptInv, declineInv;

  before(async () => {
    host    = createUser('+12025559001', 'Host Coord', 'America/Los_Angeles');
    invitee = createUser('+12025559002', 'Invitee Coord', 'America/New_York');
    acceptInv  = await makeInvite(host, invitee, 'Coord Dinner Accept');
    declineInv = await makeInvite(host, invitee, 'Coord Dinner Decline');
    assert.ok(acceptInv && declineInv, 'fixture: invitation rows should exist');
  });

  test('accepting does not throw, confirms RSVP, and queues a host notification', async () => {
    const before = db.getPendingInboundMessages().length;

    let result;
    await assert.doesNotReject(async () => {
      // add_to_calendar:true also exercises the userTimezone path (no calendar
      // connected → caught internally, RSVP still confirmed).
      result = await agent.executeTool(
        'confirm_coordination_invite',
        { invitation_id: acceptInv, status: 'accepted', add_to_calendar: true },
        invitee.id,
        invitee.phone,
      );
    }, 'must not throw (regression: bare `user`/`userTimezone` ReferenceError)');

    assert.equal(result.action_status, 'RSVP_CONFIRMED');
    assert.equal(result.rsvp_status, 'accepted');
    assert.equal(result.host_notified, true, 'host must be notified');

    // RSVP persisted
    const row = db._raw().prepare('SELECT status FROM event_invitations WHERE id=?').get(acceptInv);
    assert.equal(row.status, 'accepted');

    // The downstream effect the bug skipped: a host-notify message is queued for the host.
    const pending = db.getPendingInboundMessages();
    assert.ok(pending.length > before, 'a new host-notify message should be queued');
    const hostMsg = pending.find(m => m.from_id === host.id && /accepted/i.test(m.text || ''));
    assert.ok(hostMsg, 'queued host notification should target the host and mention the acceptance');
  });

  test('declining also notifies the host without throwing', async () => {
    const before = db.getPendingInboundMessages().length;

    let result;
    await assert.doesNotReject(async () => {
      result = await agent.executeTool(
        'confirm_coordination_invite',
        { invitation_id: declineInv, status: 'declined', add_to_calendar: false },
        invitee.id,
        invitee.phone,
      );
    });

    assert.equal(result.rsvp_status, 'declined');
    assert.equal(result.host_notified, true);

    const row = db._raw().prepare('SELECT status FROM event_invitations WHERE id=?').get(declineInv);
    assert.equal(row.status, 'declined');

    const pending = db.getPendingInboundMessages();
    assert.ok(pending.length > before, 'a new host-notify message should be queued for the decline');
    const hostMsg = pending.find(m => m.from_id === host.id && /declined/i.test(m.text || ''));
    assert.ok(hostMsg, 'queued host notification should mention the decline');
  });
});
