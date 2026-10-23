/**
 * no-invented-day.test.js — 🐛 #89 (Melanie, Friday Oct 23, in her Fri–Sat birthday weekend's discussion): "Sean to take
 * boys to press start at 5pm Mel will bring the car and kids around 4-4:30 Allie and Mel will be watching practical
 * magic" → "Done. Saturday's activities are on your birthday weekend plan …"; 👎 "not saturday tonight". Then "make this
 * a separate event" → Practical Magic on Saturday at 7pm. She never said a day.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'no-invented-day-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

require('../../sms')._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
require('../../server');
const db = require('../../db');
const agent = require('../../agent');
const planops = require('../../planops');
const todos = require('../../todos');

const TZ = 'America/Los_Angeles';
const dayOf = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
const weekdayOf = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' });
let k = 0;
function mkUser(name) {
  const phone = `+1202543${String(1000 + k++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', ?, 1700000000)").run(uuidv4(), name, phone, TZ);
  return db.getUserByPhone(phone);
}
const WORDS = 'Sean to take boys to press start at 5pm Mel will bring the car and kids around 4-4:30 Allie and Mel will be watching practical magic';

async function weekend(user) {   // today and tomorrow, like Fri–Sat on the Friday
  return (await planops.create(user.id, { title: `Melanie's Birthday Weekend ${k}`, activity_type: 'birthday', proposed_dates: [{ from: dayOf(0), to: dayOf(1) }], tentative: false }, { via: 'agent' })).eventId;
}
async function turn(user, eventId, text, calls) {
  db._raw().prepare('UPDATE inbound_messages SET processed = 1').run();
  db.storeInboundMessage({ from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'webchat', text, event_id: eventId });
  let i = 0;
  agent._setAnthropic({ messages: { create: async () => {
    const c = calls[i++];
    return c ? { id: 'm' + i, stop_reason: 'tool_use', content: c.map((x, j) => ({ type: 'tool_use', id: `t${i}_${j}`, name: x[0], input: x[1] })) }
      : { id: 'e' + i, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] };
  } } });
  await agent.tick();
}

describe('🐛 #89: no invented day', () => {
  test('Melanie\'s exact words on the weekend\'s first day: the items are today, not tomorrow', async () => {
    const mel = mkUser('Melanie N');
    const e = await weekend(mel);
    await turn(mel, e, WORDS, [[['manage_todos', { event_id: e, action: 'add', items: ['Sean takes boys to Press Start at 5pm'], when_text: `${weekdayOf(1)} 5pm`, day: dayOf(1) }]]]);
    const t = db._raw().prepare('SELECT day, when_text FROM event_todos WHERE event_id = ?').get(e);
    assert.equal(t.day, dayOf(0));
    assert.equal(t.when_text, '5pm');
  });
  test('"make this a separate event": Practical Magic is tonight, not tomorrow at 7pm', async () => {
    const mel = mkUser('Melanie P');
    const e = await weekend(mel);
    await turn(mel, e, `${WORDS} make this a separate event or something so Sean takes the notification`, [[['create_social_event', { title: 'Practical Magic', activity_type: 'movie', when: `${weekdayOf(1)} 5pm` }]]]);
    const p = db._raw().prepare("SELECT scheduled_at FROM social_events WHERE host_user_id = ? AND title = 'Practical Magic'").get(mel.id);
    assert.equal(new Date(p.scheduled_at * 1000).toLocaleDateString('en-CA', { timeZone: TZ }), dayOf(0));
  });
  test('a day she did say stands ("tomorrow at 5")', async () => {
    const mel = mkUser('Melanie S');
    const e = await weekend(mel);
    await turn(mel, e, 'Sean takes the boys to press start tomorrow at 5pm', [[['manage_todos', { event_id: e, action: 'add', items: ['Press Start'], when_text: `${weekdayOf(1)} 5pm`, day: dayOf(1) }]]]);
    const t = db._raw().prepare('SELECT day, when_text FROM event_todos WHERE event_id = ?').get(e);
    assert.deepEqual([t.day, t.when_text], [dayOf(1), `${weekdayOf(1)} 5pm`]);
  });
  test('a plan that isn\'t happening today keeps the model\'s day (it may come from earlier in the conversation)', () => {
    const u = mkUser('Sean F');
    assert.equal(todos.pickDay({ userId: u.id, eventId: null, modelDay: dayOf(9), said: 'put it on the calendar' }), dayOf(9));
  });
  test('understand\'s read: an item with a day she didn\'t say is today\'s', async () => {
    const mel = mkUser('Melanie U');
    const e = await weekend(mel);
    const r = require('../../understand')._applyOne(mel.id, { kind: 'add_todo', event_id: e, text: 'Practical Magic with Allie', day: dayOf(1) }, { contextDay: null, userText: 'Allie and Mel will be watching practical magic' });
    assert.equal(db._raw().prepare('SELECT day FROM event_todos WHERE id = ?').get(r.ref).day, dayOf(0));
  });
  test('the rule is in the prompt', () => {
    assert.match(agent.buildSystemPrompt({ id: 'x', name: 'M', phone: '+1' }, ''), /NO INVENTED DAYS/);
  });
  test('retro: Melanie\'s items filed under tomorrow move to the day she said them', async () => {
    const mel = mkUser('Melanie R');
    const e = await weekend(mel);
    const t0 = Math.floor(Date.now() / 1000) - 600;
    db._raw().prepare("INSERT INTO conversation_history (id, user_id, role, text, event_id, created_at) VALUES (?, ?, 'user', ?, ?, ?)").run(uuidv4(), mel.id, WORDS, e, t0);
    const a = uuidv4(), b = uuidv4(), c = uuidv4();
    db._raw().prepare('INSERT INTO event_todos (id, event_id, text, when_text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(a, e, 'Sean takes boys to Press Start at 5pm', `${weekdayOf(1)} 5pm`, mel.id, t0 + 13);
    db._raw().prepare('INSERT INTO event_todos (id, event_id, text, day, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(b, e, 'Practical Magic screening with Allie', dayOf(1), mel.id, t0 + 13);
    db._raw().prepare('INSERT INTO event_todos (id, event_id, text, day, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(c, e, 'Hot springs', dayOf(1), mel.id, t0 - 86400);
    assert.equal(await require('../../retro').TASKS.find((x) => x.id === '2026-10-23-no-invented-day').run(mel), 'moved 2');
    const row = (id) => db._raw().prepare('SELECT day, when_text FROM event_todos WHERE id = ?').get(id);
    assert.deepEqual([row(a).day, row(a).when_text], [dayOf(0), '5pm']);
    assert.equal(row(b).day, dayOf(0));
    assert.equal(row(c).day, dayOf(1), 'an item from another conversation is untouched');
  });
});
