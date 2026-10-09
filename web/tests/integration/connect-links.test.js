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

  // Since 2026-10-09 every Google entry point connects Calendar + Contacts together
  // (owner: "everything Google should all be one"), so the state purpose is 'oauth:google'.
  test('a signed link starts it, and Google gets a signed state (not the userId) for Calendar + Contacts', async () => {
    for (const [path, purpose] of [['/auth/google', 'google'], ['/auth/google/calendar', 'calendar'], ['/auth/google/contacts', 'contacts']]) {
      const r = await request.get(path + '?t=' + encodeURIComponent(linktoken.sign(victim.id, purpose, 600)));
      assert.equal(r.status, 302, path);
      const loc = new URL(r.headers.location);
      assert.notEqual(stateOf(r.headers.location), victim.id);
      assert.equal(linktoken.verify(stateOf(r.headers.location), 'oauth:google'), victim.id, path);
      assert.ok(loc.searchParams.get('scope').includes('contacts.readonly') && loc.searchParams.get('scope').includes('calendar.events'));
    }
    // A link for something else (e.g. the Apple form) doesn't start a Google flow.
    assert.equal((await request.get('/auth/google?t=' + encodeURIComponent(linktoken.sign(victim.id, 'apple-form', 600)))).status, 401);
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
    // Since 2026-10-09 the import link is the one Google connection (Calendar + Contacts);
    // other_ways is the paste / .vcf page.
    const imp = await agent.executeTool('get_contact_import_url', {}, victim.id, victim.phone);
    assert.equal(linktoken.verify(new URL(imp.url).searchParams.get('t'), 'google'), victim.id);
    assert.equal(linktoken.verify(new URL(imp.other_ways).searchParams.get('t'), 'contacts'), victim.id);
    assert.ok(!imp.url.includes('userId=') && !imp.other_ways.includes('userId='));
  });
});

describe('one Google connection; Settings shows what is connected', () => {
  let sean, cookie;
  before(async () => {
    process.env.KMS_PROVIDER = 'local';
    process.env.KMS_MASTER_KEY_HEX = 'b'.repeat(64);
    sean = mkUser('+12025558802', 'Sean Conn');
    await request.post('/auth/otp/send').send({ phone: sean.phone });
    const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(sean.phone);
    cookie = (await request.post('/auth/otp/verify').send({ phone: sean.phone, code })).headers['set-cookie'][0];
  });

  test('before: nothing connected', async () => {
    const r = await request.get('/api/user/connections').set('Cookie', cookie);
    assert.deepEqual(r.body, { google: { calendar: false, contacts: false, contacts_synced_at: null }, apple: { calendar: false } });
  });

  test('the callback stores Calendar AND Contacts, syncs contacts, and says so', async () => {
    calendar.exchangeGoogleCode = async () => ({ tokens: { access_token: 'a', refresh_token: 'r' }, calendar: true, contacts: true });
    calendar.getCalendarTimezone = async () => 'America/Los_Angeles';
    require('googleapis').google.people = () => ({ people: { connections: { list: async () => ({ data: { connections: [
      { names: [{ displayName: 'Alex Spargo' }], phoneNumbers: [{ value: '+1 530 555 0142' }] }] } }) } } });
    const state = linktoken.sign(sean.id, 'oauth:google', 600);
    const r = await request.get(`/auth/google/callback?code=x&state=${encodeURIComponent(state)}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /Google connected/);
    assert.match(r.text, /Contacts ✓ — 1 new/);
    assert.ok(db._raw().prepare("SELECT 1 FROM contacts WHERE invited_by_user_id = ? AND name = 'Alex Spargo'").get(sean.id));
    const c = await request.get('/api/user/connections').set('Cookie', cookie);
    assert.equal(c.body.google.calendar, true);
    assert.equal(c.body.google.contacts, true);
    assert.ok(c.body.google.contacts_synced_at);
  });

  test('if only Calendar was ticked, the page says Contacts weren\'t shared', async () => {
    calendar.exchangeGoogleCode = async () => ({ tokens: { access_token: 'a2' }, calendar: true, contacts: false });
    const r = await request.get(`/auth/google/callback?code=x&state=${encodeURIComponent(linktoken.sign(sean.id, 'oauth:google', 600))}`);
    assert.match(r.text, /Contacts not shared/);
  });

  test('Sync contacts now', async () => {
    const r = await request.post('/api/contacts/sync').set('Cookie', cookie);
    assert.equal(r.body.synced, true);
  });

  test('Settings page renders the status rows and loads them', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/settings.html'), 'utf8');
    assert.ok(html.includes('id="google-status"') && html.includes('href="/auth/google"') && html.includes("fetch('/api/user/connections')"));
    assert.ok(!html.includes('Connect Google Calendar</a>'), 'no more static button');
    // Fully connected shows a quiet "reconnect" link, not a button that looks required.
    assert.ok(html.includes("gb.textContent = all ? 'reconnect'") && html.includes("gb.classList.toggle('conn-quiet', all)"));
    assert.ok(html.includes('New contacts sync automatically'));
  });
});
