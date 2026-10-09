/**
 * connect-links.test.js — calendar / contacts connect links act only for their user.
 *
 * Security fix (2026-10-09): the links and the Google OAuth `state` carried a bare
 * userId, so anyone could attach their own Google/Apple calendar or contacts to someone
 * else's ButterflAI (whose agent would then write that person's plans into the
 * attacker's calendar). Now: logged-in session, or a signed expiring link (linktoken.js).
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'connect-links-test';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.BASE_URL = 'https://butterflai.test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const linktoken = require('../../linktoken');
const calendar = require('../../calendar');

function mkUser(phone, name) {
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'complete')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const stateOf = (location) => new URL(location).searchParams.get('state');

describe('linktoken', () => {
  test('valid only for its user, purpose and lifetime; tampering fails', () => {
    const t = linktoken.sign('u1', 'calendar', 60);
    assert.equal(linktoken.verify(t, 'calendar'), 'u1');
    assert.equal(linktoken.verify(t, 'contacts'), null, 'other purpose');
    assert.equal(linktoken.verify(linktoken.sign('u1', 'calendar', -1), 'calendar'), null, 'expired');
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'victim', p: 'calendar', e: 9e9 })).toString('base64url');
    assert.equal(linktoken.verify(`${forged}.${sig}`, 'calendar'), null, 'forged body');
    assert.equal(linktoken.verify('victim', 'calendar'), null);
    assert.ok(body);
  });
});

describe('connect links', () => {
  let victim;
  before(() => { victim = mkUser('+12025558801', 'Victim C'); });

  test('a bare ?userId= no longer starts a connect flow (calendar, Apple, contacts)', async () => {
    for (const url of [`/auth/google/calendar?userId=${victim.id}`, `/auth/apple/calendar?userId=${victim.id}`, `/auth/google/contacts?userId=${victim.id}`]) {
      const r = await request.get(url);
      assert.equal(r.status, 401, url);
      assert.match(r.text, /This link has expired/);
    }
  });

  test('a signed link starts it, and Google gets a signed state (not the userId)', async () => {
    const r = await request.get('/auth/google/calendar?t=' + encodeURIComponent(linktoken.sign(victim.id, 'calendar', 600)));
    assert.equal(r.status, 302);
    const state = stateOf(r.headers.location);
    assert.notEqual(state, victim.id);
    assert.equal(linktoken.verify(state, 'oauth:gcal'), victim.id);
    const c = await request.get('/auth/google/contacts?t=' + encodeURIComponent(linktoken.sign(victim.id, 'contacts', 600)));
    assert.equal(linktoken.verify(stateOf(c.headers.location), 'oauth:gcontacts'), victim.id);
    // A calendar link can't be used for contacts.
    assert.equal((await request.get('/auth/google/contacts?t=' + encodeURIComponent(linktoken.sign(victim.id, 'calendar', 600)))).status, 401);
  });

  test('the Google callback rejects a forged state (bare userId, old "contacts:<id>" form)', async () => {
    for (const state of [victim.id, `contacts:${victim.id}`]) {
      const r = await request.get(`/auth/google/callback?code=x&state=${encodeURIComponent(state)}`);
      assert.equal(r.status, 401, state);
    }
  });

  test('Apple: the form needs its signed token; a posted userId does nothing', async () => {
    const saved = [];
    calendar.saveAppleCredentials = async (uid, creds) => { saved.push(uid); };
    calendar.getCalendarTimezone = async () => null;
    const bad = await request.post('/auth/apple/calendar').type('form').send({ userId: victim.id, appleId: 'a@b.c', appPassword: 'x' });
    assert.equal(bad.status, 401);
    const page = await request.get('/auth/apple/calendar?t=' + encodeURIComponent(linktoken.sign(victim.id, 'calendar', 600)));
    assert.equal(page.status, 200);
    const t = /name="t" value="([^"]+)"/.exec(page.text)[1];
    assert.ok(!page.text.includes(victim.id), 'no userId in the page');
    const ok = await request.post('/auth/apple/calendar').type('form').send({ t, appleId: 'a@b.c', appPassword: 'x' });
    assert.equal(ok.status, 200);
    assert.deepEqual(saved, [victim.id]);
  });

  test('links the agent sends are signed, not ?userId=', async () => {
    const imp = await agent.executeTool('get_contact_import_url', {}, victim.id, victim.phone);
    const t = new URL(imp.url).searchParams.get('t');
    assert.equal(linktoken.verify(t, 'contacts'), victim.id);
    assert.ok(!imp.url.includes('userId='));
  });
});
