/**
 * route-auth.test.js — routes that take a userId require login and only act for that user.
 *
 * Regression (2026-10-09): these trusted a userId from the URL or body with no login.
 * Anyone with a user's id could list their contacts (names + phones), their events, or
 * create events and send invites / texts as them. PRIVACY.md Invariant 4.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'route-auth-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
const texts = [];
sms._setClient({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' }; } } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');

function mkUser(phone, name) {
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'complete')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}

describe("one user's id can't be used to read or act for them", () => {
  let victim, attacker, cookie, contactId;
  before(async () => {
    victim = mkUser('+12025558701', 'Victim');
    attacker = mkUser('+12025558702', 'Attacker');
    contactId = db.upsertContact({ invited_by_user_id: victim.id, name: 'Friend', phone: '+12025558703', tier: 0 });
    cookie = await cookieFor(attacker);
  });

  const routes = () => [
    ['get', `/api/contacts/importable/${victim.id}`],
    ['get', `/api/contacts/active/${victim.id}`],
    ['get', `/api/contacts/import-url/${victim.id}`],
    ['get', `/api/events/${victim.id}`],
    ['get', `/api/events/${victim.id}/whatever`],
    ['get', `/api/venues/favorites/${victim.id}`],
    ['delete', `/api/venues/favorites/${victim.id}/x`],
    ['post', '/api/venues/favorites', { userId: victim.id, name: 'Bar' }],
    ['post', '/api/events', { userId: victim.id, title: 'Fake', activity_type: 'x', scheduled_at: Math.floor(Date.now() / 1000) + 9999, contactIds: [] }],
    ['post', '/api/contacts/add', { userId: victim.id, name: 'Planted', phone: '+12025558704' }],
    ['post', '/api/contacts/invite', { userId: victim.id, contactId: 'x' }],
    ['post', '/api/agent/invite/create', { userId: victim.id }],
  ];

  test('not logged in → 401 on every route', async () => {
    for (const [m, url, body] of routes()) {
      const r = await request[m](url).send(body || {});
      assert.equal(r.status, 401, `${m.toUpperCase()} ${url}`);
    }
  });

  test("logged in as someone else → 403, and nothing happens", async () => {
    texts.length = 0;   // (the login code text)
    for (const [m, url, body] of routes()) {
      const r = await request[m](url).set('Cookie', cookie).send(body || {});
      assert.equal(r.status, 403, `${m.toUpperCase()} ${url}`);
    }
    assert.equal(db._raw().prepare("SELECT count(*) c FROM social_events WHERE host_user_id = ?").get(victim.id).c, 0);
    assert.equal(db._raw().prepare("SELECT count(*) c FROM contacts WHERE invited_by_user_id = ? AND name = 'Planted'").get(victim.id).c, 0);
    assert.equal(texts.length, 0);
    assert.ok(contactId);
  });

  test('your own id still works', async () => {
    const own = await cookieFor(victim);
    assert.equal((await request.get(`/api/contacts/importable/${victim.id}`).set('Cookie', own)).status, 200);
    assert.equal((await request.post('/api/events').set('Cookie', own).send({ title: 'Mine', activity_type: 'x', scheduled_at: Math.floor(Date.now() / 1000) + 9999 })).status, 200);
  });
});
