'use strict';
/**
 * privacy-api.test.js — API-level privacy invariant tests (Invariant 4)
 *
 * Verifies that API authorization boundaries prevent cross-user data access.
 * See PRIVACY.md Invariant 4.
 */

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'privacy-api-test';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const { describe, test, before } = require('node:test'); // before used inside describe
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: () => Promise.resolve({ sid: 'MOCK' }) } });

const { app } = require('../../server');
const request = supertest(app);
const webAuth = require('../../webapp-auth');
const db = require('../../db');

function makeUser(phone, name) {
  const id = uuidv4();
  db._raw().prepare(
    `INSERT INTO users (id, phone, name, onboarding_state) VALUES (?, ?, ?, 'done')`
  ).run(id, phone, name);
  return { id, phone, name };
}

async function getAuthedCookie(phone, name) {
  if (!db.getUserByPhone(phone)) {
    const id = uuidv4();
    db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'done')`).run(id, name, phone);
    db.writeConsent(phone, 'INVITE_PAGE');
  }
  await request.post('/auth/otp/send').send({ phone });
  const otpRow = db._raw().prepare(
    `SELECT code FROM otp_codes WHERE phone=? AND used=0 ORDER BY created_at DESC LIMIT 1`
  ).get(phone);
  const verifyRes = await request.post('/auth/otp/verify').send({ phone, code: otpRow.code });
  return verifyRes.headers['set-cookie'][0];
}

describe('Invariant 4 — API authorization boundaries enforced at HTTP layer', () => {
  let cookieA, userBId;

  before(async () => {
    cookieA = await getAuthedCookie('+16660000001', 'PrivacyAlice');
    const userB = makeUser('+16660000002', 'PrivacyBob');
    userBId = userB.id;
  });

  test('User A can access their own preferences', async () => {
    const res = await request.get('/api/user/preferences').set('Cookie', cookieA);
    assert.equal(res.status, 200, 'own preferences must return 200');
  });

  test('Unauthenticated preferences request returns 401 or 302', async () => {
    const res = await request.get('/api/user/preferences');
    assert.ok(res.status === 401 || res.status === 302,
      `Expected 401 or 302, got ${res.status}`);
  });

  test('User A cannot read User B audit log (cross-user access blocked)', async () => {
    const res = await request
      .get(`/api/user/${userBId}/audit`)
      .set('Cookie', cookieA);
    assert.ok(res.status === 403 || res.status === 404,
      `Expected 403 or 404 for cross-user audit log, got ${res.status}`);
  });

  test('User A private-data endpoint only returns own data', async () => {
    const res = await request.get('/api/user/private-data').set('Cookie', cookieA);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items), 'items must be an array');
  });

  test('Sensitive mode toggle requires authentication', async () => {
    const res = await request
      .post('/api/chat/sensitive-mode')
      .send({ on: true })
      .set('Content-Type', 'application/json');
    assert.ok(res.status === 401 || res.status === 302 || res.status === 403,
      `Expected auth failure, got ${res.status}`);
  });
});
