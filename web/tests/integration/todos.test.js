/**
 * todos.test.js — a to-do list for each plan (owner, 2026-10-12).
 * Decisions: everyone in the plan sees and changes it; assignable to someone in the plan;
 * ButterflAI suggests, people keep. Shown at the top of the plan's chat, on Home (yours),
 * on the Events card, and through the agent.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'todos-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const home = require('../../home');

let n = 0;
function mkUser(name) {
  const phone = `+1202556${String(1000 + n++).padStart(4, '0')}`;
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

describe('plan to-dos', () => {
  let sean, allie, stranger, ev, sc, ac, xc;
  before(async () => {
    sean = mkUser('Sean Todo'); allie = mkUser('Allie Todo'); stranger = mkUser('Stranger Todo');
    ev = (await agent.executeTool('create_social_event', { title: 'Grover', activity_type: 'camping',
      proposed_dates: [{ from: '2026-10-23', to: '2026-10-25' }], contact_ids: [knows(sean, allie)] }, sean.id, sean.phone)).eventId;
    sc = await cookieFor(sean); ac = await cookieFor(allie); xc = await cookieFor(stranger);
  });

  test('the agent suggests; suggestions are separate until kept; it can list, add, assign, check off', async () => {
    const s = await agent.executeTool('manage_todos', { event_id: ev, action: 'suggest', items: ['Book the campsite', 'Check the forecast'] }, sean.id, sean.phone);
    assert.deepEqual(s.suggested, ['Book the campsite', 'Check the forecast']);
    let l = await agent.executeTool('manage_todos', { event_id: ev, action: 'list' }, sean.id, sean.phone);
    assert.equal(l.progress.total, 0, 'suggestions don\'t count until kept');
    const camp = l.todos.find((t) => t.text === 'Book the campsite');
    await agent.executeTool('manage_todos', { event_id: ev, action: 'keep', todo_id: camp.id }, sean.id, sean.phone);
    const heater = await agent.executeTool('manage_todos', { event_id: ev, action: 'add', items: ['Bring the heater'], assignee: 'Allie' }, sean.id, sean.phone);
    assert.deepEqual(heater.added, ['Bring the heater']);
    const bad = await agent.executeTool('manage_todos', { event_id: ev, action: 'add', items: ['x'], assignee: 'Bob' }, sean.id, sean.phone);
    assert.match(bad.problems[0], /someone in the plan: Sean, Allie/);
    await agent.executeTool('manage_todos', { event_id: ev, action: 'done', todo_id: camp.id }, sean.id, sean.phone);
    l = await agent.executeTool('manage_todos', { event_id: ev, action: 'list' }, sean.id, sean.phone);
    assert.deepEqual(l.progress, { done: 1, total: 2 });
  });

  // Was "everyone in the plan sees and changes it". Since 2026-10-19 (owner: "people shouldn't be
  // able to accidentally edit stuff that they're not focusing on") everyone sees it, whoever adds
  // an item leads it, and someone else's change is a suggestion to them until they take it on.
  test('everyone in the plan sees it; whoever adds an item leads it; others suggest or take it on (API); someone outside can\'t', async () => {
    const list = await request.get(`/api/events/${ev}/todos`).set('Cookie', ac);
    assert.equal(list.status, 200);
    assert.ok(list.body.todos.some((t) => t.text === 'Bring the heater' && t.assignee === 'Allie'));
    const add = await request.post(`/api/events/${ev}/todos`).set('Cookie', ac).send({ text: 'Buy marshmallows' });
    assert.equal(add.status, 200);
    assert.equal(add.body.todo.lead, 'Allie', 'she added it, she leads it');
    const sug = await request.patch(`/api/todos/${add.body.todo.id}`).set('Cookie', sc).send({ done: true });
    assert.equal(sug.body.suggested, true, 'the host checking off Allie\'s item is a suggestion to her');
    const s = (await request.get(`/api/events/${ev}/todos`).set('Cookie', ac)).body.suggestions.find((x) => x.todo_id === add.body.todo.id);
    assert.equal(s.can_decide, true);
    assert.equal((await request.post(`/api/suggestions/${s.id}`).set('Cookie', ac).send({ accept: true })).body.status, 'accepted');
    const done = (await request.get(`/api/events/${ev}/todos`).set('Cookie', ac)).body.todos.find((t) => t.id === add.body.todo.id);
    assert.equal(done.done, true, 'Allie accepted: done');
    assert.equal((await request.get(`/api/events/${ev}/todos`).set('Cookie', xc)).status, 404);
    assert.equal((await request.patch(`/api/todos/${add.body.todo.id}`).set('Cookie', xc).send({ done: false })).status, 404);
    assert.equal((await request.delete(`/api/todos/${add.body.todo.id}`).set('Cookie', xc)).status, 404);
  });

  test('Home: to-dos assigned to you need you; Events: progress on the card', async () => {
    // Since 2026-10-12 they're Home's own "Creating" section (between Feeling and Happenings), not feed items.
    const item = home.feedFor(allie.id).creating.find((i) => i.text === 'Bring the heater');
    assert.equal(item.event_id, ev);
    assert.ok(!home.feedFor(allie.id).items.some((i) => i.type === 'todo'));
    assert.ok(!home.feedFor(sean.id).creating.some((i) => i.text === 'Bring the heater'), 'not on Sean\'s Home');
    const hosted = await request.get(`/api/events/${sean.id}`).set('Cookie', sc);
    assert.deepEqual(hosted.body.events.find((e) => e.id === ev).todo_progress, { done: 2, total: 3 });
    const invited = await request.get('/api/events/invited/me').set('Cookie', ac);
    assert.deepEqual(invited.body.events.find((e) => e.id === ev).todo_progress, { done: 2, total: 3 });
  });

  test('pages: to-do bar in the plan\'s chat, on Events cards, and on Home', () => {
    const read = (f) => require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app', f), 'utf8');
    // The list lives in its own tab since 🐛 #32 (2026-10-20); a plan's chat links to it.
    assert.ok(read('chat.html').includes('<section id="todo-bar" hidden>') && read('chat.html').includes('id="plan-creating"'));
    assert.ok(read('creating.html').includes('Suggested by ButterflAI'));
    assert.ok(read('events.html').includes('function todoLine(e)') && read('events.html').includes('function checkTodo('));
    // Home = Feeling · Creating · Happenings (owner, 2026-10-12)
    const dash = read('dashboard.html');
    assert.ok(dash.indexOf('<h2>Feeling</h2>') < dash.indexOf('<h2>Creating</h2>') && dash.indexOf('<h2>Creating</h2>') < dash.indexOf('<h2>Happenings</h2>'));
    assert.ok(dash.includes('function creatingHtml(list, suggestions)') && dash.includes('async function doneTodo('));
    assert.ok(read('chat.html').includes('✨ Creating') && read('events.html').includes('✨ Creating'));
  });
});
