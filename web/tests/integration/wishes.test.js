/**
 * wishes.test.js — ✨ Wishes (owner, 2026-10-20, 🐛 #35): "I'd like to make things I wish would
 * happen. They're not concrete plans … trying to cast a spell into the world." Decisions: it's
 * between the agents; a match only when it's both people's wish, and both hear; names only for
 * people close to you (saved each other); outside your circle, anonymous until both are open.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'wishes-test';
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
const wishes = require('../../wishes');
const plan = require('../../plan');

let n = 0;
let town = 'Reno';   // each test sets its own, so tests' wishes don't meet each other's
function mkUser(name, { city = town, lat = null, lng = null } = {}) {
  const phone = `+1202532${String(1000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, city, lat, lng) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', ?, ?, ?)`).run(uuidv4(), name, phone, city, lat, lng);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const save = (o, u, name = u.name) => db.upsertContact({ invited_by_user_id: o.id, name, phone: u.phone, tier: 1 });
const friends = (a, b) => { save(a, b); save(b, a); };
const notices = (u) => db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND kind = 'notice'").all(u.id).map((r) => r.text);
// The matcher model says every candidate is the same wish ("together": the name for doing it).
const sameWish = (together) => wishes._setClient({ messages: { create: async (req) => {
  const ids = [...req.messages[0].content.matchAll(/- ([0-9a-f-]{36}):/g)].map((m) => m[1]);
  return { content: [{ type: 'text', text: JSON.stringify({ matches: ids.map((id) => ({ id, together })) }) }] };
} } });

describe('who a wish may be matched with', () => {
  test('close (saved each other) → friend; near you and both open → nearby; otherwise nobody', () => {
    town = 'Town1';
    const me = mkUser('Sean W'); const allie = mkUser('Allie W'); const stranger = mkUser('Stranger W'); const far = mkUser('Far W', { city: 'Boston' });
    const shy = mkUser('Shy W'); const oneway = mkUser('Oneway W');
    friends(me, allie); save(me, oneway);
    const mine = wishes.add(me.id, { text: 'Hot springs this fall' }).wish;
    for (const u of [allie, stranger, far, oneway]) wishes.add(u.id, { text: 'Soak in hot springs' });
    wishes.add(shy.id, { text: 'Hot springs', open_to_new: false });
    const c = wishes.candidates(db._raw().prepare('SELECT * FROM wishes WHERE id = ?').get(mine.id));
    const kinds = Object.fromEntries(c.map((x) => [x.u.name, x.kind]));
    assert.deepEqual(kinds, { 'Allie W': 'friend', 'Stranger W': 'nearby', 'Oneway W': 'nearby' }, 'not Boston, not "only people I know"');
  });
  test('avoid lists apply both ways; no shared location → not nearby', () => {
    town = 'Town2';
    const me = mkUser('Sean A'); const julie = mkUser('Julie A'); const hidden = mkUser('Hidden A');
    db._raw().prepare('UPDATE users SET share_location = 0 WHERE id = ?').run(hidden.id);
    require('../../avoid').addAvoid(me.id, save(me, julie));
    const mine = wishes.add(me.id, { text: 'Salsa lessons' }).wish;
    wishes.add(julie.id, { text: 'Learn salsa' }); wishes.add(hidden.id, { text: 'Learn salsa' });
    assert.deepEqual(wishes.candidates(db._raw().prepare('SELECT * FROM wishes WHERE id = ?').get(mine.id)), []);
  });
});

describe('a shared wish: both hear; names only if close', () => {
  test('friends: both told by name; "Make it a plan" makes the plan with the other invited', async () => {
    town = 'Town3';
    const me = mkUser('Sean F'); const allie = mkUser('Allie F'); friends(me, allie);
    wishes.add(me.id, { text: 'Hot springs this fall' }); wishes.add(allie.id, { text: 'Soak in hot springs soon' });
    sameWish('Hot springs this fall');
    assert.ok(await wishes.match() >= 1);
    assert.match(notices(me).join('\n'), /✨ Allie wishes for this too: Hot springs this fall/);
    assert.match(notices(allie).join('\n'), /✨ Sean wishes for this too: Hot springs this fall/);
    const [m] = wishes.forUser(me.id).matches;
    assert.equal(m.who, 'Allie');
    const r = await wishes.answer(me.id, m.id, 'plan');
    assert.ok(r.event_id);
    const p = plan.planFor(r.event_id, allie.id);
    assert.equal(p.title, 'Hot springs this fall');
    assert.deepEqual(wishes.forUser(allie.id).mine.map((w) => w.status), ['planned']);
  });
  test('someone you don\'t know: anonymous ("someone in Reno") until BOTH are open; then names and a plan for the two', async () => {
    town = 'Town4';
    const me = mkUser('Sean N'); const zoe = mkUser('Zoe N');
    wishes.add(me.id, { text: 'Learn to salsa' }); wishes.add(zoe.id, { text: 'Salsa classes' });
    sameWish('Salsa classes');
    await wishes.match();
    assert.match(notices(me).join('\n'), /✨ Someone in Town\d+ wishes for this too: Salsa classes\. Open to meeting them\?/);
    assert.ok(!notices(me).join('\n').includes('Zoe') && !notices(zoe).join('\n').includes('Sean'), 'no names');
    const [m] = wishes.forUser(me.id).matches;
    assert.equal(m.who, null);
    assert.equal((await wishes.answer(me.id, m.id, 'open')).status, 'waiting');
    assert.equal(wishes.forUser(me.id).matches[0].waiting_on_them, true);
    assert.equal(wishes.forUser(zoe.id).matches[0].who, null, 'still anonymous to Zoe');
    const r = await wishes.answer(zoe.id, m.id, 'open');
    assert.equal(r.status, 'connected');
    assert.equal(wishes.forUser(me.id).matches[0].who, 'Zoe');
    assert.ok(plan.planFor(r.event_id, me.id), 'a plan for the two of them');
  });
  test('"Not now": the other person is never told', async () => {
    town = 'Town5';
    const me = mkUser('Sean X'); const kim = mkUser('Kim X'); friends(me, kim);
    wishes.add(me.id, { text: 'Cabin weekend' }); wishes.add(kim.id, { text: 'Cabin trip' });
    sameWish('Cabin weekend'); await wishes.match();
    const before = notices(kim).length;
    await wishes.answer(me.id, wishes.forUser(me.id).matches[0].id, 'no');
    assert.equal(wishes.forUser(me.id).matches.length, 0);
    assert.equal(notices(kim).length, before);
  });
  test('compared once; wishes end after 60 days', async () => {
    town = 'Town6';
    const me = mkUser('Sean O'); const b = mkUser('Bo O'); friends(me, b);
    wishes.add(me.id, { text: 'Board games night' }); wishes.add(b.id, { text: 'Board games' });
    let calls = 0;
    wishes._setClient({ messages: { create: async () => { calls++; return { content: [{ type: 'text', text: '{"matches":[]}' }] }; } } });
    await wishes.match(); const after = calls; await wishes.match();
    assert.equal(calls, after, 'no second comparison of the same pair');
    db._raw().prepare('UPDATE wishes SET expires_at = 1 WHERE user_id = ?').run(me.id);
    assert.ok(wishes.purgeOld() >= 1);
    assert.deepEqual(wishes.forUser(me.id).mine, []);
  });
});

describe('in the app and the agent', () => {
  test('Home: a wish box in Feeling; /api/wishes add, list, only-people-I-know, remove', async () => {
    town = 'Town7';
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/dashboard.html'), 'utf8');
    assert.ok(html.includes('✨ I wish… e.g. hot springs with friends this fall') && html.includes('function matchHtml(m)') && html.includes('Only people I know'));
    const u = mkUser('Sean H');
    await request.post('/auth/otp/send').send({ phone: u.phone });
    const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
    const cookie = (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
    const w = (await request.post('/api/wishes').set('Cookie', cookie).send({ text: 'See live music soon' })).body.wish;
    assert.equal((await request.patch(`/api/wishes/${w.id}`).set('Cookie', cookie).send({ open_to_new: false })).body.wish.open_to_new, false);
    assert.equal((await request.get('/api/feed').set('Cookie', cookie)).body.summary.feeling.line, '1 wish');
    assert.equal((await request.delete(`/api/wishes/${w.id}`).set('Cookie', cookie)).status, 200);
  });
  test('the agent records a wish, never turns it into a plan, never tells anyone else\'s', () => {
    town = 'Town8';
    const p = require('../../agent').buildSystemPrompt({ id: 'x', name: 'T', timezone: 'America/Los_Angeles' }, '');
    assert.match(p, /WISHES ARE NOT PLANS/);
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../agent.js'), 'utf8');
    assert.ok(src.includes("!toolLog.some((t) => t.name === 'manage_wishes' && !t.result?.error)"), 'not routed to a new plan');
  });
});
