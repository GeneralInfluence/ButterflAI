/**
 * share-plans.test.js — a share ("Free tonight") can become a plan (event-map #5,
 * 2026-10-13). Before, shares lived beside plans and could never turn into one.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'share-plans-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
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
const feeling = require('../../feeling');
const home = require('../../home');
const plan = require('../../plan');
const avoid = require('../../avoid');

let n = 0;
function mkUser(name) {
  const phone = `+1202551${String(1000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}

describe('your own share → your plan', () => {
  test('"Free tonight" becomes "Something tonight", proposed for today, nobody invited yet', async () => {
    const sean = mkUser('Sean Own');
    const s = feeling.sharePlan(sean.id, { text: 'Free tonight', until: 'tonight' });
    const r = await feeling.planFromShare(sean.id, s.plan_id);
    const p = plan.planFor(r.eventId, sean.id);
    assert.equal(p.title, 'Something tonight');
    assert.equal(p.dates.kind, 'proposed');
    assert.equal(p.dates.proposals[0].from, new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }));
    assert.equal(p.people.length, 0);
    const again = await feeling.planFromShare(sean.id, s.plan_id);
    assert.equal(again.eventId, r.eventId, 'same tap, same plan');
    assert.equal(again.existing, true);
    assert.equal(home.feedFor(sean.id).my_plans[0].made_plan, r.eventId, 'Home shows "Open plan"');
  });
});

describe("a friend's share → a plan with them", () => {
  test('you host, they are invited, the plan says who it is with', async () => {
    const sean = mkUser('Sean Friend'); const allie = mkUser('Allie Friend');
    knows(allie, sean);   // Allie's contacts include Sean, so Sean can see her share
    const s = feeling.sharePlan(allie.id, { text: "At Sully's from 9 this weekend", until: 'this weekend' });
    const item = home.feedFor(sean.id).items.find((i) => i.type === 'plan' && i.plan_id === s.plan_id);
    assert.ok(item, 'Sean sees the share');
    const res = await request.post(`/api/shares/${s.plan_id}/plan`).set('Cookie', await cookieFor(sean));
    assert.equal(res.status, 200);
    const p = plan.planFor(res.body.eventId, sean.id);
    assert.equal(p.title, "At Sully's from 9 this weekend — with Allie");
    assert.ok(p.people.some((x) => x.name === 'Allie'), 'Allie is invited');
    assert.ok(plan.planFor(res.body.eventId, allie.id), 'and it is on her side as an invite');
    assert.equal(home.feedFor(sean.id).items.find((i) => i.plan_id === s.plan_id).made_plan, res.body.eventId);
  });

  test("a share you can't see can't be made into a plan", async () => {
    const sean = mkUser('Sean Blocked'); const julie = mkUser('Julie Blocked');
    knows(julie, sean);
    avoid.addAvoid(julie.id, knows(julie, sean));   // Julie avoids Sean: her shares are invisible to him
    const s = feeling.sharePlan(julie.id, { text: 'Free tonight', until: 'tonight' });
    const res = await request.post(`/api/shares/${s.plan_id}/plan`).set('Cookie', await cookieFor(sean));
    assert.equal(res.status, 404);
    assert.equal(plan.plansFor(sean.id).length, 0);
  });

  test('an ended share is gone', async () => {
    const sean = mkUser('Sean Ended');
    const s = feeling.sharePlan(sean.id, { text: 'Free tonight', until: 'tonight' });
    db._raw().prepare('UPDATE shared_plans SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 60, s.plan_id);
    assert.equal((await feeling.planFromShare(sean.id, s.plan_id)).error, 'SHARE_NOT_FOUND');
  });
});

describe('Home', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/dashboard.html'), 'utf8');
  test('your shares and friends\' shares have "Make it a plan" / "Make a plan with …" (or "Open plan")', () => {
    assert.ok(html.includes("shareAction(p.plan_id, p.made_plan, 'Make it a plan')"));
    assert.ok(html.includes('shareAction(i.plan_id, i.made_plan, `Make a plan with ${esc(i.who)}`)'));
    assert.ok(html.includes("fetch('/api/shares/' + encodeURIComponent(shareId) + '/plan', { method: 'POST' })"));
    assert.ok(html.includes('Open plan ›'));
  });
});
