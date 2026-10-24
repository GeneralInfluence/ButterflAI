/**
 * no-password.test.js — owner, 2026-10-23: "there's nowhere for her to add her contacts from her iPhone. She's able to add
 * her calendar. She has to remember her password and stuff, which sucks. It would be nice if there was some integrated
 * way to do that rather than making them remember something none of my friends have been able to remember."
 * Apple gives websites no sign-in for contacts or calendars, so: contacts from a file the iPhone exports, and plans on
 * the phone's calendar by subscribing to a private link.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'no-password-test';
process.env.BASE_URL = 'https://butterflai.test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { v4: uuidv4 } = require('uuid');
const supertest = require('supertest');

require('../../sms')._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const planops = require('../../planops');

let k = 0;
function mkUser(name) {
  const phone = `+1202547${String(1000 + k++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')").run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
const html = (f) => fs.readFileSync(path.join(__dirname, '../../public/app', f), 'utf8');

describe('contacts from an iPhone export — no password', () => {
  test('People offers it with the iPhone steps; the reader handles what the iPhone writes (item1.TEL, wrapped lines, no FN)', () => {
    const page = html('contacts.html');
    assert.match(page, /📇 From my iPhone — no password<input type="file" accept="\.vcf/);
    assert.match(page, /<b>Contacts<\/b> → <b>Lists<\/b>[\s\S]*<b>Export<\/b>/);
    const src = /    function parseVCards\(text\) \{[\s\S]*?\n    \}\n/.exec(page)[0];
    const ctx = {}; vm.runInNewContext(`${src}; out = parseVCards(input);`, Object.assign(ctx, {
      input: 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:McLaine;Allie;;;\r\nFN:Allie McLa\r\n ine\r\nitem1.TEL;type=pref:(570) 267-7976\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nTEL;type=CELL:+1 202 555 0100\r\nEND:VCARD\r\n' }));
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.out)), [{ name: 'Allie McLaine', phone: '(570)267-7976' }, { name: 'Jane Doe', phone: '+12025550100' }]);
    assert.match(page, /i \+= 400/, 'big lists go in batches');
  });
});

describe('plans on the phone\'s calendar — a link to subscribe to', () => {
  test('Settings → Add makes a private link; the calendar shows her plans; the link can be turned off', async () => {
    const mel = mkUser('Melanie C');
    const when = new Date(Date.now() + 3 * 86400000).toISOString();
    await planops.create(mel.id, { title: 'Practical Magic', activity_type: 'movie', scheduled_at: when, venue_name: 'Mel’s place' }, { via: 'app' });
    const c = await cookieFor(mel);
    const { link } = (await request.post('/api/user/cal-feed').set('Cookie', c).send({})).body;
    assert.match(link.webcal, /^webcal:\/\/butterflai\.test\/cal\/[0-9a-f]{48}\.ics$/);
    const r = await request.get(new URL(link.https).pathname);
    assert.equal(r.status, 200); assert.match(r.headers['content-type'], /text\/calendar/);
    assert.match(r.text, /X-WR-CALNAME:ButterflAI plans/);
    assert.match(r.text, /SUMMARY:Practical Magic/); assert.match(r.text, /LOCATION:Mel’s place/); assert.match(r.text, /BEGIN:VEVENT[\s\S]*DTSTART:\d{8}T\d{6}Z/);
    assert.equal((await request.get('/cal/' + 'f'.repeat(48) + '.ics')).status, 404, 'a wrong link shows nothing');
    await request.post('/api/user/cal-feed').set('Cookie', c).send({ off: true });
    assert.equal((await request.get(new URL(link.https).pathname)).status, 404, 'turned off');
    assert.match(html('settings.html'), /My plans on my phone's calendar — no password/);
  });
});
