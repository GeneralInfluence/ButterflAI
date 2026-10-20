/**
 * cancelled-plans-gone.test.js — Sean, 2026-10-20:
 *  🐛 #27 "When I asked to delete the hot tub event it said that it did it but I was still on that
 *  pill. … it should delete it and then revert to the general or all tab."
 *  🐛 #28 "Why are there two Liam's birthday parties?" — the duplicate was folded into the real one
 *  on Oct 12 (cancelled), but the Events list showed every plan you host, cancelled ones too.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'cancelled-gone-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const planops = require('../../planops');
const read = (f) => require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app', f), 'utf8');

let n = 0;
function mkUser(name) {
  const phone = `+1202536${String(4000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);

describe('🐛 #28: a combined or cancelled plan is gone from the Events list', () => {
  test('two "Liam\'s Birthday Party", one folded into the other → the list shows one', async () => {
    const sean = mkUser('Sean G');
    const keep = (await planops.create(sean.id, { title: "Liam's Birthday Party", scheduled_at: `${day(5)}T12:00:00-07:00` })).eventId;
    const dup = (await planops.create(sean.id, { title: "Liam's Party 2", proposed_dates: [{ from: day(5), to: day(5) }] })).eventId;
    planops.merge(sean.id, keep, dup);
    const hot = (await planops.create(sean.id, { title: 'Hot tub', scheduled_at: `${day(2)}T19:00:00-07:00` })).eventId;
    planops.update(sean.id, hot, { cancel: true }, { via: 'app' });
    const list = (await request.get(`/api/events/${sean.id}`).set('Cookie', await cookieFor(sean))).body.events.map((e) => e.id);
    assert.deepEqual(list, [keep]);
    assert.ok(read('events.html').includes("allEvents.filter(e => e.status !== 'cancelled')"));
  });
});

describe('🐛 #27: cancelling the plan you\'re talking in takes you back to All', () => {
  test('the pills drop it, and the chat leaves a pill that disappeared (with a note)', async () => {
    const sean = mkUser('Sean P');
    const hot = (await planops.create(sean.id, { title: 'Hot tub', scheduled_at: `${day(2)}T19:00:00-07:00` })).eventId;
    const cookie = await cookieFor(sean);
    assert.ok((await request.get('/api/chat/discussions').set('Cookie', cookie)).body.discussions.some((d) => d.event_id === hot));
    planops.update(sean.id, hot, { cancel: true }, { via: 'agent' });
    assert.ok(!(await request.get('/api/chat/discussions').set('Cookie', cookie)).body.discussions.some((d) => d.event_id === hot));
    const chat = read('chat.html');
    assert.ok(chat.includes("else if (pillWasThere) { location.replace('/app/chat?gone=1'); return; }") && chat.includes('if (topicEvent) loadPills();'));
    assert.ok(chat.includes('That plan was cancelled (or combined into another)'));
  });
});
