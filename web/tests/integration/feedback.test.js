/**
 * feedback.test.js — Phase B: the dev-user feedback loop capture + triage.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.ADMIN_PHONE;

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

describe('feedback capture', () => {
  test('POST /api/feedback requires auth', async () => {
    const r = await request.post('/api/feedback').send({ agent_message: 'x' });
    assert.equal(r.status, 401);
  });

  test('a user can flag a reply; it is stored new, with model + context', async () => {
    const cookie = await authCookie('+12025556701');
    const r = await request.post('/api/feedback').set('Cookie', cookie).send({ agent_message: 'scheduled the wrong day', note: 'I said Friday' });
    assert.equal(r.status, 200);
    assert.ok(r.body.id, 'returns an id');

    const row = db._raw().prepare('SELECT * FROM feedback WHERE id = ?').get(r.body.id);
    assert.equal(row.agent_message, 'scheduled the wrong day');
    assert.equal(row.user_note, 'I said Friday');
    assert.equal(row.status, 'new');
    assert.ok(row.context_json !== null, 'captures recent-conversation context for repro');
  });
});

describe('feedback triage (admin)', () => {
  test('non-admin cannot list; admin can list + set status', async () => {
    const userCookie = await authCookie('+12025556702');
    await request.post('/api/feedback').set('Cookie', userCookie).send({ agent_message: 'over-asked' });

    const forbidden = await request.get('/api/admin/feedback').set('Cookie', userCookie);
    assert.equal(forbidden.status, 403);

    const adminPhone = '+12025556799';
    process.env.ADMIN_PHONE = adminPhone;
    const adminCookie = await authCookie(adminPhone);

    const list = await request.get('/api/admin/feedback').set('Cookie', adminCookie);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.feedback) && list.body.feedback.length >= 1);

    const id = list.body.feedback[0].id;
    const patch = await request.patch('/api/admin/feedback/' + id).set('Cookie', adminCookie).send({ status: 'triaged' });
    assert.equal(patch.status, 200);
    assert.equal(db._raw().prepare('SELECT status FROM feedback WHERE id=?').get(id).status, 'triaged');

    delete process.env.ADMIN_PHONE;
  });
});

describe('test-user toggle', () => {
  test('PATCH /api/user/test-mode flips the flag; /api/user/me reflects it', async () => {
    const cookie = await authCookie('+12025556703');
    let me = await request.get('/api/user/me').set('Cookie', cookie);
    assert.equal(me.body.test_user, false, 'defaults off');

    const on = await request.patch('/api/user/test-mode').set('Cookie', cookie).send({ enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.test_user, true);

    me = await request.get('/api/user/me').set('Cookie', cookie);
    assert.equal(me.body.test_user, true, 'me reflects the toggle');

    const off = await request.patch('/api/user/test-mode').set('Cookie', cookie).send({ enabled: false });
    assert.equal(off.body.test_user, false);
  });

  test('rejects a non-boolean value', async () => {
    const cookie = await authCookie('+12025556704');
    const r = await request.patch('/api/user/test-mode').set('Cookie', cookie).send({ enabled: 'yes' });
    assert.equal(r.status, 400);
  });
});
