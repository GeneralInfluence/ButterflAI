/**
 * remove-plan.test.js — Sean, 2026-10-24: "I can't remove past events. I want to be able to swipe left to throw an event
 * away." Swipe a plan left (a card) or press and hold its pill → Remove. Past: gone from your lists, for you only. Ahead:
 * asks first — the host cancels it for everyone; a guest says they're not going.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'remove-plan-test';
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
const multiparty = require('../../multiparty');
const planops = require('../../planops');
const plan = require('../../plan');

let k = 0;
function mkUser(name) {
  const phone = `+1202549${String(1000 + k++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')").run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
const ids = (list) => list.map((p) => p.id || p.event_id);

describe('throw a plan away', () => {
  test('a past plan: gone from your pills, lists and calendar — still there for everyone else', async () => {
    const sean = mkUser('Sean X'), mel = mkUser('Melanie X');
    const pm = multiparty.createEvent(mel.id, { title: 'Practical Magic', activity_type: 'movie', scheduled_at: Math.floor(Date.now() / 1000) - 86400 });
    db._raw().prepare("INSERT INTO event_invitations (id, event_id, contact_id, status) VALUES (?, ?, ?, 'accepted')").run(uuidv4(), pm, db.upsertContact({ invited_by_user_id: mel.id, name: 'Sean', phone: sean.phone, tier: 1 }));
    db.appendConversation(sean.id, 'user', 'pizza after'); db._raw().prepare("UPDATE conversation_history SET event_id = ? WHERE text = 'pizza after'").run(pm);
    const c = await cookieFor(sean);
    assert.ok(ids((await request.get('/api/chat/discussions').set('Cookie', c)).body.discussions).includes(pm));
    const r = await request.post(`/api/plans/${pm}/remove`).set('Cookie', c).send({});
    assert.deepEqual(r.body, { ok: true, done: 'hidden' });
    assert.ok(!ids((await request.get('/api/chat/discussions').set('Cookie', c)).body.discussions).includes(pm), 'not in the pills');
    assert.ok(!ids((await request.get('/api/plans').set('Cookie', c)).body.plans).includes(pm), 'not on the calendar');
    assert.ok(!ids((await request.get('/api/events/invited/me').set('Cookie', c)).body.events).includes(pm), 'not in the list');
    assert.ok(plan.plansFor(mel.id, { includePast: true }).some((p) => p.id === pm), 'Melanie still has it');
  });
  test('a plan you host, still ahead: asks first, then cancels it for everyone', async () => {
    const sean = mkUser('Sean H');
    const { eventId } = await planops.create(sean.id, { title: 'Dinner H', activity_type: 'dinner', when: 'tomorrow 7pm' }, { via: 'app' });
    const c = await cookieFor(sean);
    const ask = await request.post(`/api/plans/${eventId}/remove`).set('Cookie', c).send({});
    assert.deepEqual(ask.body, { needs_confirm: 'cancel', message: 'Cancel “Dinner H” for everyone?' });
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(eventId).status, 'open', 'nothing yet');
    assert.equal((await request.post(`/api/plans/${eventId}/remove`).set('Cookie', c).send({ confirm: true })).body.done, 'cancelled');
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(eventId).status, 'cancelled');
  });
  test('a plan you\'re invited to, still ahead: asks first, then you\'re not going and it leaves your lists', async () => {
    const sean = mkUser('Sean G'), allie = mkUser('Allie G');
    const { eventId } = await planops.create(allie.id, { title: 'Brunch G', activity_type: 'brunch', when: 'tomorrow 11am', contact_ids: [db.upsertContact({ invited_by_user_id: allie.id, name: 'Sean', phone: sean.phone, tier: 1 })] }, { via: 'app' });
    const c = await cookieFor(sean);
    assert.equal((await request.post(`/api/plans/${eventId}/remove`).set('Cookie', c).send({})).body.needs_confirm, 'decline');
    assert.equal((await request.post(`/api/plans/${eventId}/remove`).set('Cookie', c).send({ confirm: true })).body.done, 'removed');
    assert.equal(db._raw().prepare("SELECT ei.status FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?").get(eventId, sean.phone).status, 'declined');
    assert.ok(!plan.plansFor(sean.id, { includePast: true }).some((p) => p.id === eventId));
  });
  test('someone else\'s plan can\'t be removed', async () => {
    const a = mkUser('A R'), b = mkUser('B R');
    const { eventId } = await planops.create(a.id, { title: 'Private R', activity_type: 'x' }, { via: 'app' });
    assert.equal((await request.post(`/api/plans/${eventId}/remove`).set('Cookie', await cookieFor(b)).send({ confirm: true })).status, 404);
  });
  test('the screens: cards and pills carry the plan; swipe left on cards, press and hold on pills', () => {
    const sr = fs.readFileSync(path.join(__dirname, '../../public/swipe-remove.js'), 'utf8');
    assert.match(sr, /🗑 Remove/); assert.match(sr, /\.tpill\[data-plan-id\]/); assert.match(sr, /needs_confirm/);
    assert.match(fs.readFileSync(path.join(__dirname, '../../public/plan-nav.js'), 'utf8'), /data-plan-id="\$\{esc\(d\.event_id\)\}"[\s\S]*s\.src = '\/swipe-remove\.js'/);
    assert.equal((fs.readFileSync(path.join(__dirname, '../../public/app/events.html'), 'utf8').match(/data-plan-id=/g) || []).length, 4);   // list (yours, past invites, invited) + calendar day
  });
});
