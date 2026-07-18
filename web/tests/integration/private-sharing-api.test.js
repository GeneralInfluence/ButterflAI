'use strict';
/**
 * private-sharing-api.test.js — the per-contact sharing management API (code-gated by auth).
 * A grant/revoke through these endpoints is a direct, authenticated user action — no LLM.
 */

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'sharing-api-test';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: () => Promise.resolve({ sid: 'MOCK' }) } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const sensitive = require('../../sensitive');
const KEY = sensitive.HEALTH_NOTES_KEY;

async function authedCookie(phone, name) {
  if (!db.getUserByPhone(phone)) {
    const id = uuidv4();
    db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'done')`).run(id, name, phone);
    db.writeConsent(phone, 'INVITE_PAGE');
  }
  await request.post('/auth/otp/send').send({ phone });
  const otp = db._raw().prepare(`SELECT code FROM otp_codes WHERE phone=? AND used=0 ORDER BY created_at DESC LIMIT 1`).get(phone);
  const res = await request.post('/auth/otp/verify').send({ phone, code: otp.code });
  return res.headers['set-cookie'][0];
}

describe('Per-contact private-sharing API', () => {
  let cookieA, ownerId, friendUser, contactId;

  before(async () => {
    cookieA = await authedCookie('+15559990001', 'Owner A');
    ownerId = db.getUserByPhone('+15559990001').id;
    friendUser = { id: uuidv4(), phone: '+15559990002' };
    db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Friend B', ?, 'done')`).run(friendUser.id, friendUser.phone);
    sensitive.storePrivateData(ownerId, KEY, 'HIV negative, on PrEP', 'HEALTH');
    contactId = uuidv4();
    db.createContact({ id: contactId, invited_by_user_id: ownerId, name: 'Friend B', phone: friendUser.phone, tier: 2 });
  });

  test('GET lists the private item with no one shared initially', async () => {
    const res = await request.get('/api/user/private-sharing').set('Cookie', cookieA);
    assert.equal(res.status, 200);
    const item = res.body.items.find(i => i.data_key === KEY);
    assert.ok(item, 'health item listed');
    assert.equal(item.shared_with.length, 0);
    assert.ok(res.body.shareable_contacts.some(c => c.contact_id === contactId));
  });

  test('POST approve shares it; GET then shows the contact; the peer can read it', async () => {
    const res = await request.post('/api/user/private-sharing/approve').set('Cookie', cookieA).send({ data_key: KEY, contact_id: contactId });
    assert.equal(res.status, 200);
    assert.equal(sensitive.readPrivateDataForSharing(ownerId, KEY, friendUser.id).allowed, true);
    const list = await request.get('/api/user/private-sharing').set('Cookie', cookieA);
    const item = list.body.items.find(i => i.data_key === KEY);
    assert.ok(item.shared_with.some(c => c.contact_id === contactId && c.name === 'Friend B'));
  });

  test('POST revoke withdraws it', async () => {
    const res = await request.post('/api/user/private-sharing/revoke').set('Cookie', cookieA).send({ data_key: KEY, contact_id: contactId });
    assert.equal(res.status, 200);
    assert.equal(sensitive.readPrivateDataForSharing(ownerId, KEY, friendUser.id).allowed, false);
  });

  test('cannot approve using a contact that is not in the caller\'s address book', async () => {
    const cookieB = await authedCookie('+15559990003', 'Outsider C');
    // Outsider tries to use Owner A's contactId.
    const res = await request.post('/api/user/private-sharing/approve').set('Cookie', cookieB).send({ data_key: KEY, contact_id: contactId });
    assert.equal(res.status, 404);
  });

  test('unauthenticated requests are rejected', async () => {
    const res = await request.get('/api/user/private-sharing');
    assert.ok(res.status === 401 || res.status === 302 || res.status === 403, `expected auth rejection, got ${res.status}`);
  });
});
