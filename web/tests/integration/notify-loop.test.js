/**
 * notify-loop.test.js — owner, 2026-10-23: "the notification process. So that way they know that I see the message, and
 * then I know they see that I've responded. That needs to be smoother." And (decided): only the person can accept
 * something they're put down for — Sean's agent had told Melanie's "Sean's in", and hers told her "Sean confirmed".
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'notify-loop-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const supertest = require('supertest');

require('../../sms')._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const planops = require('../../planops');
const todos = require('../../todos');

let k = 0;
function mkUser(name) {
  const phone = `+1202548${String(1000 + k++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', 1700000000)").run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
async function setup() {
  const mel = mkUser('Melanie L'), sean = mkUser('Sean L'), allie = mkUser('Allie L');
  const save = (o, x) => db.upsertContact({ invited_by_user_id: o.id, name: x.name, phone: x.phone, tier: 1 });
  save(sean, mel);
  const e = (await planops.create(mel.id, { title: `Friday evening ${k}`, activity_type: 'evening', when: 'tomorrow 5pm', contact_ids: [save(mel, sean), save(mel, allie)] }, { via: 'app' })).eventId;
  db._raw().prepare("UPDATE event_invitations SET status = 'accepted' WHERE event_id = ?").run(e);
  return { mel, sean, allie, e };
}
const lastOf = (u, kind) => db._raw().prepare('SELECT * FROM conversation_history WHERE user_id = ? AND kind = ? ORDER BY rowid DESC').get(u.id, kind);

describe('put down for something = asked; only they answer; the one who asked hears it', () => {
  test('Melanie: "Sean takes the boys to Press Start" → Sean is asked → I\'m on it → Melanie hears "Sean\'s on it"', async () => {
    const { mel, sean, e } = await setup();
    const r = todos.add(mel.id, e, { text: 'Take the boys to Press Start', assignee: 'Sean', when_text: '5pm' });
    assert.equal(r.todo.ask, 'asked');
    const card = lastOf(sean, 'ask');
    assert.match(card.text, /🙋 Melanie put you down for: Take the boys to Press Start · 5pm \(Friday evening/);
    const cs = await cookieFor(sean);
    const shown = (await request.get(`/api/chat/messages?event=${e}`).set('Cookie', cs)).body.messages.find((m) => m.kind === 'ask');
    assert.deepEqual([shown.todo_id, shown.ask], [r.todo.id, 'asked']);
    // Allie can't answer for him.
    assert.equal((await request.post(`/api/todos/${r.todo.id}/answer`).set('Cookie', await cookieFor((await setup()).allie)).send({ answer: 'on_it' })).status, 403);
    const a = await request.post(`/api/todos/${r.todo.id}/answer`).set('Cookie', cs).send({ answer: 'on_it' });
    assert.equal(a.body.ask, 'on_it');
    assert.match(lastOf(mel, 'notice').text, /✅ Sean's on it: Take the boys to Press Start/);
    assert.equal((await request.get(`/api/chat/messages?event=${e}`).set('Cookie', cs)).body.messages.find((m) => m.kind === 'ask').ask, 'on_it');
  });
  test('"Can\'t": it\'s open again and Melanie is told', async () => {
    const { mel, sean, e } = await setup();
    const t = todos.add(mel.id, e, { text: 'Bring snacks', assignee: 'Sean' }).todo;
    assert.equal(todos.answer(sean.id, t.id, 'cant').ok, true);
    const row = db._raw().prepare('SELECT assignee_phone, ask_status FROM event_todos WHERE id = ?').get(t.id);
    assert.deepEqual([row.assignee_phone, row.ask_status], [null, 'cant']);
    assert.match(lastOf(mel, 'notice').text, /Sean can't do “Bring snacks” — it's open again/);
  });
  test('saying "I\'m on it" himself (taking it on) answers it', async () => {
    const { mel, sean, e } = await setup();
    const t = todos.add(mel.id, e, { text: 'Drive the boys', assignee: 'Sean' }).todo;
    todos.join(sean.id, t.id);
    assert.equal(db._raw().prepare('SELECT ask_status FROM event_todos WHERE id = ?').get(t.id).ask_status, 'on_it');
  });
  test('his agent, answering another agent, can\'t take it on for him', async () => {
    const { mel, sean, e } = await setup();
    const t = todos.add(mel.id, e, { text: 'Pick up pizza', assignee: 'Sean' }).todo;
    db._raw().prepare('UPDATE inbound_messages SET processed = 1').run();
    db.storeInboundMessage({ from_phone: sean.phone, from_type: 'user', from_id: sean.id, channel: 'agent_query', text: `[Agent query from Melanie's agent | thread=x | topic=coordination] Can Sean pick up pizza?` });
    const results = []; let i = 0;
    agent._setAnthropic({ messages: { create: async (req) => {
      const last = req.messages.at(-1);
      if (Array.isArray(last.content)) for (const b of last.content) if (b.type === 'tool_result') results.push(String(b.content));
      return i++ === 0 ? { id: 'a', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'manage_todos', input: { event_id: e, action: 'join', todo_id: t.id } }] }
        : { id: 'b', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'u', name: 'tell_my_user', input: { message: 'Melanie asked if you can pick up pizza.' } }] };
    } } });
    await agent.tick();
    assert.match(results.join(' '), /ONLY_THEY_CAN_SAY/);
    assert.equal(db._raw().prepare('SELECT ask_status FROM event_todos WHERE id = ?').get(t.id).ask_status, 'asked');
    assert.match(agent.buildSystemPrompt({ id: 'x', name: 'S', phone: '+1' }, ''), /ONLY THEY SAY YES/);
  });
});

describe('who knows: each change shows who has seen it', () => {
  test('Melanie changes the place → "Not yet: Sean, Allie"; Sean opens the plan → "Seen: Sean"', async () => {
    const { mel, sean, e } = await setup();
    planops.update(mel.id, e, { venue_name: 'Press Start' }, { via: 'app' });
    await new Promise((r) => setTimeout(r, 1100));   // seen is to the second
    const cm = await cookieFor(mel);
    let ch = (await request.get(`/api/events/${e}/changes`).set('Cookie', cm)).body.changes[0];
    assert.deepEqual(ch.knows.seen, []); assert.deepEqual(ch.knows.not_yet.sort(), ['Allie', 'Sean']);
    await request.get(`/api/chat/messages?event=${e}`).set('Cookie', await cookieFor(sean));
    ch = (await request.get(`/api/events/${e}/changes`).set('Cookie', cm)).body.changes[0];
    assert.deepEqual(ch.knows.seen, ['Sean']); assert.deepEqual(ch.knows.not_yet, ['Allie']);
  });
  test('a message you sent shows "Seen" once they\'ve opened ButterflAI', async () => {
    const { mel, sean } = await setup();
    const cid = db._raw().prepare('SELECT id FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(mel.id, sean.phone).id;
    require('../../push').notifyUser = async () => {};   // pretend he has notifications on (no text right away)
    db._raw().prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://x', 'a', 'b')").run(sean.id);
    await require('../../deliver').deliverToContact({ fromUser: mel, contact: db.getContact(cid), message: 'Can you take the boys at 5?' });
    const cm = await cookieFor(mel);
    const sent = () => request.get('/api/chat/messages').set('Cookie', cm).then((r) => r.body.messages.find((m) => m.kind === 'outgoing'));
    assert.equal((await sent()).seen, false);
    await request.get('/api/chat/messages').set('Cookie', await cookieFor(sean));   // he opens the app
    assert.equal((await sent()).seen, true);
  });
});

describe('retro: items already on someone become questions to them', () => {
  test('Sean, put down by Melanie before this, is asked now; his own items aren\'t', async () => {
    const { mel, sean, e } = await setup();
    const a = uuidv4(), b = uuidv4();
    db._raw().prepare('INSERT INTO event_todos (id, event_id, text, assignee_phone, assignee_name, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(a, e, 'Take the boys', sean.phone, 'Sean', mel.id);
    db._raw().prepare('INSERT INTO event_todos (id, event_id, text, assignee_phone, assignee_name, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(b, e, 'Pizza', sean.phone, 'Sean', sean.id);
    assert.equal(await require('../../retro').TASKS.find((x) => x.id === '2026-10-23-ask-whoever-its-on').run(sean), 'asked 1');
    assert.equal(db._raw().prepare('SELECT ask_status FROM event_todos WHERE id = ?').get(a).ask_status, 'asked');
    assert.match(lastOf(sean, 'ask').text, /Melanie put you down for: Take the boys/);
  });
});

// 🐛 #91 (Sean, 2026-10-24): "I got a notification on my phone that Melanie had said are you in … I clicked on the
// notification it didn't even bring me to butterfly or any part of it … frankly there would be just a big modal asking
// me the question and then bring me to the rest of the app."
describe('🐛 #91: a question is asked up front; a notification tap always opens ButterflAI', () => {
  test('Melanie\'s question to Sean: listed for the prompt on any screen; the push opens the plan with it', async () => {
    const { mel, sean, e } = await setup();
    let pushed = null;
    const push = require('../../push'); const keep = push.notifyUser;
    push.notifyUser = async (_db, uid, p) => { if (uid === sean.id) pushed = p; };
    const t = todos.add(mel.id, e, { text: 'Kids at Press Start', assignee: 'Sean', when_text: '5pm' }).todo;
    push.notifyUser = keep;
    assert.equal(pushed.url, `/app/chat?event=${encodeURIComponent(e)}&ask_todo=${encodeURIComponent(t.id)}`);
    const cs = await cookieFor(sean);
    const asks = (await request.get('/api/asks').set('Cookie', cs)).body.asks;
    assert.equal(asks.length, 1);
    assert.deepEqual([asks[0].todo_id, asks[0].what, asks[0].from], [t.id, 'Kids at Press Start · 5pm', 'Melanie']);
    assert.match(asks[0].plan, /^Friday evening/);
    await request.post(`/api/todos/${t.id}/answer`).set('Cookie', cs).send({ answer: 'on_it' });
    assert.deepEqual((await request.get('/api/asks').set('Cookie', cs)).body.asks, [], 'answered: not asked again');
  });
  test('every screen gets the prompt (via feedback.js); the tap is handled even when the open window can\'t be moved', () => {
    const fs = require('fs'); const path = require('path');
    const fb = fs.readFileSync(path.join(__dirname, '../../public/feedback.js'), 'utf8');
    assert.match(fb, /s\.src = '\/asks-prompt\.js'/);
    const ap = fs.readFileSync(path.join(__dirname, '../../public/asks-prompt.js'), 'utf8');
    assert.match(ap, /I'm on it<\/button><button class="no" data-a="cant">Can't<\/button><button class="later" data-a="later">Not now/);
    assert.match(ap, /e\.data\.type === 'OPEN'/);
    const sw = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');
    assert.match(sw, /existing\.postMessage\(\{ type: 'OPEN', url: target \}\);\n\s+try \{ await existing\.navigate\(target\); return; \} catch \(_\) \{\}/);
    assert.match(sw, /return clients\.openWindow\(target\);\n\s+\}\)\(\)\.catch\(\(\) => clients\.openWindow\(target\)\)\);/);
  });
});
