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

describe('🐛 #20: guests suggest, hosts and co-hosts decide', () => {
  test('the person a plan is for is a co-host automatically, and changes it for everyone; the host is told', async () => {
    const w = await setup();
    assert.equal(plan.planFor(w.weekend, w.mel.id).my_role, 'cohost', "Melanie's Birthday Weekend → Melanie");
    assert.equal(plan.planFor(w.weekend, w.bam.id).my_role, 'guest');
    assert.deepEqual(plan.planFor(w.weekend, w.sean.id).cohosts, ['Melanie']);
    const r = planops.update(w.mel.id, w.weekend, { notes: 'Friday: massages before 3pm' }, { via: 'agent' });
    assert.equal(r.ok, true);
    assert.equal(r.suggested, undefined);
    assert.equal(db._raw().prepare('SELECT notes FROM social_events WHERE id = ?').get(w.weekend).notes, 'Friday: massages before 3pm');
    assert.match(notices(w.sean, w.weekend).join('\n'), /Melanie changed the details on Melanie's Birthday Weekend/);
  });

  test('a guest\'s change is a suggestion: host and co-hosts are asked, one accepts, it\'s applied, the guest is told', async () => {
    const w = await setup();
    planops.respond(inv(w.weekend, w.bam).id, 'accepted', { by: 'guest', phone: w.bam.phone });
    const r = planops.update(w.bam.id, w.weekend, { venue_name: 'Steamboat Springs' }, { via: 'agent' });
    assert.equal(r.suggested, true);
    assert.deepEqual(r.to.sort(), ['Melanie', 'Sean']);
    assert.equal(db._raw().prepare('SELECT venue_name FROM social_events WHERE id = ?').get(w.weekend).venue_name, null, 'not changed yet');
    assert.match(notices(w.mel, w.weekend).join('\n'), /💡 Bam suggests for Melanie's Birthday Weekend: place → Steamboat Springs/);
    const [s] = require('../../suggestions').forPlan(w.weekend, w.mel.id);
    assert.equal(require('../../suggestions').decide(w.bam.id, s.id, true).error, 'NOT_YOURS_TO_DECIDE');
    assert.equal(require('../../suggestions').decide(w.mel.id, s.id, true).status, 'accepted');
    assert.equal(db._raw().prepare('SELECT venue_name FROM social_events WHERE id = ?').get(w.weekend).venue_name, 'Steamboat Springs');
    assert.match(notices(w.bam, w.weekend).join('\n'), /Melanie accepted your suggestion/);
  });

  test('only the host cancels or picks co-hosts; people outside the plan can\'t even suggest', async () => {
    const w = await setup();
    const out = mkUser('Outside C');
    assert.equal(planops.update(w.mel.id, w.weekend, { cancel: true }).error, 'HOST_ONLY');
    assert.equal(planops.update(out.id, w.weekend, { notes: 'x' }).error, 'NOT_IN_PLAN');
    assert.equal(planops.setCohost(w.mel.id, w.weekend, inv(w.weekend, w.bam).id, true).error, 'NOT_HOST');
    assert.equal(planops.setCohost(w.sean.id, w.weekend, inv(w.weekend, w.bam).id, true).ok, true);
    assert.equal(plan.canEdit(w.weekend, w.bam.id), true, 'Sean made Bam a co-host');
  });

  test('combining: Melanie (co-host of the weekend, host of Massages) folds hers in; Creating and her come along', async () => {
    const w = await setup();
    const r = planops.merge(w.mel.id, w.weekend, w.massages);
    assert.equal(r.merged, true);
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(w.massages).status, 'cancelled');
    const items = db._raw().prepare('SELECT text FROM event_todos WHERE event_id = ?').all(w.weekend).map((t) => t.text).sort();
    assert.deepEqual(items, ['Book spas in Carson City for massages', 'Massages Friday (while kids at school)']);
    assert.match(notices(w.sean, w.weekend).join('\n'), /Melanie combined "Massages" into Melanie's Birthday Weekend/);
  });

  test('Sean is only a guest on Massages, so his "combine" is a suggestion to Melanie', async () => {
    const w = await setup();
    const r = planops.merge(w.sean.id, w.weekend, w.massages);
    assert.equal(r.suggested, true);
    assert.deepEqual(r.to, ['Melanie']);
    const [s] = require('../../suggestions').forPlan(w.weekend, w.mel.id);
    assert.match(s.summary, /combine "Massages" into it/);
    assert.equal(require('../../suggestions').decide(w.mel.id, s.id, true).status, 'accepted');
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(w.massages).status, 'cancelled');
  });

  test('in the app: a guest\'s PATCH is a suggestion; co-hosts see and undo changes; outsiders get 403', async () => {
    const w = await setup();
    const bam = await cookieFor(w.bam);
    const r = await request.patch(`/api/events/${w.weekend}`).set('Cookie', bam).send({ venue_name: 'Somewhere' });
    assert.equal(r.status, 200);
    assert.equal(r.body.suggested, true);
    const cookie = await cookieFor(w.mel);
    assert.equal((await request.patch(`/api/events/${w.weekend}`).set('Cookie', cookie).send({ venue_name: 'Carson Hot Springs' })).status, 200);
    const ch = (await request.get(`/api/events/${w.weekend}/changes`).set('Cookie', cookie)).body.changes;
    assert.equal(ch[0].who, 'You');
    const seenBySean = (await request.get(`/api/events/${w.weekend}/changes`).set('Cookie', await cookieFor(w.sean))).body.changes;
    assert.equal(seenBySean[0].who, 'Melanie', 'the host sees who changed it');
    assert.equal((await request.post(`/api/events/${w.weekend}/undo`).set('Cookie', cookie)).status, 200);
    assert.equal(db._raw().prepare('SELECT venue_name FROM social_events WHERE id = ?').get(w.weekend).venue_name, null);
    assert.equal((await request.get(`/api/events/${w.weekend}/changes`).set('Cookie', bam)).status, 403, 'guests suggest; the log is for deciders');
    const out = mkUser('Outside API');
    assert.equal((await request.patch(`/api/events/${w.weekend}`).set('Cookie', await cookieFor(out)).send({ venue_name: 'x' })).status, 403);
    const cohost = await request.post(`/api/events/${w.weekend}/cohost`).set('Cookie', await cookieFor(w.sean)).send({ invitation_id: inv(w.weekend, w.bam).id });
    assert.equal(cohost.body.cohost, true);
  });
});

describe('Creating items: a lead, a team, and nobody edits by accident', () => {
  test('whoever adds it leads it; someone else\'s edit is a suggestion to the lead; "I\'m on it" lets them edit', async () => {
    const w = await setup();
    const massages = db._raw().prepare("SELECT id FROM event_todos WHERE event_id = ? AND text LIKE 'Massages%'").get(w.weekend).id;
    let it = todos.list(w.mel.id, w.weekend).todos.find((t) => t.id === massages);
    assert.equal(it.lead, 'Sean');
    assert.equal(it.yours, false);
    const sug = todos.update(w.mel.id, massages, { when_text: 'before 3pm' });
    assert.equal(sug.suggested, true, 'Melanie isn\'t on it: a suggestion to Sean');
    assert.deepEqual(sug.to, ['Sean']);
    assert.equal(db._raw().prepare('SELECT when_text FROM event_todos WHERE id = ?').get(massages).when_text, null);
    const took = todos.update(w.mel.id, massages, { when_text: 'before 3pm', status: 'options' }, { join: true });
    assert.equal(took.ok, true);
    it = todos.list(w.mel.id, w.weekend).todos.find((t) => t.id === massages);
    assert.deepEqual([it.when_text, it.status, it.yours, it.team], ['before 3pm', 'options', true, ['Sean', 'Melanie']]);
    assert.equal(todos.remove(w.bam.id, massages).error, 'NOT_YOURS');
  });

  test('an item nobody leads: whoever takes it on leads it', async () => {
    const w = await setup();
    const s = todos.add(w.sean.id, w.weekend, { text: 'Find a babysitter', suggested: true });
    assert.equal(s.todo.lead, null);
    todos.join(w.bam.id, s.todo.id);
    assert.equal(todos.list(w.bam.id, w.weekend).todos.find((t) => t.id === s.todo.id).lead, 'Bam');
  });

  test('the agent adding a repeat is pointed at the existing item; update adds details there', async () => {
    const w = await setup();
    const r = await agent.executeTool('manage_todos', { event_id: w.weekend, action: 'add', items: ['Massages'] }, w.sean.id, w.sean.phone);
    assert.match(r.problems[0], /Already on the list: "Massages Friday \(while kids at school\)" — add to that item/);
    const id = db._raw().prepare("SELECT id FROM event_todos WHERE event_id = ? AND text LIKE 'Massages%'").get(w.weekend).id;
    const u = await agent.executeTool('manage_todos', { event_id: w.weekend, action: 'update', todo_id: id, when_text: 'before 3pm' }, w.sean.id, w.sean.phone);
    assert.equal(u.todo.when_text, 'before 3pm');
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
  function report(w) {
    db.createFeedback({ user_id: w.sean.id, rating: 'down', user_note: "Melanie had tried to add massages to her birthday weekend but she couldn't do it.", context_json: '[]', state_json: '{}' });
    db._raw().prepare("UPDATE feedback SET id = 20 WHERE user_note LIKE 'Melanie had tried%'").run();
  }
  test('the weekend and "Massages" become one plan, then repeated Creating items go', async () => {
    db._raw().prepare('DELETE FROM feedback').run();
    const w = await setup();
    todos.add(w.mel.id, w.massages, { text: 'Massages' });
    db._raw().prepare("INSERT INTO event_todos (id, event_id, text, created_by) VALUES ('dup1', ?, 'Massages', ?)").run(w.weekend, w.sean.id);
    report(w);
    assert.equal(task('2026-10-19-fold-massages-into-melanies-weekend').run(w.sean), 'combined');
    assert.equal(task('2026-10-19-fold-massages-into-melanies-weekend').run(w.sean), 'no massages plan', 'once');
    assert.equal(task('2026-10-19-creating-repeats').run(w.sean), 'removed 1');
  });
  test('co-hosts for the people plans are for; leads for items nobody led', async () => {
    const w = await setup();
    db._raw().prepare("UPDATE event_invitations SET role = 'guest'").run();
    db._raw().prepare("DELETE FROM plan_changes WHERE field = 'cohost'").run();
    db._raw().prepare('UPDATE event_todos SET assignee_phone = NULL, assignee_name = NULL').run();
    assert.equal(task('2026-10-19-cohosts-and-leads').run(w.sean), 'co-hosts 1, leads 1');
    assert.equal(plan.roleOf(w.weekend, w.mel.id), 'cohost');
    assert.equal(todos.list(w.sean.id, w.weekend).todos[0].lead, 'Sean');
  });
  test('Melanie\'s massage items become one Massages item she leads', async () => {
    db._raw().prepare('DELETE FROM feedback').run();
    const w = await setup();
    planops.merge(w.mel.id, w.weekend, w.massages);
    for (const t of ['Book massages at Carson City Hot Springs', 'Massages - before 3:00 PM Friday', 'Book spa in Carson City for 4 people Friday morning/early afternoon (before 3pm)']) {
      todos.add(w.sean.id, w.weekend, { text: t, day: day(10) });
    }
    todos.add(w.sean.id, w.weekend, { text: 'Set weekend dates', suggested: true });
    report(w);
    assert.equal(task('2026-10-19-one-massages-item').run(w.sean), 'collapsed 5');
    const items = todos.list(w.mel.id, w.weekend).todos;
    const m = items.filter((t) => /massage|spa/i.test(t.text));
    assert.equal(m.length, 1);
    assert.deepEqual([m[0].text, m[0].lead, m[0].when_text, m[0].day, m[0].yours], ['Massages', 'Melanie', 'before 3pm (kids at school)', day(10), true]);
    assert.match(m[0].notes, /Carson City Hot Springs/);
    assert.ok(items.some((t) => t.text === 'Set weekend dates'), 'other items untouched');
  });
});
