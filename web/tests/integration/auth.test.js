/**
 * auth.test.js — Integration tests for OTP auth flow
 *
 * Tests the full OTP sign-in flow via supertest without sending real SMS.
 * Twilio sig bypass is active (NODE_ENV=test).
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

// Inject mock SMS client before requiring server (which requires sms.js)
const sms = require('../../sms');
const mockSmsClient = {
  messages: {
    create(_params) {
      return Promise.resolve({ sid: 'SM_MOCK_AUTH' });
    },
  },
};
sms._setClient(mockSmsClient);

// Now require server after mock is set
const { app } = require('../../server');
const db       = require('../../db');
const request  = supertest(app);

// ── Helper: full OTP auth → returns cookie string ────────────────────────────

async function getAuthedCookie(phone) {
  // Step 1: send OTP
  const sendRes = await request
    .post('/auth/otp/send')
    .send({ phone });
  if (sendRes.status !== 200) {
    throw new Error(`OTP send failed: ${sendRes.status} ${JSON.stringify(sendRes.body)}`);
  }

  // Step 2: fetch OTP from DB directly
  const otpRow = db._raw().prepare(
    "SELECT code FROM otp_codes WHERE phone=? AND used=0 ORDER BY created_at DESC LIMIT 1"
  ).get(phone);
  if (!otpRow) throw new Error(`No OTP found in DB for phone ${phone}`);

  // Step 3: verify OTP
  const verifyRes = await request
    .post('/auth/otp/verify')
    .send({ phone, code: otpRow.code });
  if (verifyRes.status !== 200) {
    throw new Error(`OTP verify failed: ${verifyRes.status} ${JSON.stringify(verifyRes.body)}`);
  }

  const cookies = verifyRes.headers['set-cookie'];
  if (!cookies || !cookies.length) throw new Error('No Set-Cookie header from OTP verify');
  return cookies[0]; // Return the first cookie (bfly_session=...)
}

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /auth/otp/send', () => {
  test('valid phone → 200 { ok: true }', async () => {
    const res = await request
      .post('/auth/otp/send')
      .send({ phone: '+12025550100' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  test('invalid phone → 400', async () => {
    const res = await request
      .post('/auth/otp/send')
      .send({ phone: 'not-a-phone' });
    assert.equal(res.status, 400);
  });

  test('missing phone → 400', async () => {
    const res = await request
      .post('/auth/otp/send')
      .send({});
    assert.equal(res.status, 400);
  });
});

describe('POST /auth/otp/verify', () => {
  const testPhone = '+12025550101';

  before(async () => {
    // Pre-send OTP so subsequent tests can use it
    await request.post('/auth/otp/send').send({ phone: testPhone });
  });

  test('correct code → 200 + Set-Cookie with bfly_session', async () => {
    const otpRow = db._raw().prepare(
      "SELECT code FROM otp_codes WHERE phone=? AND used=0 ORDER BY created_at DESC LIMIT 1"
    ).get(testPhone);
    assert.ok(otpRow, 'OTP row should exist in DB');

    const res = await request
      .post('/auth/otp/verify')
      .send({ phone: testPhone, code: otpRow.code });

    assert.equal(res.status, 200);
    assert.ok(res.body.ok === true);
    const cookies = res.headers['set-cookie'];
    assert.ok(cookies && cookies.length > 0, 'Should set a cookie');
    assert.ok(cookies[0].includes('bfly_session'), 'Cookie should contain bfly_session');
  });

  test('wrong code → 401', async () => {
    const res = await request
      .post('/auth/otp/verify')
      .send({ phone: testPhone, code: '000000' });
    assert.equal(res.status, 401);
  });

  test('expired code → 401', async () => {
    const expPhone = '+12025550102';

    // Send OTP to get one stored
    await request.post('/auth/otp/send').send({ phone: expPhone });

    // Manually expire it by setting expires_at to the past
    db._raw().prepare(
      "UPDATE otp_codes SET expires_at = 1 WHERE phone = ? AND used = 0"
    ).run(expPhone);

    const otpRow = db._raw().prepare(
      "SELECT code FROM otp_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1"
    ).get(expPhone);

    const res = await request
      .post('/auth/otp/verify')
      .send({ phone: expPhone, code: otpRow.code });
    assert.equal(res.status, 401);
  });
});

describe('Protected pages without cookie → 302 redirect', () => {
  test('GET /app/chat → 302 to /app/login', async () => {
    const res = await request.get('/app/chat');
    assert.equal(res.status, 302);
    assert.ok(res.headers['location']?.includes('/app/login'));
  });

  test('GET /app/dashboard → 302 to /app/login', async () => {
    const res = await request.get('/app/dashboard');
    assert.equal(res.status, 302);
    assert.ok(res.headers['location']?.includes('/app/login'));
  });

  test('GET /app/settings → 302 to /app/login', async () => {
    const res = await request.get('/app/settings');
    assert.equal(res.status, 302);
    assert.ok(res.headers['location']?.includes('/app/login'));
  });
});

describe('API endpoints without cookie', () => {
  test('GET /api/user/me without cookie → 401', async () => {
    const res = await request.get('/api/user/me');
    assert.equal(res.status, 401);
  });
});

describe('GET /api/user/me with valid cookie', () => {
  let cookie;

  before(async () => {
    cookie = await getAuthedCookie('+12025550103');
  });

  test('returns 200 with { id, name, phone }', async () => {
    const res = await request
      .get('/api/user/me')
      .set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(res.body.id, 'Should have id');
    assert.ok('name' in res.body, 'Should have name');
    assert.ok('phone' in res.body, 'Should have phone');
  });
});

describe('GET /auth/logout', () => {
  test('→ 302, clears cookie', async () => {
    const res = await request.get('/auth/logout');
    assert.equal(res.status, 302);
    // Cookie should be cleared (set with empty value or Max-Age=0)
    const cookies = res.headers['set-cookie'];
    if (cookies && cookies.length > 0) {
      const sessionCookie = cookies.find(c => c.includes('bfly_session'));
      if (sessionCookie) {
        assert.ok(
          sessionCookie.includes('Expires=Thu, 01 Jan 1970') ||
          sessionCookie.includes('Max-Age=0') ||
          sessionCookie.includes('bfly_session=;'),
          'Cookie should be cleared on logout'
        );
      }
    }
    // At minimum, it should redirect somewhere (login page)
    assert.ok(res.headers['location'], 'Should redirect');
  });
});
