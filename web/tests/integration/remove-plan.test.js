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

// Then (2026-10-24): "the modal that came up looked like some kind of error … I just wanted to archive it. There should
// be options when I go to remove an event … I also can't swipe left on the event, which is supposed to bring up the modal."
describe('throw a plan away — with choices', () => {
  const opts = async (c, id) => (await request.get(`/api/plans/${id}/remove-options`).set('Cookie', c)).body.options.map((o) => o.action);
  test('a past plan: 📦 Archive — gone from your pills, lists and calendar, still there for everyone else, and it comes back', async () => {
    const sean = mkUser('Sean X'), mel = mkUser('Melanie X');
    const pm = multiparty.createEvent(mel.id, { title: 'Practical Magic', activity_type: 'movie', scheduled_at: Math.floor(Date.now() / 1000) - 86400 });
    db._raw().prepare("INSERT INTO event_invitations (id, event_id, contact_id, status) VALUES (?, ?, ?, 'accepted')").run(uuidv4(), pm, db.upsertContact({ invited_by_user_id: mel.id, name: 'Sean', phone: sean.phone, tier: 1 }));
    db.appendConversation(sean.id, 'user', 'pizza after'); db._raw().prepare("UPDATE conversation_history SET event_id = ? WHERE text = 'pizza after'").run(pm);
    const c = await cookieFor(sean);
    assert.deepEqual(await opts(c, pm), ['archive'], 'nothing else to do with a past plan');
    assert.deepEqual((await request.post(`/api/plans/${pm}/remove`).set('Cookie', c).send({ action: 'archive' })).body, { ok: true, done: 'archived' });
    assert.ok(!ids((await request.get('/api/chat/discussions').set('Cookie', c)).body.discussions).includes(pm), 'not in the pills');
    assert.ok(!ids((await request.get('/api/plans').set('Cookie', c)).body.plans).includes(pm), 'not on the calendar');
    assert.ok(!ids((await request.get('/api/events/invited/me').set('Cookie', c)).body.events).includes(pm), 'not in the list');
    assert.ok(plan.plansFor(mel.id, { includePast: true }).some((p) => p.id === pm), 'Melanie still has it');
    assert.deepEqual((await request.get('/api/plans/archived').set('Cookie', c)).body.plans.map((p) => p.title), ['Practical Magic']);
    await request.post(`/api/plans/${pm}/unarchive`).set('Cookie', c);
    assert.ok(ids((await request.get('/api/plans').set('Cookie', c)).body.plans).includes(pm), 'brought back');
  });
  test('a plan you host, still ahead: Archive (just for you) or Cancel it for everyone', async () => {
    const sean = mkUser('Sean H');
    const { eventId } = await planops.create(sean.id, { title: 'Dinner H', activity_type: 'dinner', when: 'tomorrow 7pm' }, { via: 'app' });
    const c = await cookieFor(sean);
    assert.deepEqual(await opts(c, eventId), ['archive', 'cancel']);
    await request.post(`/api/plans/${eventId}/remove`).set('Cookie', c).send({ action: 'archive' });
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(eventId).status, 'open', 'archiving changes nothing for anyone');
    await request.post(`/api/plans/${eventId}/unarchive`).set('Cookie', c);
    assert.equal((await request.post(`/api/plans/${eventId}/remove`).set('Cookie', c).send({ action: 'cancel' })).body.done, 'cancelled');
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(eventId).status, 'cancelled');
  });
  test('a plan you\'re invited to, still ahead: Archive or I\'m not going (no cancelling someone else\'s plan)', async () => {
    const sean = mkUser('Sean G'), allie = mkUser('Allie G');
    const { eventId } = await planops.create(allie.id, { title: 'Brunch G', activity_type: 'brunch', when: 'tomorrow 11am', contact_ids: [db.upsertContact({ invited_by_user_id: allie.id, name: 'Sean', phone: sean.phone, tier: 1 })] }, { via: 'app' });
    const c = await cookieFor(sean);
    assert.deepEqual(await opts(c, eventId), ['archive', 'not_going']);
    assert.equal((await request.post(`/api/plans/${eventId}/remove`).set('Cookie', c).send({ action: 'cancel' })).status, 400);
    assert.equal((await request.post(`/api/plans/${eventId}/remove`).set('Cookie', c).send({ action: 'not_going' })).body.done, 'not_going');
    assert.equal(db._raw().prepare("SELECT ei.status FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?").get(eventId, sean.phone).status, 'declined');
    assert.ok(!plan.plansFor(sean.id, { includePast: true }).some((p) => p.id === eventId));
  });
  test('someone else\'s plan can\'t be removed', async () => {
    const a = mkUser('A R'), b = mkUser('B R');
    const { eventId } = await planops.create(a.id, { title: 'Private R', activity_type: 'x' }, { via: 'app' });
    assert.equal((await request.post(`/api/plans/${eventId}/remove`).set('Cookie', await cookieFor(b)).send({ action: 'archive' })).status, 404);
  });
  test('the screens: an app-styled sheet (no browser pop-up); swipe or hold on Home cards, Events lists, calendar days, Details and pills; Archived list', () => {
    const read = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');
    const sr = read('swipe-remove.js');
    assert.doesNotMatch(sr, /window\.confirm|alert\(/, 'no browser dialogs');
    assert.match(sr, /id = 'bfly-rm'[\s\S]*Never mind/);
    assert.match(read('feedback.js'), /s\.src = '\/swipe-remove\.js'/, 'on every screen');
    assert.match(read('app/dashboard.html'), /needs-you" data-plan-id=[\s\S]*data-plan-id="\$\{esc\(i\.event_id\)\}" href="\$\{href\}"/);
    const ev = read('app/events.html');
    assert.match(ev, /el\.dataset\.planId = p\.id;/);
    assert.match(ev, /📦 Archived[\s\S]*Bring back/);
  });
});

// 🐛 #94/#95 (Sean, 2026-10-24): "I can't scroll the pills at the very top" / "When I try and scroll the pills at the top it
// opens up the modal. I should have to long press the pill." Every plan element was made pan-y (a sideways drag = swipe).
// 🐛 #93: "I created this and it's upcoming. Why isn't it over there in the upcoming area?" — a plan he's going to (Allie
// hosts it) was under Invited; Upcoming only listed plans he hosts.
describe('🐛 #93–#95: pills scroll; only holding a pill opens the sheet; Upcoming has every plan you\'re in', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');
  test('pills keep normal sideways scrolling and aren\'t swiped — press and hold only', () => {
    const sr = read('swipe-remove.js');
    assert.match(sr, /\[data-plan-id\]:not\(\.tpill\)\{touch-action:pan-y\}/);
    assert.match(sr, /if \(!el \|\| el\.classList\.contains\('tpill'\)\) return;   \/\/ pills scroll; hold them instead/);
    assert.match(sr, /Math\.hypot\(q\.clientX - holdAt\.x, q\.clientY - holdAt\.y\) > 10\) holdEnd\(\)/, 'scrolling cancels a hold');
  });
  test('Upcoming = plans you host + plans you\'re going to, still ahead; Invited = waiting on your answer', () => {
    const ev = read('app/events.html');
    assert.match(ev, /const going = invitedEvents\.filter\(e => e\.rsvp_status === 'accepted' && ahead\(e\)\);/);
    assert.match(ev, /renderInvited\(invitedEvents\.filter\(e => e\.rsvp_status === 'invited' && ahead\(e\)\)\);/);
    assert.match(ev, /e\.plan \? e\.plan\.stage !== 'past'/, 'a weekend still running today is upcoming');
  });
});
