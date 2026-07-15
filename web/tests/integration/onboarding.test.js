/**
 * onboarding.test.js — Integration tests for web signup and onboarding flows
 *
 * Tests POST /api/join and POST /api/onboarding/setup.
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
    create(_) { return Promise.resolve({ sid: 'SM_ONBOARD_MOCK' }); },
  },
});

const { app } = require('../../server');
const db       = require('../../db');
const { BASELINE_GRANT } = require('../../flai');
const request  = supertest(app);

// ── Auth helper ───────────────────────────────────────────────────────────────

async function getAuthedCookie(phone) {
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

describe('POST /api/join — basic flow', () => {
  test('valid join → 200 { ok: true }, user exists, consent written, FLAI granted', async () => {
    const phone = '+12025550300';
    const name  = 'Test User';

    const res = await request
      .post('/api/join')
      .send({ name, phone });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);

    // Give async ops time (welcome SMS, referral grant)
    await new Promise(r => setTimeout(r, 100));

    // User should exist in DB
    const user = db.getUserByPhone(phone);
    assert.ok(user, 'User should exist in DB');
    assert.equal(user.name, name);
    assert.equal(user.phone, phone);

    // Consent record should exist
    const consent = db.getConsent(phone);
    assert.ok(consent, 'Consent record should exist');
    assert.equal(consent.consent_source, 'INVITE_PAGE');

    // FLAI baseline grant should exist
    const balance = db.getFlaiBalance(user.id);
    assert.ok(balance > 0, `FLAI balance should be > 0, got ${balance}`);
  });

  test('missing name → 400', async () => {
    const res = await request
      .post('/api/join')
      .send({ phone: '+12025550302' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'Should return error message');
  });

  test('missing phone → 400', async () => {
    const res = await request
      .post('/api/join')
      .send({ name: 'No Phone User' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'Should return error message');
  });

  test('opted-out phone → 400 with helpful message', async () => {
    const phone = '+12025550303';
    db.recordOptOut(phone, 'stop_reply');

    const res = await request
      .post('/api/join')
      .send({ name: 'Opted Out User', phone });

    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'Should return error message');
    assert.ok(
      res.body.error.toLowerCase().includes('opt') ||
      res.body.error.toLowerCase().includes('start') ||
      res.body.error.toLowerCase().includes('subscrib'),
      `Error should mention opt-out, got: "${res.body.error}"`
    );
  });
});

describe('POST /api/join — with referral', () => {
  test('referral token → referral row updated with referred_user_id and status joined or rewarded', async () => {
    // Setup: create referrer user + referral row
    const referrerId = 'referrer-' + uuidv4();
    const referrerPhone = '+12025550304';
    db._raw().prepare(
      `INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Referrer', ?, 'complete')`
    ).run(referrerId, referrerPhone);
    db.writeConsent(referrerPhone, 'INVITE_PAGE');

    const referralId = uuidv4();
    const referralToken = 'TESTTOKEN123';

    // Clean up any existing referral with this token
    db._raw().prepare("DELETE FROM referrals WHERE referral_token = ?").run(referralToken);

    db.createReferral({
      id: referralId,
      referrer_user_id: referrerId,
      referral_token: referralToken,
    });

    const referredPhone = '+12025550305';
    const res = await request
      .post('/api/join')
      .send({ name: 'Referred User', phone: referredPhone, ref: referralToken });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);

    await new Promise(r => setTimeout(r, 100));

    // Referral row should be updated
    const referral = db.getReferralByToken(referralToken);
    assert.ok(referral, 'Referral row should exist');
    // grantReferral() runs synchronously in the request, so status may already be 'rewarded'
    assert.ok(['joined', 'rewarded'].includes(referral.status), `Status should be joined or rewarded, got ${referral.status}`);

    const referredUser = db.getUserByPhone(referredPhone);
    assert.ok(referredUser, 'Referred user should exist');
    assert.equal(referral.referred_user_id, referredUser.id, 'referred_user_id should match');
  });
});

describe('POST /api/onboarding/setup', () => {
  let cookie;
  let setupUserId;

  before(async () => {
    // Create authed user for onboarding setup tests
    const phone = '+12025550306';
    cookie = await getAuthedCookie(phone);
    const user = db.getUserByPhone(phone);
    setupUserId = user?.id;
  });

  test('valid setup → 200 { ok: true }, contact+relationship+cadence created', async () => {
    const contactPhone = '+12025550400';
    const res = await request
      .post('/api/onboarding/setup')
      .set('Cookie', cookie)
      .send({
        contacts: [{
          name: 'Alice',
          phone: contactPhone,
          frequency: 'monthly',
        }],
      });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);

    // Contact should exist
    const contacts = db.getContactsByUser(setupUserId);
    const alice = contacts.find(c => c.name === 'Alice');
    assert.ok(alice, 'Alice contact should exist');

    // Relationship should exist
    const rels = db._raw()
      .prepare('SELECT * FROM relationships WHERE user_id = ?')
      .all(setupUserId);
    assert.ok(rels.length > 0, 'Should have at least one relationship');

    // Cadence with frequency monthly should exist
    const cadences = db._raw().prepare(`
      SELECT c.* FROM cadences c
      JOIN relationships r ON c.relationship_id = r.id
      WHERE r.user_id = ?
    `).all(setupUserId);
    const monthlyCadence = cadences.find(c => c.frequency === 'monthly');
    assert.ok(monthlyCadence, 'Monthly cadence should exist');

    // User onboarding_state should be complete
    const user = db.getUser(setupUserId);
    assert.equal(user?.onboarding_state, 'complete', 'Onboarding state should be complete');
  });

  test('unauthenticated request → 302 or 401', async () => {
    const res = await request
      .post('/api/onboarding/setup')
      .send({ contacts: [{ name: 'Bob', frequency: 'weekly' }] });
    assert.ok(res.status === 302 || res.status === 401,
      `Expected 302 or 401, got ${res.status}`);
  });
});
