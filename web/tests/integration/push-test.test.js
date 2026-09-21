/**
 * push-test.test.js — POST /api/push/test (the self-verify test-notification route).
 * Requires auth; reports why it can't send when the server isn't configured.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create() { return Promise.resolve({ sid: 'SM' }); } } });

const { app } = require('../../server');
const db      = require('../../db');
const request = supertest(app);

async function authCookie(phone) {
  if (!db.getUserByPhone(phone)) {
    db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'T', ?, 'complete')`).run(uuidv4(), phone);
    db.writeConsent(phone, 'INVITE_PAGE');
  }
  await request.post('/auth/otp/send').send({ phone });
  const row = db._raw().prepare("SELECT code FROM otp_codes WHERE phone=? AND used=0 ORDER BY created_at DESC LIMIT 1").get(phone);
  const v = await request.post('/auth/otp/verify').send({ phone, code: row.code });
  return v.headers['set-cookie'][0];
}

describe('POST /api/push/test', () => {
  test('requires auth', async () => {
    const r = await request.post('/api/push/test');
    assert.equal(r.status, 401);
  });

  test('authed returns not_configured when VAPID is unset', async () => {
    const cookie = await authCookie('+12025556601');
    const r = await request.post('/api/push/test').set('Cookie', cookie);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'not_configured');
  });
});
