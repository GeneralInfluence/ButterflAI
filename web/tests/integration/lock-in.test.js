/**
 * lock-in.test.js — 🐛 #23 (Sean, 2026-10-19): "Why can't I lock in Melanie's birthday weekend?
 * Why is it still under proposed? It's clearly happening … At what point does the agent
 * automatically recognize?" Its dates were one proposed range (Fri–Sat); "Lock it in" only
 * existed for a single date + time.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'lock-in-test';
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
const plan = require('../../plan');
const todos = require('../../todos');

let n = 0;
function mkUser(name) {
  const phone = `+1202539${String(1000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (o, u) => db.upsertContact({ invited_by_user_id: o.id, name: u.name, phone: u.phone, tier: 1 });
const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
async function weekend() {
  const sean = mkUser('Sean K'); const mel = mkUser('Melanie K');
  const e = (await planops.create(sean.id, { title: "Melanie's Birthday Weekend", proposed_dates: [{ from: day(4), to: day(5) }], contact_ids: [knows(sean, mel)] })).eventId;
  const inv = db._raw().prepare('SELECT id FROM event_invitations WHERE event_id = ?').get(e).id;
  planops.respond(inv, 'accepted', { by: 'guest', phone: mel.phone, going: true });
  return { sean, mel, e };
}

describe('🐛 #23: a weekend (one date range) can be locked in', () => {
  test('it\'s clearly happening (someone going) → the plan offers to lock it in', async () => {
    const w = await weekend();
    assert.equal(plan.planFor(w.e, w.sean.id).next, 'It’s happening — lock it in');
  });
  test('Lock it in → confirmed, the same two days, no "(proposed)"', async () => {
    const w = await weekend();
    const r = await request.patch(`/api/events/${w.e}`).set('Cookie', await cookieFor(w.sean)).send({ tentative: false });
    assert.equal(r.status, 200);
    const p = plan.planFor(w.e, w.sean.id);
    assert.equal(p.stage, 'confirmed');
    assert.equal(p.dates.kind, 'days');
    assert.deepEqual(p.days, [day(4), day(5)]);
    assert.doesNotMatch(p.dates.label, /proposed/);
    const [entry] = require('../../calmirror').desired(w.sean.id, w.e);
    assert.deepEqual([entry.body.start.date, entry.body.status], [day(4), 'confirmed']);
  });
  test('the co-host (the person it\'s for) can lock it in too', async () => {
    const w = await weekend();
    assert.equal(planops.update(w.mel.id, w.e, { tentative: false }).ok, true);
  });
  test('several date options: pick one to lock in (not a silent pick)', async () => {
    const sean = mkUser('Sean K2');
    const e = (await planops.create(sean.id, { title: 'Two options', proposed_dates: [{ from: day(4), to: day(5) }, { from: day(11), to: day(12) }] })).eventId;
    assert.equal(planops.update(sean.id, e, { tentative: false }).error, 'PICK_DATES');
    assert.equal(planops.update(sean.id, e, { tentative: false, proposed_dates: [{ from: day(11), to: day(12) }] }).ok, true);
    assert.deepEqual(plan.planFor(e, sean.id).days, [day(11), day(12)]);
  });
  test('no date at all: pick one first', async () => {
    const sean = mkUser('Sean K3');
    const e = (await planops.create(sean.id, { title: 'Someday' })).eventId;
    assert.equal(planops.update(sean.id, e, { tentative: false }).error, 'NO_DATE');
  });
  test('the summary shows "Lock it in · Fri … – Sat …" for one range and a button per option', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/events.html'), 'utf8');
    assert.ok(html.includes("🔒 Lock it in${opts.length === 1 ?") && html.includes('lockIn(${JSON.stringify(p.id)}, this, ${JSON.stringify(o)})'));
  });
  test('Creating being organized counts as happening too', async () => {
    const sean = mkUser('Sean K4');
    const e = (await planops.create(sean.id, { title: 'Organized', proposed_dates: [{ from: day(4), to: day(5) }] })).eventId;
    assert.notEqual(plan.planFor(e, sean.id).next, 'It’s happening — lock it in', 'nothing going on yet');
    todos.add(sean.id, e, { text: 'Book the cabin' });
    assert.equal(plan.planFor(e, sean.id).next, 'It’s happening — lock it in');
  });
});

describe('no promised reminders', () => {
  test('the agent is told there are no timed reminders yet — never to promise one', () => {
    const p = require('../../agent').buildSystemPrompt({ id: 'x', name: 'T', timezone: 'America/Los_Angeles' }, '');
    assert.match(p, /There are no timed reminders yet — never offer or promise to remind them later/);
    assert.doesNotMatch(p, /and offer to remind them/);
  });
});
