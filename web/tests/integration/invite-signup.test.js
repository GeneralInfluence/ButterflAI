/**
 * invite-signup.test.js — POST /api/invite/:token/signup always answers.
 *
 * Regression (prod, 2026-10-08): Sean invited "Bam Bam" (his Google Voice number,
 * which already had an account). Signup threw "UNIQUE constraint failed: users.phone"
 * as an unhandled rejection, the route never responded, and the page hung on
 * "Create my ButterflAI".
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'invite-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');

function mkUser(phone, name) {
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'complete')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
function newInvite(inviter) {
  const token = uuidv4().replace(/-/g, '');
  db.createInvite({ token, created_by_user_id: inviter.id, contact_name: 'Friend' });
  return token;
}

describe('invite signup', () => {
  let sean;
  before(() => { sean = mkUser('+12025559501', 'Sean'); });

  test('number that already has an account: 409 with login link, inviter connected, no crash', async () => {
    const bambam = mkUser('+12025559502', 'Bam Bam');
    const token = newInvite(sean);
    const r = await request.post(`/api/invite/${token}/signup`).send({ name: 'Bam Bam', phone: '(202) 555-9502' });
    assert.equal(r.status, 409);
    assert.equal(r.body.existing_account, true);
    assert.equal(r.body.login_url, '/app/login');
    assert.equal(db._raw().prepare('SELECT count(*) c FROM users WHERE phone = ?').get(bambam.phone).c, 1, 'no duplicate account');
    const link = db._raw().prepare('SELECT * FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(sean.id, bambam.phone);
    assert.ok(link, 'inviter now has them as a contact');
    assert.notEqual(db.getInvite(token).status, 'pending', 'invite resolved');
  });

  test('new number: account created with a normalized phone', async () => {
    const token = newInvite(sean);
    const r = await request.post(`/api/invite/${token}/signup`).send({ name: 'Jamie', phone: '(202) 555-9503' });
    assert.equal(r.status, 200);
    assert.ok(db.getUserByPhone('+12025559503'), 'stored as E.164');
  });

  test('invalid phone → 400 with a message', async () => {
    const r = await request.post(`/api/invite/${newInvite(sean)}/signup`).send({ name: 'X', phone: 'not a phone' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /valid phone/);
  });

  test('an unexpected failure still answers (500 JSON), never hangs', async () => {
    const token = newInvite(sean);
    const orig = db.createUser;
    db.createUser = () => { throw new Error('boom'); };
    try {
      const r = await request.post(`/api/invite/${token}/signup`).send({ name: 'Kim', phone: '(202) 555-9504' });
      assert.equal(r.status, 500);
      assert.ok(r.body.error);
    } finally { db.createUser = orig; }
  });
});

describe('send_contact_invite with a guessed contact id', () => {
  test('returns CONTACT_NOT_FOUND with lookup guidance instead of throwing', async () => {
    const u = mkUser('+12025559510', 'Inviter');
    const r = await agent.executeTool('send_contact_invite', { contact_id: 'bam-bam', context: 'test' }, u.id, u.phone);
    assert.equal(r.error, 'CONTACT_NOT_FOUND');
    assert.match(r.message, /lookup_contact/);
  });
});
