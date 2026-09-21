/**
 * invite-channel.test.js — Phase A #3: web-first invite routing.
 *
 * A ButterflAI user who is invited should be notified IN-APP (the invitation row
 * surfaces in their invited-events view + a best-effort push), NOT by SMS. SMS is
 * reserved for non-user contacts (the only channel to reach them). This keeps a
 * cohort of app users running on ~zero SMS.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.VAPID_PUBLIC_KEY;   // push is a silent no-op without VAPID
delete process.env.VAPID_PRIVATE_KEY;

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
const sent = [];
sms._setClient({ messages: { create({ to, body }) { sent.push({ to, body }); return Promise.resolve({ sid: 'SM_' + sent.length }); } } });

const db         = require('../../db');
const multiparty = require('../../multiparty');

function mkUser(phone, name, tz = 'America/New_York') {
  const existing = db.getUserByPhone(phone);
  if (existing) return existing;
  const id = uuidv4();
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', ?)`).run(id, name, phone, tz);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}

function futureTs() { return Math.floor(Date.now() / 1000) + 3 * 24 * 3600; }

describe('invite channel — users in-app, non-users by SMS', () => {
  let host;
  before(() => { host = mkUser('+12025550001', 'Host Channel'); });

  test('user-invitee gets NO SMS (in-app), invitation row still created', async () => {
    const invitee = mkUser('+12025550002', 'Invitee User');
    const cid = db.upsertContact({ invited_by_user_id: host.id, name: 'Invitee User', phone: invitee.phone, tier: 2 });
    const eid = multiparty.createEvent(host.id, { title: 'Dinner U', activity_type: 'dinner', scheduled_at: futureTs() });

    const before = sent.length;
    const res = await multiparty.inviteContacts(eid, [cid]);

    assert.ok(!sent.slice(before).some(m => m.to === invitee.phone), 'no SMS should reach a ButterflAI-user invitee');
    const inv = db._raw().prepare(
      `SELECT ei.status FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id=? AND c.phone=?`
    ).get(eid, invitee.phone);
    assert.equal(inv.status, 'invited', 'invitation row must still exist for the in-app view');
    assert.equal(res.sent, 1, 'still counts as invited');
  });

  test('non-user invitee IS sent an SMS with self-ID + STOP', async () => {
    const strangerPhone = '+12025559999';   // deliberately NOT a user
    const cid = db.upsertContact({ invited_by_user_id: host.id, name: 'Stranger', phone: strangerPhone, tier: 0 });
    const eid = multiparty.createEvent(host.id, { title: 'Dinner NU', activity_type: 'dinner', scheduled_at: futureTs() });

    const before = sent.length;
    await multiparty.inviteContacts(eid, [cid]);

    const toStranger = sent.slice(before).filter(m => m.to === strangerPhone);
    assert.equal(toStranger.length, 1, 'exactly one SMS to a non-user');
    assert.match(toStranger[0].body, /ButterflAI/, 'self-identifies');
    assert.match(toStranger[0].body, /STOP/i, 'includes STOP opt-out');
  });
});
