/**
 * planops.test.js — every plan change goes through one module (planops.js) with one set
 * of rules (owner, 2026-10-12: "operate on single objects, not spaghetti logic").
 * Regressions: duplicate plans by the same name; dates given in chat left the calendar
 * showing a stale span ("one event across two days but the dates are removed"); the app's
 * edit route skipped checks the agent's tool had.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'planops-test';
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
const planops = require('../../planops');
const plan = require('../../plan');
const defer = require('../../defer');

let n = 0;
function mkUser(name) {
  const phone = `+1202557${String(5000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', ?)`)
    .run(uuidv4(), name, phone, Math.floor(Date.now() / 1000));
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
const row = (id) => db._raw().prepare('SELECT * FROM social_events WHERE id = ?').get(id);
const isoDaysAhead = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

describe('planops.create', () => {
  test('a plan exists from first mention: no date → date TBD, logged as created', async () => {
    const sean = mkUser('Sean Ops');
    const r = await planops.create(sean.id, { title: 'Grover Hot Springs camping', activity_type: 'trip' });
    assert.ok(r.eventId);
    assert.equal(row(r.eventId).date_tbd, 1);
    assert.equal(plan.planFor(r.eventId, sean.id).stage, 'idea');
    assert.deepEqual(planops.history(r.eventId).map((h) => h.field), ['created']);
  });

  test('a second plan with the same name (case/punctuation aside) is refused', async () => {
    const sean = mkUser('Sean Same');
    const a = await planops.create(sean.id, { title: "Liam's Birthday Party" });
    const b = await planops.create(sean.id, { title: 'liams birthday   party!' });
    assert.equal(b.error, 'PLAN_EXISTS');
    assert.equal(b.eventId, a.eventId);
  });

  test('names must be 1–80 characters', async () => {
    const sean = mkUser('Sean Name');
    assert.equal((await planops.create(sean.id, { title: '   ' })).error, 'BAD_TITLE');
    assert.equal((await planops.create(sean.id, { title: 'x'.repeat(81) })).error, 'BAD_TITLE');
  });

  test('proposed dates without a chosen date: date TBD, tentative, shown as proposed', async () => {
    const sean = mkUser('Sean Prop');
    const from = isoDaysAhead(10), to = isoDaysAhead(11);
    const r = await planops.create(sean.id, { title: 'Bday weekend', proposed_dates: [{ from, to }] });
    const p = plan.planFor(r.eventId, sean.id);
    assert.equal(p.dates.kind, 'proposed');
    assert.deepEqual(p.days, [from, to]);
  });
});

describe('planops.update', () => {
  test('choosing a date clears the proposed options (no stale span on the calendar)', async () => {
    const sean = mkUser('Sean Pick');
    const r = await planops.create(sean.id, { title: 'Pick a date', proposed_dates: [{ from: isoDaysAhead(10), to: isoDaysAhead(11) }] });
    const at = new Date(Date.now() + 12 * 86400000).toISOString();
    const u = planops.update(sean.id, r.eventId, { scheduled_at: at });
    assert.equal(u.ok, true);
    const e = row(r.eventId);
    assert.equal(e.proposed_dates, null);
    assert.equal(e.date_tbd, 0);
    const p = plan.planFor(r.eventId, sean.id);
    assert.equal(p.dates.kind, 'set');
    assert.equal(p.days.length, 1);
  });

  test('only the host can change a plan', async () => {
    const sean = mkUser('Sean Host'); const other = mkUser('Not Host');
    const r = await planops.create(sean.id, { title: 'Mine' });
    assert.equal(planops.update(other.id, r.eventId, { title: 'Hijacked' }).error, 'NOT_HOST');
    assert.equal(row(r.eventId).title, 'Mine');
  });

  test('renaming onto another plan’s name is refused', async () => {
    const sean = mkUser('Sean Rename');
    await planops.create(sean.id, { title: 'Hot springs' });
    const b = await planops.create(sean.id, { title: 'Cabin' });
    assert.equal(planops.update(sean.id, b.eventId, { title: 'HOT SPRINGS' }).error, 'PLAN_EXISTS');
  });

  test('each changed field is logged old → new; unchanged fields are not', async () => {
    const sean = mkUser('Sean Log');
    const r = await planops.create(sean.id, { title: 'Logged', venue_name: 'Old Bar' });
    planops.update(sean.id, r.eventId, { venue_name: 'New Bar', title: 'Logged' }, { via: 'app' });
    const h = planops.history(r.eventId).find((x) => x.field === 'venue_name');
    assert.equal(h.old_value, 'Old Bar');
    assert.equal(h.new_value, 'New Bar');
    assert.equal(h.via, 'app');
    assert.ok(!planops.history(r.eventId).some((x) => x.field === 'title'));
  });

  test('people who deferred get an FYI on a place change or cancellation, not on a note change', async () => {
    const sean = mkUser('Sean Fyi'); const allie = mkUser('Allie Fyi');
    const r = await planops.create(sean.id, { title: 'Fyi plan', contact_ids: [knows(sean, allie)] });
    const inv = db._raw().prepare('SELECT id FROM event_invitations WHERE event_id = ?').get(r.eventId);
    assert.equal(defer.deferOnPlan(allie.id, { invitation_id: inv.id, defer_to: ['Sean'] }).ok, true);
    const notices = () => db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND kind = 'notice'").all(allie.id);
    assert.equal(planops.update(sean.id, r.eventId, { notes: 'bring snacks' }).fyi_sent_to_deferred, undefined);
    assert.equal(planops.update(sean.id, r.eventId, { venue_name: 'Carson Hot Springs' }).fyi_sent_to_deferred, 1);
    assert.match(notices().at(-1).text, /Carson Hot Springs/);
    planops.update(sean.id, r.eventId, { cancel: true });
    assert.match(notices().at(-1).text, /cancelled/);
    assert.equal(row(r.eventId).status, 'cancelled');
  });
});

describe('the app goes through planops too', () => {
  test('PATCH /api/events/:id refuses a duplicate name and logs via app', async () => {
    const sean = mkUser('Sean App');
    const cookie = await cookieFor(sean);
    await planops.create(sean.id, { title: 'Taken' });
    const r = await planops.create(sean.id, { title: 'Free' });
    const dup = await request.patch(`/api/events/${r.eventId}`).set('Cookie', cookie).send({ title: 'taken' });
    assert.equal(dup.status, 400);
    assert.equal(dup.body.error, 'PLAN_EXISTS');
    const ok = await request.patch(`/api/events/${r.eventId}`).set('Cookie', cookie).send({ venue_name: 'Silver Queen' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.updated, ['venue_name']);
    assert.equal(planops.history(r.eventId)[0].via, 'app');
  });

  test("PATCH on someone else's plan is 403", async () => {
    const sean = mkUser('Sean Own'); const bam = mkUser('Bam Other');
    const r = await planops.create(sean.id, { title: 'Not yours' });
    const res = await request.patch(`/api/events/${r.eventId}`).set('Cookie', await cookieFor(bam)).send({ title: 'x' });
    assert.equal(res.status, 403);
  });

  test('GET /api/events/:userId carries each plan object (stage + date label)', async () => {
    const sean = mkUser('Sean List');
    const r = await planops.create(sean.id, { title: 'Listed', proposed_dates: [{ from: isoDaysAhead(20), to: isoDaysAhead(20) }] });
    const res = await request.get(`/api/events/${sean.id}`).set('Cookie', await cookieFor(sean));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const e = (res.body.events || []).find((x) => x.id === r.eventId);
    assert.ok(e, 'plan listed');
    assert.equal(e.plan.stage, 'proposed');
    assert.match(e.plan.dates.label, /proposed/);
  });
});

// Event-map #7 (2026-10-13): "delete" only cancelled and kept plans forever.
describe('cancelled plans are deleted after 90 days', () => {
  test('cancelling records when; reopening clears it', async () => {
    const sean = mkUser('Sean Gone');
    const r = await planops.create(sean.id, { title: 'Gone Plan', scheduled_at: new Date(Date.now() + 5 * 86400e3).toISOString() });
    planops.update(sean.id, r.eventId, { cancel: true });
    assert.ok(row(r.eventId).cancelled_at);
    planops.update(sean.id, r.eventId, { status: 'open' });
    assert.equal(row(r.eventId).cancelled_at, null);
  });

  test('after 90 days the plan and everything hanging off it is gone; chat messages stay, unlinked', async () => {
    const sean = mkUser('Sean Purge'); const allie = mkUser('Allie Purge');
    const keep = await planops.create(sean.id, { title: 'Recent Cancel', scheduled_at: new Date(Date.now() + 5 * 86400e3).toISOString() });
    const old = await planops.create(sean.id, { title: 'Old Cancel', scheduled_at: new Date(Date.now() + 5 * 86400e3).toISOString(), contact_ids: [knows(sean, allie)] });
    require('../../todos').add(sean.id, old.eventId, { text: 'Bring chairs' });
    db._raw().prepare(`INSERT INTO conversation_history (id, user_id, role, text, event_id) VALUES (?, ?, 'user', 'about the old plan', ?)`).run(uuidv4(), sean.id, old.eventId);
    planops.update(sean.id, keep.eventId, { cancel: true });
    planops.update(sean.id, old.eventId, { cancel: true });
    db._raw().prepare('UPDATE social_events SET cancelled_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 91 * 86400, old.eventId);
    assert.equal(planops.purgeCancelled(), 1);
    assert.equal(row(old.eventId), undefined);
    assert.ok(row(keep.eventId), 'cancelled recently — kept for now');
    for (const t of ['event_invitations', 'event_todos', 'plan_changes', 'plan_ripples']) {
      assert.equal(db._raw().prepare(`SELECT count(*) c FROM ${t} WHERE event_id = ?`).get(old.eventId).c, 0, t);
    }
    const msg = db._raw().prepare("SELECT event_id FROM conversation_history WHERE text = 'about the old plan'").get();
    assert.equal(msg.event_id, null, 'the message stays, no longer pointing at the plan');
  });

  test('the nightly date roll goes through planops', () => {
    const fs = require('node:fs'); const path = require('node:path');
    assert.ok(fs.readFileSync(path.join(__dirname, '../../coord-loop.js'), 'utf8').includes("require('./planops').rollDateTbd()"));
    assert.ok(!fs.readFileSync(path.join(__dirname, '../../multiparty.js'), 'utf8').includes('function rollDateTbd'));
  });
});
