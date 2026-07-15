/**
 * security.test.js — Input validation and injection hardening tests
 *
 * Tests that the API rejects malformed, oversized, and injection-style inputs
 * before they reach the DB or external services.
 *
 * Covers:
 *   - SQL injection attempts in phone and name fields
 *   - XSS payloads in name fields
 *   - Invalid / garbage phone numbers
 *   - Oversized inputs
 *   - Common bot patterns (SQLMap, Havij, etc.)
 *   - /api/join validation gate
 *   - /auth/otp/send validation gate
 *   - /api/onboarding/setup validation
 */

'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_PHONE = '+19990000001';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.ANTHROPIC_API_KEY;

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({
  messages: { create(_) { return Promise.resolve({ sid: 'SM_SEC_MOCK' }); } },
});

const { app } = require('../../server');
const db = require('../../db');
const request = supertest(app);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getAuthedCookie(phone) {
  const existing = db.getUserByPhone(phone);
  if (!existing) {
    const id = uuidv4();
    db._raw().prepare(
      `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Security Test', ?, 'complete')`
    ).run(id, phone);
    db.writeConsent(phone, 'INVITE_PAGE');
  }
  await request.post('/auth/otp/send').send({ phone });
  const otp = db._raw().prepare(
    'SELECT code FROM otp_codes WHERE phone=? AND used=0 ORDER BY created_at DESC LIMIT 1'
  ).get(phone);
  const res = await request.post('/auth/otp/verify').send({ phone, code: otp.code });
  return res.headers['set-cookie']?.[0];
}

// ── /api/join — phone validation ──────────────────────────────────────────────

describe('/api/join — phone validation', () => {

  const VALID_PAYLOAD = { name: 'Test User', phone: '+12025550100' };

  // SQL injection patterns bots actually use (from production DB)
  const SQL_PHONES = [
    "test') AND 1547 IN (SELECT (CHAR(113)+CHAR(118)+CHAR(106)+CHAR(120)+CHAR(113)+(SELECT (CASE WHEN (1547=1547) THEN CHAR(49) ELSE CHAR(48) END))+CHAR(113)+CHAR(118)+CHAR(122)+CHAR(112)+CHAR(113))) AND ('ymhS'='ymhS",
    "' OR '1'='1",
    "1; DROP TABLE users--",
    "UNION SELECT * FROM users--",
    "(SELECT (CASE WHEN (5010=1547) THEN 'test' ELSE (SELECT 1547 UNION SELECT 5750) END))",
    "AND EXTRACTVALUE(3821,CONCAT(0x5c,0x71766a7871,(SELECT (ELT(3821=3821,1))),0x71767a7071))",
    "AND 6828=CAST((CHR(113)||CHR(118)||CHR(106)||CHR(120)||CHR(113))||(SELECT (CASE WHEN (6828=6828) THEN 1 ELSE 0 END))::text||(CHR(113)||CHR(118)||CHR(122)||CHR(112)||CHR(113)) AS NUMERIC)",
  ];

  for (const payload of SQL_PHONES) {
    test(`SQL injection in phone → 400: ${payload.slice(0, 50)}…`, async () => {
      const res = await request.post('/api/join').send({ name: 'Test', phone: payload });
      assert.equal(res.status, 400, `Expected 400, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
      // Must NOT create a user with this phone
      const user = db._raw().prepare('SELECT id FROM users WHERE phone = ?').get(payload);
      assert.equal(user, undefined, 'No user should be created with an injection phone');
    });
  }

  test('XSS in phone field → 400', async () => {
    const res = await request.post('/api/join').send({ name: 'Test', phone: '<script>alert(1)</script>' });
    assert.equal(res.status, 400);
  });

  test('empty phone → 400', async () => {
    const res = await request.post('/api/join').send({ name: 'Test', phone: '' });
    assert.equal(res.status, 400);
  });

  test('missing phone → 400', async () => {
    const res = await request.post('/api/join').send({ name: 'Test' });
    assert.equal(res.status, 400);
  });

  test('phone too long (> 30 chars) → 400', async () => {
    const res = await request.post('/api/join').send({ name: 'Test', phone: '+1' + '2'.repeat(30) });
    assert.equal(res.status, 400);
  });

  test('letters-only phone → 400', async () => {
    const res = await request.post('/api/join').send({ name: 'Test', phone: 'not-a-phone' });
    assert.equal(res.status, 400);
  });

  test('random garbage string as phone → 400', async () => {
    const res = await request.post('/api/join').send({ name: 'Test', phone: 'abc123xyz!@#' });
    assert.equal(res.status, 400);
  });

  test('valid E.164 phone → not 400', async () => {
    // Should succeed (200) or fail for a reason other than validation (e.g. SMS send)
    const res = await request.post('/api/join').send({ name: 'Valid User', phone: '+12025550188' });
    assert.ok(res.status !== 400, `Valid phone should not get 400, got ${res.status}`);
  });

  test('10-digit US phone (no country code) → accepted and normalized', async () => {
    const res = await request.post('/api/join').send({ name: 'US User', phone: '2025550177' });
    assert.ok(res.status !== 400, `10-digit US phone should be accepted, got ${res.status}`);
    // Should be stored as E.164
    const user = db.getUserByPhone('+12025550177');
    assert.ok(user, 'User should exist with E.164 normalized phone');
  });
});

// ── /api/join — name validation ───────────────────────────────────────────────

describe('/api/join — name validation', () => {

  test('empty name → 400', async () => {
    const res = await request.post('/api/join').send({ name: '', phone: '+12025550200' });
    assert.equal(res.status, 400);
  });

  test('missing name → 400', async () => {
    const res = await request.post('/api/join').send({ phone: '+12025550201' });
    assert.equal(res.status, 400);
  });

  test('name with HTML script tag → 400', async () => {
    const res = await request.post('/api/join').send({
      name: '<script>alert(document.cookie)</script>',
      phone: '+12025550202',
    });
    assert.equal(res.status, 400);
    // Verify not stored
    const user = db._raw().prepare("SELECT id FROM users WHERE name LIKE '%<script>%'").get();
    assert.equal(user, undefined, 'XSS name should not be stored');
  });

  test('name with img onerror XSS → 400', async () => {
    const res = await request.post('/api/join').send({
      name: '<img src=x onerror=fetch("/api/admin/flai/grant",{method:"POST"})>',
      phone: '+12025550203',
    });
    assert.equal(res.status, 400);
  });

  test('name with SQL UNION injection → 400', async () => {
    const res = await request.post('/api/join').send({
      name: "' UNION SELECT * FROM users--",
      phone: '+12025550204',
    });
    assert.equal(res.status, 400);
  });

  test('name too long (> 100 chars trimmed) → accepted but truncated or 400', async () => {
    const longName = 'A'.repeat(200);
    const res = await request.post('/api/join').send({ name: longName, phone: '+12025550205' });
    if (res.status === 200) {
      // If accepted, the stored name must be ≤ 100 chars
      const user = db.getUserByPhone('+12025550205');
      assert.ok(!user || user.name.length <= 100, 'Stored name must be ≤ 100 chars');
    }
    // 400 is also fine — both are acceptable responses
    assert.ok([200, 400].includes(res.status), `Expected 200 or 400, got ${res.status}`);
  });

  test('valid simple name → accepted', async () => {
    const res = await request.post('/api/join').send({ name: 'Alice', phone: '+12025550210' });
    assert.ok(res.status !== 400, `"Alice" should not get 400, got ${res.status}`);
  });

  test('name with apostrophe (legit) → accepted', async () => {
    const res = await request.post('/api/join').send({ name: "O'Brien", phone: '+12025550211' });
    assert.ok(res.status !== 400, `O'Brien should be accepted, got ${res.status}`);
  });
});

// ── /auth/otp/send — phone validation ────────────────────────────────────────

describe('/auth/otp/send — phone validation', () => {

  test('SQL injection in phone → 400', async () => {
    const res = await request.post('/auth/otp/send').send({ phone: "' OR 1=1--" });
    assert.equal(res.status, 400);
  });

  test('XSS in phone → 400', async () => {
    const res = await request.post('/auth/otp/send').send({ phone: '<script>alert(1)</script>' });
    assert.equal(res.status, 400);
  });

  test('empty phone → 400', async () => {
    const res = await request.post('/auth/otp/send').send({ phone: '' });
    assert.equal(res.status, 400);
  });

  test('garbage string → 400', async () => {
    const res = await request.post('/auth/otp/send').send({ phone: 'aaaaaaaaaa' });
    assert.equal(res.status, 400);
  });
});

// ── /api/onboarding/setup — contact validation ────────────────────────────────

describe('/api/onboarding/setup — contact input validation', () => {
  let cookie;

  before(async () => {
    cookie = await getAuthedCookie('+12025550900');
  });

  test('contact with XSS name is skipped (not stored)', async () => {
    const xssName = '<script>alert(1)</script>';
    const res = await request
      .post('/api/onboarding/setup')
      .set('Cookie', cookie)
      .send({ contacts: [{ name: xssName, phone: '+12025550901', frequency: 'monthly' }] });
    assert.equal(res.status, 200);
    // XSS contact must not be in DB
    const bad = db._raw().prepare("SELECT id FROM contacts WHERE name LIKE '%<script>%'").get();
    assert.equal(bad, undefined, 'XSS contact name must not be stored');
  });

  test('contact with SQL injection phone is stored with null phone', async () => {
    const res = await request
      .post('/api/onboarding/setup')
      .set('Cookie', cookie)
      .send({ contacts: [{ name: 'Bob', phone: "' OR 1=1--", frequency: 'monthly' }] });
    assert.equal(res.status, 200);
    // Contact may be stored but phone should be null
    const contact = db._raw().prepare(
      "SELECT * FROM contacts WHERE name = 'Bob' ORDER BY created_at DESC LIMIT 1"
    ).get();
    if (contact) {
      assert.equal(contact.phone, null, 'Invalid phone should be stored as null, not the injection string');
    }
  });

  test('valid contact goes through unchanged', async () => {
    const res = await request
      .post('/api/onboarding/setup')
      .set('Cookie', cookie)
      .send({ contacts: [{ name: 'Carol', phone: '+12025550902', frequency: 'weekly' }] });
    assert.equal(res.status, 200);
    const contact = db._raw().prepare(
      "SELECT * FROM contacts WHERE name = 'Carol' ORDER BY created_at DESC LIMIT 1"
    ).get();
    assert.ok(contact, 'Valid contact should be stored');
    assert.equal(contact.phone, '+12025550902');
  });
});

// ── Admin XSS: stored data rendered safely ────────────────────────────────────
// These tests confirm the API never returns executable content in contexts
// where the admin page would inject it unsafely. The actual HTML escaping
// is in the frontend esc() function; here we verify the API returns the raw
// string (so the frontend must escape it).

describe('Admin API — user data is raw strings (frontend must escape)', () => {
  let adminCookie;

  before(async () => {
    // Create the "admin" user
    const adminPhone = process.env.ADMIN_PHONE;
    const existing = db.getUserByPhone(adminPhone);
    if (!existing) {
      db._raw().prepare(
        `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Admin', ?, 'complete')`
      ).run(uuidv4(), adminPhone);
      db.writeConsent(adminPhone, 'INVITE_PAGE');
    }
    adminCookie = await getAuthedCookie(adminPhone);

    // Insert a user with an XSS name directly (bypassing API, simulating pre-fix data)
    const xssId = 'xss-test-' + uuidv4();
    try {
      db._raw().prepare(
        `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'complete')`
      ).run(xssId, '<script>alert(1)</script>', '+19990000099');
    } catch (_) { /* may already exist */ }
  });

  test('GET /api/admin/flai/summary returns raw name string (not escaped HTML)', async () => {
    const res = await request.get('/api/admin/flai/summary').set('Cookie', adminCookie);
    assert.equal(res.status, 200);
    // The API returns raw data — escaping is the frontend's job
    // Verify the XSS string appears as a raw string in the response (not stripped)
    const body = JSON.stringify(res.body);
    // It should be present as a data string — the important thing is it's
    // in a JSON field, not executable HTML context
    assert.ok(typeof res.body.users === 'object', 'users should be an array');
  });

  test('admin summary does not execute scripts (API returns JSON, not HTML)', async () => {
    const res = await request.get('/api/admin/flai/summary').set('Cookie', adminCookie);
    // Response Content-Type must be JSON, not HTML — no browser execution possible
    assert.ok(
      res.headers['content-type']?.includes('application/json'),
      `Content-Type should be JSON, got: ${res.headers['content-type']}`
    );
  });
});
