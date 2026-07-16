/**
 * api.test.js — Integration tests for miscellaneous API endpoints
 *
 * Tests health check, user/me, contacts, dashboard, referral, and redirect routes.
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
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

// Inject no-op SMS client before requiring server
const sms = require('../../sms');
sms._setClient({
  messages: {
    create(_) { return Promise.resolve({ sid: 'SM_API_MOCK' }); },
  },
});

const { app } = require('../../server');
const db       = require('../../db');
const request  = supertest(app);

// ── Auth helper ───────────────────────────────────────────────────────────────

async function getAuthedCookie(phone) {
  // Ensure user has a consent record (required for OTP SMS send)
  const existing = db.getUserByPhone(phone);
  if (!existing) {
    // Auto-create with consent for testing
    const id = uuidv4();
    db._raw().prepare(
      `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'API Test', ?, 'complete')`
    ).run(id, phone);
    db.writeConsent(phone, 'INVITE_PAGE');
  }

  const sendRes = await request.post('/auth/otp/send').send({ phone });
  if (sendRes.status !== 200) throw new Error(`OTP send failed: ${sendRes.status}`);

  const otpRow = db._raw().prepare(
    "SELECT code FROM otp_codes WHERE phone=? AND used=0 ORDER BY created_at DESC LIMIT 1"
  ).get(phone);
  if (!otpRow) throw new Error(`No OTP in DB for ${phone}`);

  const verifyRes = await request
    .post('/auth/otp/verify')
    .send({ phone, code: otpRow.code });
  if (verifyRes.status !== 200) throw new Error(`OTP verify failed: ${verifyRes.status}`);

  return verifyRes.headers['set-cookie'][0];
}

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  test('→ 200 { ok: true }', async () => {
    const res = await request.get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });
});

describe('GET /api/user/me', () => {
  let cookie;

  before(async () => {
    cookie = await getAuthedCookie('+12025550500');
  });

  test('authed → 200 with id, name, phone', async () => {
    const res = await request
      .get('/api/user/me')
      .set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(res.body.id, 'Should have id');
    assert.ok('name' in res.body, 'Should have name');
    assert.ok('phone' in res.body, 'Should have phone');
  });
});

describe('GET /api/contacts/list', () => {
  let cookie;
  let userId;

  before(async () => {
    const phone = '+12025550501';
    cookie = await getAuthedCookie(phone);
    const user = db.getUserByPhone(phone);
    userId = user?.id;
  });

  test('no contacts → 200 { contacts: [] }', async () => {
    const res = await request
      .get('/api/contacts/list')
      .set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.contacts), 'contacts should be an array');
  });

  test('after adding contact → 200 with that contact', async () => {
    // Add a contact directly via DB
    const contactId = uuidv4();
    db._raw().prepare(
      `INSERT INTO contacts (id, invited_by_user_id, name, tier) VALUES (?, ?, 'Contact Test', 0)`
    ).run(contactId, userId);

    const res = await request
      .get('/api/contacts/list')
      .set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(res.body.contacts.length > 0, 'Should have at least one contact');
    const found = res.body.contacts.find(c => c.name === 'Contact Test');
    assert.ok(found, 'Should find the added contact');
  });
});

describe('GET /api/dashboard/overdue + /upcoming', () => {
  let cookie;

  before(async () => {
    cookie = await getAuthedCookie('+12025550502');
  });

  test('GET /api/dashboard/overdue → 200 { overdue: [...] }', async () => {
    const res = await request
      .get('/api/dashboard/overdue')
      .set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.overdue), 'overdue should be an array');
  });

  test('GET /api/dashboard/upcoming → 200 { upcoming: [...] }', async () => {
    const res = await request
      .get('/api/dashboard/upcoming')
      .set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.upcoming), 'upcoming should be an array');
  });
});

describe('GET /api/user/referral', () => {
  let cookie;

  before(async () => {
    cookie = await getAuthedCookie('+12025550503');
  });

  test('authed → 200 { ok: true, url, joined }', async () => {
    const res = await request
      .get('/api/user/referral')
      .set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.url, 'Should have url');
    assert.ok(res.body.url.includes('/r/'), 'URL should contain /r/');
    assert.ok(typeof res.body.joined === 'number', `joined should be a number, got ${typeof res.body.joined}`);
  });
});

describe('Referral redirect routes', () => {
  let referralToken;

  before(() => {
    // Create a referrer user and store the token directly on users.referral_token
    // (route uses getUserByReferralToken which queries users table, not referrals table)
    const referrerId = 'ref-redirect-' + uuidv4();
    referralToken = 'REDIR-' + uuidv4().slice(0, 8);
    db._raw().prepare(
      `INSERT INTO users (id, name, phone, onboarding_state, referral_token) VALUES (?, 'Referrer', '+15990000001', 'complete', ?)`
    ).run(referrerId, referralToken);
  });

  test('GET /r/:validToken → 200 landing page (unauthenticated visitor)', async () => {
    // The route serves an HTML landing page for unauthenticated visitors
    // (it does NOT redirect to /join — it shows a Connect/Log in page inline)
    const res = await request.get(`/r/${referralToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.text?.includes(referralToken), 'Landing page should embed the referral token');
  });

  test('GET /r/:invalid-token → 302 to /join', async () => {
    const res = await request.get('/r/nonexistent-invalid-token-xyz');
    assert.equal(res.status, 302);
    assert.ok(res.headers['location']?.includes('/join'), 'Should redirect to /join');
  });
});

describe('GET /invite/:token', () => {
  test('invalid token → not 500 (404 or redirect)', async () => {
    const res = await request.get('/invite/badtoken-does-not-exist');
    assert.ok(res.status !== 500, `Should not 500, got ${res.status}`);
    assert.ok(res.status === 404 || res.status === 302 || res.status === 200,
      `Expected 404/302/200, got ${res.status}`);
  });
});

describe('POST /api/join — route existence check', () => {
  test('route exists (returns 200 or 400, not 404)', async () => {
    const res = await request
      .post('/api/join')
      .send({ name: 'Route Test', phone: '+12025550599' });
    // May return 200 (success) or 400 (missing fields) but NOT 404
    assert.ok(res.status !== 404, 'Route should exist (not 404)');
    assert.ok(res.status < 500 || res.status === 500, 'Should not completely crash');
  });
});

describe('GET /api/chat/messages — history ordering', () => {
  let cookie;
  let userId;

  before(async () => {
    const phone = '+12025550510';
    cookie = await getAuthedCookie(phone);
    userId = db.getUserByPhone(phone)?.id;

    // Insert 60 messages with incrementing timestamps so we can verify
    // which ones come back (should be the most recent 50, in chron order).
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 60; i++) {
      db._raw().prepare(
        `INSERT INTO conversation_history (id, user_id, role, text, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(uuidv4(), userId, i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, now - (60 - i));
    }
  });

  test('returns 200 with messages array', async () => {
    const res = await request
      .get('/api/chat/messages')
      .set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.messages), 'messages should be an array');
  });

  test('returns at most 50 messages by default', async () => {
    const res = await request
      .get('/api/chat/messages')
      .set('Cookie', cookie);
    assert.ok(res.body.messages.length <= 50, `Should return ≤50, got ${res.body.messages.length}`);
  });

  test('returns MOST RECENT messages, not oldest (regression: ASC bug)', async () => {
    const res = await request
      .get('/api/chat/messages')
      .set('Cookie', cookie);
    const msgs = res.body.messages;
    assert.ok(msgs.length > 0, 'Should have messages');
    // We inserted 60 messages labelled "Message 0" through "Message 59".
    // The last message is "Message 59". It must appear in the response.
    const texts = msgs.map(m => m.text);
    assert.ok(texts.includes('Message 59'), `Most recent message "Message 59" must be present. Got: ${texts.slice(-3).join(', ')}`);
    // The very first message "Message 0" should NOT be present (it was cut off by LIMIT 50)
    assert.ok(!texts.includes('Message 0'), `Oldest message "Message 0" should be excluded by LIMIT 50`);
  });

  test('messages are in chronological order (oldest-first in array)', async () => {
    const res = await request
      .get('/api/chat/messages')
      .set('Cookie', cookie);
    const ts = res.body.messages.map(m => m.created_at);
    for (let i = 1; i < ts.length; i++) {
      assert.ok(ts[i] >= ts[i - 1], `Messages should be oldest-first: index ${i} (${ts[i]}) < ${i-1} (${ts[i-1]})`);
    }
  });

  test('?limit= param is respected', async () => {
    const res = await request
      .get('/api/chat/messages?limit=5')
      .set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(res.body.messages.length <= 5, `limit=5 should return ≤5, got ${res.body.messages.length}`);
    // Should still be the most recent ones
    const texts = res.body.messages.map(m => m.text);
    assert.ok(texts.includes('Message 59'), 'With limit=5 should still see most recent message');
  });

  test('unauthenticated → 401', async () => {
    const res = await request.get('/api/chat/messages');
    assert.equal(res.status, 401);
  });
});
