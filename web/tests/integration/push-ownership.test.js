/**
 * push-ownership.test.js — notifications per account on a shared browser; turning off.
 *
 * Regression (2026-10-08): after enabling notifications as Aphilos, logging in as Bam Bam
 * on the same browser showed "Notifications on" (greyed out) though the subscription
 * belonged to Aphilos, so Bam Bam couldn't enable his. There was also no way to turn off.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'push-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');

async function cookieFor(phone, name) {
  if (!db.getUserByPhone(phone)) {
    db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'complete')`).run(uuidv4(), name, phone);
    db.writeConsent(phone, 'INVITE_PAGE');
  }
  await request.post('/auth/otp/send').send({ phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(phone);
  return (await request.post('/auth/otp/verify').send({ phone, code })).headers['set-cookie'][0];
}

const SUB = { endpoint: 'https://push.example/browser-1', keys: { p256dh: 'p', auth: 'a' } };

describe('push subscription ownership', () => {
  let aphilos, bambam;
  before(async () => {
    aphilos = await cookieFor('+12025559601', 'Aphilos');
    bambam = await cookieFor('+12025559602', 'Bam Bam');
  });

  test('status tells each account whether this browser notifies THEM', async () => {
    await request.post('/api/push/subscribe').set('Cookie', aphilos).send(SUB);
    assert.deepEqual((await request.post('/api/push/status').set('Cookie', aphilos).send({ endpoint: SUB.endpoint })).body, { registered: true, mine: true });
    assert.deepEqual((await request.post('/api/push/status').set('Cookie', bambam).send({ endpoint: SUB.endpoint })).body, { registered: true, mine: false });
  });

  test('enabling as the other account takes the browser over', async () => {
    await request.post('/api/push/subscribe').set('Cookie', bambam).send(SUB);
    assert.equal((await request.post('/api/push/status').set('Cookie', bambam).send({ endpoint: SUB.endpoint })).body.mine, true);
    assert.equal((await request.post('/api/push/status').set('Cookie', aphilos).send({ endpoint: SUB.endpoint })).body.mine, false);
  });

  test("turning off removes only your own subscription", async () => {
    await request.post('/api/push/unsubscribe').set('Cookie', aphilos).send({ endpoint: SUB.endpoint });
    assert.equal((await request.post('/api/push/status').set('Cookie', bambam).send({ endpoint: SUB.endpoint })).body.mine, true, "Aphilos can't remove Bam Bam's");
    await request.post('/api/push/unsubscribe').set('Cookie', bambam).send({ endpoint: SUB.endpoint });
    assert.equal((await request.post('/api/push/status').set('Cookie', bambam).send({ endpoint: SUB.endpoint })).body.registered, false);
  });

  test('requires login', async () => {
    assert.equal((await request.post('/api/push/status').send({ endpoint: 'x' })).status, 401);
    assert.equal((await request.post('/api/push/unsubscribe').send({ endpoint: 'x' })).status, 401);
  });
});
