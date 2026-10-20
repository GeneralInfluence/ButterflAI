/**
 * outnow.test.js — 🌴 I'm out (owner, 2026-10-20, at Lake Tahoe: "it would be nice if there was …
 * hey, there's a few potential connections around. You could reach out to somebody and just have a
 * drink or have a coffee or have dinner or sit on the beach and have a six-pack").
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'outnow-test';
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
const out = require('../../outnow');
const plan = require('../../plan');

let n = 0;
function mkUser(name) {
  const phone = `+1202529${String(3000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const save = (o, u) => db.upsertContact({ invited_by_user_id: o.id, name: u.name, phone: u.phone, tier: 1 });
const friends = (a, b) => { save(a, b); save(b, a); };
const notices = (u) => db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND kind = 'notice'").all(u.id).map((r) => r.text);
// Kings Beach and Tahoe City — about 15 km apart; Kings Beach spots ~1–2 km apart.
let base = 0;
const spot = (dLat = 0) => ({ lat: 39.237 + base + dLat, lng: -120.026 });
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}

describe('🌴 I\'m out — who\'s near you now', () => {
  test('going out needs what you\'re up for and where you are; meeting new people needs 18+; location rounded to ~1 km', () => {
    base += 5;
    const me = mkUser('Sean O1');
    assert.equal(out.goOut(me.id, { up_for: [], ...spot() }).error, 'UP_FOR');
    assert.equal(out.goOut(me.id, { up_for: ['drink'], lat: NaN, lng: 1 }).error, 'LOCATION');
    assert.equal(out.goOut(me.id, { up_for: ['drink'], ...spot(), open_to_new: true }).error, 'ADULT');
    assert.equal(out.goOut(me.id, { up_for: ['drink', 'hang'], lat: 39.23712345, lng: -120.02687 }).ok, true);
    assert.deepEqual(db._raw().prepare('SELECT lat, lng FROM out_now WHERE user_id = ?').get(me.id), { lat: 39.24, lng: -120.03 });
  });
  test('friends nearby are named; others only when you\'re BOTH open to new people and up for the same; far, avoided, or not open → not shown', () => {
    base += 5;
    const me = mkUser('Sean O2'); const allie = mkUser('Allie O2'); const zoe = mkUser('Zoe O2'); const shy = mkUser('Shy O2');
    const far = mkUser('Far O2'); const julie = mkUser('Julie O2');
    friends(me, allie);
    require('../../avoid').addAvoid(me.id, save(me, julie));
    out.goOut(me.id, { up_for: ['drink'], ...spot(), open_to_new: true, adult: true });
    out.goOut(allie.id, { up_for: ['coffee'], ...spot(0.01) });
    out.goOut(zoe.id, { up_for: ['drink', 'hang'], ...spot(0.03), open_to_new: true, adult: true });
    out.goOut(shy.id, { up_for: ['drink'], ...spot(0.01) });
    out.goOut(far.id, { up_for: ['drink'], ...spot(0.3), open_to_new: true, adult: true });
    out.goOut(julie.id, { up_for: ['drink'], ...spot(0.01), open_to_new: true, adult: true });
    const v = out.nearby(me.id);
    assert.deepEqual(v.friends.map((f) => [f.name, f.up_for, f.distance]), [['Allie', '☕ coffee', 'under a mile']]);
    assert.deepEqual(v.others.map((o) => [o.up_for, o.distance]), [['🍺 a drink', '~2 mi']]);
    assert.notEqual(v.others[0].id, zoe.id, 'a token, not their account');
  });
  test('the API never shows another person\'s account or location', async () => {
    base += 5;
    const me = mkUser('Sean O3'); const zoe = mkUser('Zoe O3');
    out.goOut(me.id, { up_for: ['drink'], ...spot(), open_to_new: true, adult: true });
    out.goOut(zoe.id, { up_for: ['drink'], ...spot(0.01), open_to_new: true, adult: true });
    const body = JSON.stringify((await request.get('/api/out').set('Cookie', await cookieFor(me))).body);
    assert.ok(!body.includes(zoe.id) && !body.includes('lat') && !body.includes('Zoe'));
  });
  test('someone nearby: "I\'m interested" reaches them only if they\'re interested too — then first names and a plan to meet', async () => {
    base += 5;
    const me = mkUser('Sean O4'); const zoe = mkUser('Zoe O4');
    out.goOut(me.id, { up_for: ['drink'], ...spot(), open_to_new: true, adult: true });
    out.goOut(zoe.id, { up_for: ['drink'], ...spot(0.01), open_to_new: true, adult: true });
    const first = await out.reach(me.id, out.nearby(me.id).others[0].id);
    assert.equal(first.status, 'waiting');
    assert.equal(notices(zoe).length, 0, 'Zoe hears nothing from a one-sided interest');
    const r = await out.reach(zoe.id, out.nearby(zoe.id).others[0].id);
    assert.equal(r.status, 'met');
    assert.equal(r.name, 'Sean');
    assert.match(notices(me).join('\n'), /You're both up for it: Zoe is nearby and interested too — 🍺 a drink/);
    const p = plan.planFor(r.event_id, zoe.id);
    assert.match(p.title, /^A drink with Sean — tonight$/);
    assert.match(p.notes, /somewhere public/);
  });
  test('a friend: "Say hi" asks them by name; "I\'m in" → a plan for the two; "Not now" tells nobody', async () => {
    base += 5;
    const me = mkUser('Sean O5'); const allie = mkUser('Allie O5'); const bam = mkUser('Bam O5');
    friends(me, allie); friends(me, bam);
    out.goOut(me.id, { up_for: ['drink'], ...spot() });
    out.goOut(allie.id, { up_for: ['drink'], ...spot(0.01) });
    out.goOut(bam.id, { up_for: ['drink'], ...spot(0.01) });
    await out.reach(me.id, allie.id); await out.reach(me.id, bam.id);
    assert.match(notices(allie).join('\n'), /👋 Sean is out near you and up for 🍺 a drink/);
    const [ask] = out.nearby(allie.id).asks;
    const r = await out.answer(allie.id, ask.id, true);
    assert.ok(plan.planFor(r.event_id, me.id));
    assert.match(notices(me).join('\n'), /🙌 Allie is in/);
    const before = notices(me).length;
    await out.answer(bam.id, out.nearby(bam.id).asks[0].id, false);
    assert.equal(notices(me).length, before, 'Bam\'s "Not now" tells Sean nothing');
  });
  test('Stop (or the outing ending) deletes your location', () => {
    base += 5;
    const me = mkUser('Sean O6');
    out.goOut(me.id, { up_for: ['coffee'], ...spot(), hours: 1 });
    db._raw().prepare('UPDATE out_now SET until = 1 WHERE user_id = ?').run(me.id);
    assert.ok(out.purgeOld() >= 1);
    assert.equal(db._raw().prepare('SELECT 1 FROM out_now WHERE user_id = ?').get(me.id), undefined);
  });
  test('Home → Feeling has "Out and about?" with the 18+ check', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/dashboard.html'), 'utf8');
    assert.ok(html.includes('<div id="out-now"></div>') && html.includes('Out and about?') && html.includes('I’m 18 or older') && html.includes("fetch('/api/out'"));
  });
});
