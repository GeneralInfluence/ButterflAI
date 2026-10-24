/**
 * apple-contacts.test.js — 🐛 #90 (Melanie, 2026-10-23): "I wanna be able to connect my Apple contacts list through my
 * iCloud. Where can I do that?" One Apple connection, like Google's: the same app-specific password brings in iCloud
 * contacts (CardDAV) and, unless they use Google Calendar, the calendar.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'apple-contacts-test';
process.env.KMS_PROVIDER = 'local';
process.env.KMS_MASTER_KEY_HEX = 'a'.repeat(64);
process.env.BASE_URL = 'https://butterflai.test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const supertest = require('supertest');

require('../../sms')._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const apple = require('../../apple-contacts');
const linktoken = require('../../linktoken');

let k = 0;
function mkUser(name) {
  const phone = `+1202545${String(1000 + k++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')").run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
const CARDS = [
  'BEGIN:VCARD\r\nVERSION:3.0\r\nN:McLaine;Allie;;;\r\nFN:Allie McLaine\r\nitem1.TEL;type=pref:(570) 267-7976\r\nEND:VCARD',
  'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Bam B\r\n am Rubble\r\nTEL;type=CELL:+1 202 656 7811\r\nTEL;type=HOME:202-555-0100\r\nEND:VCARD',
  'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nEND:VCARD',   // no number: kept by name
];
const fakeDav = { fetchAddressBooks: async () => [{ url: 'card' }], fetchVCards: async () => CARDS.map((data) => ({ data })) };
const names = (u) => db._raw().prepare("SELECT name, phone FROM contacts WHERE invited_by_user_id = ? AND import_source = 'apple' ORDER BY name, phone").all(u.id);

describe('🐛 #90: iCloud contacts', () => {
  test('vCards are read: name, every number, folded lines, no number = kept by name', () => {
    assert.deepEqual(apple.parseVCard(CARDS[0]), { name: 'Allie McLaine', phones: ['(570) 267-7976'] });
    assert.deepEqual(apple.parseVCard(CARDS[1]), { name: 'Bam Bam Rubble', phones: ['+1 202 656 7811', '202-555-0100'] });
    assert.deepEqual(apple.parseVCard(CARDS[2]), { name: 'Jane Doe', phones: [] });
  });
  test('Melanie connects iCloud: contacts come in (calendar too — she has no Google Calendar), and Settings says so', async () => {
    const mel = mkUser('Melanie A');
    apple._setClient(fakeDav);
    const cal = require('../../calendar'); const saved = [];
    const keep = { save: cal.saveAppleCredentials, tz: cal.getCalendarTimezone };
    cal.saveAppleCredentials = async (uid) => { saved.push(uid); }; cal.getCalendarTimezone = async () => null;
    const page = await request.get('/auth/apple/calendar?t=' + encodeURIComponent(linktoken.sign(mel.id, 'calendar', 600)));
    assert.match(page.text, /Connect Apple \(iCloud\)/); assert.match(page.text, /contacts<\/strong> and <strong>calendar/);
    const t = /name="t" value="([^"]+)"/.exec(page.text)[1];
    const r = await request.post('/auth/apple/calendar').type('form').send({ t, appleId: 'mel@icloud.com', appPassword: 'abcd-efgh-ijkl-mnop' });
    Object.assign(cal, { saveAppleCredentials: keep.save, getCalendarTimezone: keep.tz });
    assert.equal(r.status, 200); assert.match(r.text, /iCloud connected!/); assert.match(r.text, /4 contacts brought in/);
    assert.deepEqual(saved, [mel.id], 'her calendar too');
    assert.deepEqual(names(mel).map((x) => x.name), ['Allie McLaine', 'Bam Bam Rubble', 'Bam Bam Rubble', 'Jane Doe']);
    assert.ok(names(mel).some((x) => x.phone === '+15702677976'));
    const row = db._raw().prepare('SELECT ciphertext FROM apple_contacts WHERE user_id = ?').get(mel.id);
    assert.ok(row && !row.ciphertext.includes('abcd-efgh'), 'the password is stored only encrypted');
    const login = async (u) => { await request.post('/auth/otp/send').send({ phone: u.phone }); const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone); return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0]; };
    const conn = (await request.get('/api/user/connections').set('Cookie', await login(mel))).body.apple;
    assert.equal(conn.contacts, true); assert.ok(conn.contacts_synced_at);
    // Again: nothing doubled.
    assert.equal((await apple.sync(mel.id, { force: true })).imported, 0);
    apple._setClient(null);
  });
  test('someone on Google Calendar keeps it: iCloud brings contacts only', async () => {
    const sean = mkUser('Sean A');
    db._raw().prepare("INSERT INTO calendar_tokens (user_id, provider, ciphertext, iv, tag, wrapped_key) VALUES (?, 'google', 'x', 'y', 'z', 'w')").run(sean.id);
    apple._setClient(fakeDav);
    const page = await request.get('/auth/apple/calendar?t=' + encodeURIComponent(linktoken.sign(sean.id, 'calendar', 600)));
    assert.doesNotMatch(page.text, /and <strong>calendar/);
    const t = /name="t" value="([^"]+)"/.exec(page.text)[1];
    const r = await request.post('/auth/apple/calendar').type('form').send({ t, appleId: 's@icloud.com', appPassword: 'x' });
    apple._setClient(null);
    assert.equal(r.status, 200);
    assert.equal(db._raw().prepare('SELECT provider FROM calendar_tokens WHERE user_id = ?').get(sean.id).provider, 'google', 'Google Calendar untouched');
    assert.equal(names(sean).length, 4);
  });
  test('where to find it: People has "Bring in iCloud contacts"; the agent offers the iCloud link', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../../public/app/contacts.html'), 'utf8');
    assert.match(html, /href="\/auth\/apple\/calendar"[^>]*>🍎 Bring in iCloud contacts/);
    const u = mkUser('Mel L');
    const r = await agent.executeTool('get_contact_import_url', {}, u.id, u.phone);
    assert.equal(linktoken.verify(new URL(r.icloud_url).searchParams.get('t'), 'calendar'), u.id);
    assert.match(r.message, /Settings → People & groups → 🍎 Bring in iCloud contacts/);
  });
});

describe('🐛 #90 retro', () => {
  test('Melanie, who asked, is told where it is — once; someone who didn\'t ask isn\'t', async () => {
    const mel = mkUser('Melanie R'); const other = mkUser('Other R');
    db._raw().prepare("INSERT INTO feedback (user_id, rating, user_note) VALUES (?, 'down', 'I wanna be able to connect my Apple contacts list through my iCloud. Where can I do that?')").run(mel.id);
    const task = require('../../retro').TASKS.find((x) => x.id === '2026-10-23-icloud-contacts-answer');
    assert.equal(await task.run(mel), 'told');
    assert.equal(await task.run(other), 'not asked');
    assert.match(db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND kind = 'notice'").get(mel.id).text, /People & groups → 🍎 Bring in iCloud contacts/);
  });
});
