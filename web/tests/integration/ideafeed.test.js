/**
 * ideafeed.test.js — the ✨ Feed tab (owner, 2026-10-20: "these suggestions should become a feed, a
 * social feed, and should have their own tab along the bottom … a never-ending feed that is constantly
 * being populated with stuff that Butterfly has found in their area or other people are up to, and is
 * constantly updated by the other people's inputs").
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'ideafeed-test';
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
const spells = require('../../spells');
const ideafeed = require('../../ideafeed');

let n = 0;
function mkUser(name, city = 'Truckee') {
  const phone = `+1202531${String(2000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, city) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', ?)`).run(uuidv4(), name, phone, city);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (o, u) => db.upsertContact({ invited_by_user_id: o.id, name: u.name, phone: u.phone, tier: 1 });
function idea(u, { kind = 'nearby', title, pub = title, status = 'new' }) {
  const id = uuidv4();
  db._raw().prepare(`INSERT INTO spells (id, user_id, kind, title, why, link, expires_at, public_title, status) VALUES (?, ?, ?, ?, 'w', 'https://example.com', ?, ?, ?)`)
    .run(id, u.id, kind, title, Math.floor(Date.now() / 1000) + 86400, pub, status);
  return id;
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}

describe('✨ Feed', () => {
  test('your ideas, then public ideas from around your town — most liked first, no one named, never other towns, avoid lists, or what you already have', () => {
    const me = mkUser('Sean F'); const a = mkUser('Ann F'); const b = mkUser('Bo F'); const c = mkUser('Cy F'); const far = mkUser('Far F', 'Boston'); const julie = mkUser('Julie F');
    idea(me, { title: 'Jazz at Shea’s with Kim?', pub: 'Jazz at Shea’s' });
    idea(a, { title: 'Trivia night with Bo?', pub: 'Trivia night at the Pub' });
    idea(b, { title: 'Bluegrass Saturday', status: 'kept' });
    idea(c, { title: 'Bluegrass Saturday', status: 'kept' });
    idea(a, { title: 'Jazz at Shea’s' });                                  // you already have it
    idea(a, { kind: 'reconnect', title: 'Lunch with Bo', pub: null });     // about a friend — never
    idea(far, { title: 'Boston harbor cruise' });
    idea(julie, { title: 'Julie’s pottery night' });
    idea(c, { title: 'Dismissed thing', status: 'dismissed' });
    require('../../avoid').addAvoid(me.id, knows(me, julie));
    const p = ideafeed.page(me.id);
    const titles = p.items.filter((i) => i.type === 'idea').map((i) => i.title);
    assert.deepEqual(titles, ['Jazz at Shea’s with Kim?', 'Bluegrass Saturday', 'Trivia night at the Pub']);
    const blue = p.items.find((i) => i.title === 'Bluegrass Saturday');
    assert.equal(blue.liked_by, 2);
    assert.ok(blue.id.startsWith('pool:') && blue.around);
    assert.ok(!JSON.stringify(p).includes('Bo?') && !JSON.stringify(p).includes('Ann'), 'public titles only');
  });
  test('a page at a time: the page sends what it showed; when it runs out it can ask for more', () => {
    const me = mkUser('Sean P'); const o = mkUser('Other P');
    for (let i = 0; i < 14; i++) idea(o, { title: `Thing ${i}` });
    const p1 = ideafeed.page(me.id);
    assert.equal(p1.items.length, ideafeed.PAGE);
    assert.equal(p1.done, false);
    const p2 = ideafeed.page(me.id, { seen: p1.items.map((i) => i.id) });
    assert.ok(p2.items.every((i) => !p1.items.some((x) => x.id === i.id)));
    assert.equal(p2.done, true);
    assert.equal(p2.can_imagine_more, true);
  });
  test('right now, on top: friends out near you (named), what people around you are out for, friends\' shares', async () => {
    const me = mkUser('Sean N'); const kim = mkUser('Kim N');
    knows(me, kim); knows(kim, me);
    const out = require('../../outnow');
    out.goOut(me.id, { up_for: ['skiing'], lat: 39.33, lng: -120.18 });
    out.goOut(kim.id, { up_for: ['snowboarding'], lat: 39.331, lng: -120.18 });
    require('../../feeling').sharePlan(kim.id, { text: 'Free tonight', until: 'tonight' });
    const items = ideafeed.page(me.id).items;
    assert.equal(items[0].type, 'friend_out');
    assert.match(items[0].title, /^Kim is out/);
    assert.ok(items.some((i) => i.type === 'around' && i.chips.includes('⛷️ snowboarding')));
    assert.ok(items.some((i) => i.type === 'share' && i.title === 'Kim: Free tonight'));
    assert.ok(!ideafeed.page(me.id, { seen: ['x'] }).items.some((i) => i.type !== 'idea'), 'right now only on the first page');
  });
  test('✨ Sounds nice on an idea found around you makes it yours and passes it on; ✕ hides it', async () => {
    const me = mkUser('Sean S'); const o = mkUser('Other S'); const friend = mkUser('Friend S');
    knows(me, friend); knows(friend, me);
    const oid = idea(o, { title: 'Sunset paddle Friday' });
    const c = await cookieFor(me);
    const r = await request.post('/api/spells/' + encodeURIComponent(`pool:${oid}`)).set('Cookie', c).send({ answer: 'wish' });
    assert.equal(r.status, 200);
    assert.equal(r.body.passed_on, 1);
    assert.ok(db._raw().prepare("SELECT 1 FROM wishes WHERE user_id = ? AND text = 'Sunset paddle Friday'").get(me.id));
    assert.equal(spells.forUser(friend.id)[0].title, 'Sunset paddle Friday');
    assert.ok(!ideafeed.page(me.id).items.some((i) => i.title === 'Sunset paddle Friday'), 'answered — gone from your feed');
    const other = idea(o, { title: 'Pottery wheel class', kind: 'new' });
    await request.post('/api/spells/' + encodeURIComponent(`pool:${other}`)).set('Cookie', c).send({ answer: 'dismiss' });
    assert.ok(!ideafeed.page(me.id).items.some((i) => i.title === 'Pottery wheel class'));
    const elsewhere = idea(mkUser('Far S', 'Boston'), { title: 'Boston thing' });
    assert.equal((await request.post('/api/spells/' + encodeURIComponent(`pool:${elsewhere}`)).set('Cookie', c).send({ answer: 'wish' })).status, 404);
  });
  test('the API and the tab', async () => {
    const me = mkUser('Sean T');
    const c = await cookieFor(me);
    const r = await request.post('/api/ideas').set('Cookie', c).send({ seen: [] });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
    assert.notEqual((await request.post('/api/ideas').send({})).status, 200);
    const page = await request.get('/app/feed').set('Cookie', c);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('IntersectionObserver') && page.text.includes("fetch('/api/spells/more'") && page.text.includes('<a href="/app/feed" class="active">'));
  });
});
