/**
 * co-create.test.js — plans are made together (🐛 #20, Sean, 2026-10-19):
 * "Melanie had tried to add massages to her birthday weekend but she couldn't do it. It
 * created a separate event. Now I'm trying to add the massages to the birthday weekend but
 * it's not deleting the old event. … Hosting doesn't mean that I'm the only one who can do
 * anything. Other people should be able to contribute to it and help create it."
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'co-create-test';
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
const agent = require('../../agent');
const planops = require('../../planops');
const plan = require('../../plan');
const todos = require('../../todos');

let n = 0;
function mkUser(name) {
  const phone = `+1202544${String(5000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
const inv = (e, u) => db._raw().prepare('SELECT ei.id, ei.status FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?').get(e, u.phone);
const notices = (u, e) => db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND kind = 'notice' AND event_id = ?").all(u.id, e).map((r) => r.text);
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
// Sean hosts Melanie's weekend (she said yes); Melanie made "Massages" and invited Sean (he said yes).
async function setup() {
  const sean = mkUser('Sean C'); const mel = mkUser('Melanie C'); const bam = mkUser('Bam C');
  const weekend = (await planops.create(sean.id, { title: "Melanie's Birthday Weekend", proposed_dates: [{ from: day(10), to: day(11) }], contact_ids: [knows(sean, mel), knows(sean, bam)] })).eventId;
  planops.respond(inv(weekend, mel).id, 'accepted', { by: 'guest', phone: mel.phone, going: true });
  const massages = (await planops.create(mel.id, { title: 'Massages', scheduled_at: `${day(10)}T10:00:00-07:00`, notes: 'While the kids are at school', contact_ids: [knows(mel, sean)] })).eventId;
  planops.respond(inv(massages, sean).id, 'accepted', { by: 'guest', phone: sean.phone, going: true });
  todos.add(mel.id, massages, { text: 'Book spas in Carson City for massages', day: day(10) });
  todos.add(sean.id, weekend, { text: 'Massages Friday (while kids at school)', day: day(10) });
  return { sean, mel, bam, weekend, massages };
}

describe('🐛 #20: plans are made together', () => {
  test('Melanie (said yes) changes Sean\'s weekend; Sean is told who changed what', async () => {
    const w = await setup();
    const r = planops.update(w.mel.id, w.weekend, { notes: 'Friday: massages before 3pm' }, { via: 'agent' });
    assert.equal(r.ok, true);
    assert.equal(db._raw().prepare('SELECT notes FROM social_events WHERE id = ?').get(w.weekend).notes, 'Friday: massages before 3pm');
    assert.match(notices(w.sean, w.weekend).join('\n'), /Melanie changed the details on Melanie's Birthday Weekend/);
    assert.deepEqual(notices(w.mel, w.weekend).filter((t) => /changed the details/.test(t)), [], 'not told about her own change');
  });

  test('only the host cancels; someone who hasn\'t said yes changes nothing', async () => {
    const w = await setup();
    assert.equal(planops.update(w.mel.id, w.weekend, { cancel: true }).error, 'HOST_ONLY');
    assert.equal(planops.update(w.bam.id, w.weekend, { notes: 'x' }).error, 'NOT_IN_PLAN');
    assert.equal(plan.planFor(w.weekend, w.mel.id).can_edit, true);
    assert.equal(plan.planFor(w.weekend, w.bam.id).can_edit, false);
  });

  test('Sean folds Melanie\'s "Massages" into the weekend: one plan, her Creating items and her with it, both told', async () => {
    const w = await setup();
    const r = planops.merge(w.sean.id, w.weekend, w.massages);
    assert.equal(r.merged, true);
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(w.massages).status, 'cancelled');
    const items = db._raw().prepare('SELECT text FROM event_todos WHERE event_id = ?').all(w.weekend).map((t) => t.text).sort();
    assert.deepEqual(items, ['Book spas in Carson City for massages', 'Massages Friday (while kids at school)']);
    assert.equal(inv(w.weekend, w.mel).status, 'accepted');
    assert.match(notices(w.mel, w.weekend).join('\n'), /Sean combined "Massages" into Melanie's Birthday Weekend/);
  });

  test('Melanie can fold it in too (her plan into the plan she said yes to)', async () => {
    const w = await setup();
    assert.equal(planops.merge(w.mel.id, w.weekend, w.massages).merged, true);
    assert.match(notices(w.sean, w.weekend).join('\n'), /Melanie combined "Massages" into/);
  });

  test('the agent\'s merge_plans works across hosts (after asking)', async () => {
    const w = await setup();
    const first = await agent.executeTool('merge_plans', { keep_event_id: w.weekend, merge_event_id: w.massages }, w.sean.id, w.sean.phone);
    assert.equal(first.needs_confirmation, true, first.message || first.error);   // was NOT_YOUR_PLANS: Melanie hosts Massages
  });

  test('a guest who said yes can change the plan in the app and see / undo its changes', async () => {
    const w = await setup();
    const cookie = await cookieFor(w.mel);
    assert.equal((await request.patch(`/api/events/${w.weekend}`).set('Cookie', cookie).send({ venue_name: 'Carson Hot Springs' })).status, 200);
    const ch = (await request.get(`/api/events/${w.weekend}/changes`).set('Cookie', cookie)).body.changes;
    assert.equal(ch[0].who, 'You');
    const seenBySean = (await request.get(`/api/events/${w.weekend}/changes`).set('Cookie', await cookieFor(w.sean))).body.changes;
    assert.equal(seenBySean[0].who, 'Melanie', 'the host sees who changed it');
    assert.equal((await request.post(`/api/events/${w.weekend}/undo`).set('Cookie', cookie)).status, 200);
    assert.equal(db._raw().prepare('SELECT venue_name FROM social_events WHERE id = ?').get(w.weekend).venue_name, null);
    assert.equal((await request.patch(`/api/events/${w.weekend}`).set('Cookie', await cookieFor(w.bam)).send({ venue_name: 'x' })).status, 403);
  });
});

describe('Creating doesn\'t repeat itself (the weekend had five massage items)', () => {
  test('"Massages" next to "Massages Friday (while kids at school)" is already on the list', async () => {
    const w = await setup();
    assert.equal(todos.add(w.mel.id, w.weekend, { text: 'Massages' }).error, 'ALREADY_ON_LIST');
    assert.equal(todos.add(w.mel.id, w.weekend, { text: 'massage friday' }).error, 'ALREADY_ON_LIST');
    assert.equal(todos.add(w.mel.id, w.weekend, { text: 'Book massages at Carson City Hot Springs' }).ok, true, 'new detail is new');
  });
});

describe('retro for 🐛 #20', () => {
  const task = (id) => require('../../retro').TASKS.find((t) => t.id === id);
  test('the weekend and "Massages" become one plan, then repeated Creating items go', async () => {
    const w = await setup();
    todos.add(w.mel.id, w.massages, { text: 'Massages' });   // added before repeats were refused
    db._raw().prepare("INSERT INTO event_todos (id, event_id, text, created_by) VALUES ('dup1', ?, 'Massages', ?)").run(w.weekend, w.sean.id);
    db.createFeedback({ user_id: w.sean.id, rating: 'down', user_note: "Melanie had tried to add massages to her birthday weekend but she couldn't do it.", context_json: '[]', state_json: '{}' });
    db._raw().prepare("UPDATE feedback SET id = 20 WHERE user_note LIKE 'Melanie had tried%'").run();
    assert.equal(task('2026-10-19-fold-massages-into-melanies-weekend').run(w.sean), 'combined');
    assert.equal(task('2026-10-19-fold-massages-into-melanies-weekend').run(w.sean), 'no massages plan', 'once');
    assert.equal(task('2026-10-19-creating-repeats').run(w.sean), 'removed 1');
    const items = db._raw().prepare('SELECT text FROM event_todos WHERE event_id = ? AND done_at IS NULL').all(w.weekend).map((t) => t.text).sort();
    assert.deepEqual(items, ['Book spas in Carson City for massages', 'Massages Friday (while kids at school)']);
  });
});
