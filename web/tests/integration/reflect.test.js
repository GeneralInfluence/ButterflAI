/**
 * reflect.test.js — looking back at a quiet conversation and checking in if unsure.
 *
 * Owner, 2026-10-09: "I'd rather the ButterflAI come back and say, hey, I said this, but
 * maybe I got it wrong and perhaps you meant that … once the conversation dies down and
 * it has a chance to reflect." The model is a stub here (no real calls).
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'reflect-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
const texts = [];
sms._setClient({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' }; } } });

require('../../server');
const db = require('../../db');
const reflect = require('../../reflect');

// A timezone where it's mid-afternoon (or the middle of the night) right now.
function tzAtLocalHour(h) {
  const off = (new Date().getUTCHours() - h + 24) % 24;          // local = UTC - off
  return off <= 12 ? `Etc/GMT+${off}` : `Etc/GMT-${24 - off}`;
}
let n = 0;
function mkUser(name, { tz = tzAtLocalHour(15), test_user = 0 } = {}) {
  const phone = `+1202555${String(9700 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, test_user) VALUES (?, ?, ?, 'complete', ?, ?)`).run(uuidv4(), name, phone, tz, test_user);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const ago = (mins) => Math.floor(Date.now() / 1000) - mins * 60;
function say(u, role, text, minsAgo) {
  db._raw().prepare(`INSERT INTO conversation_history (id, user_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)`).run(uuidv4(), u.id, role, text, ago(minsAgo));
}
function sent(from, to, body, minsAgo) {
  db._raw().prepare(`INSERT INTO agent_messages (id, from_user, to_user, thread_id, kind, topic, body, created_at) VALUES (?, ?, ?, 't', 'reply', 'coordination', ?, ?)`)
    .run(uuidv4(), from.id, to.id, body, ago(minsAgo));
}
let reviews = [];
function model(answer) {
  reviews = [];
  reflect._setClient({ messages: { create: async (req) => { reviews.push(req.messages[0].content); return { content: [{ type: 'text', text: JSON.stringify(answer) }] }; } } });
}
const history = (u) => db._raw().prepare('SELECT role, text FROM conversation_history WHERE user_id = ? ORDER BY created_at, rowid').all(u.id);
const outcome = (u) => db._raw().prepare('SELECT * FROM reflections WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(u.id);

// Melanie's real conversation (2026-10-09).
function melanieScenario(opts) {
  const mel = mkUser('Melanie Noel', opts); const sean = mkUser('Sean Gonzalez');
  say(mel, 'assistant', "💬 From Sean's ButterflAI: Weather for Grover Oct 23–24 is rough — heated cabin instead of camping, or reschedule?", 90);
  say(mel, 'user', 'how much is a cabin?  probably need to reschedule', 80);
  sent(mel, sean, "Melanie says she'd probably need to reschedule rather than book a cabin.", 80);
  say(mel, 'assistant', "Got it — told Sean's agent you'd rather reschedule than do a cabin.", 79);
  return { mel, sean };
}
const CONCERN = { concern: true, confidence: 0.85, what_happened: 'Her cabin question was dropped and her lean became a decision.',
  followup: "Earlier I told Sean you'd rather reschedule than get a cabin — did I get that right, or were you asking what a cabin would cost?" };

describe('reflecting on quiet conversations', () => {
  after(() => reflect._setClient(null));

  test("Melanie: the review sees what she said and what was sent for her, and checks in — in the app, not by text", async () => {
    const { mel } = melanieScenario({ test_user: 1 });
    model(CONCERN);
    texts.length = 0;
    await reflect.tick();
    assert.match(reviews[0], /how much is a cabin\?/);
    assert.match(reviews[0], /to Sean's assistant, reply\] Melanie says she'd probably need to reschedule/);
    assert.equal(history(mel).at(-1).text, CONCERN.followup);
    assert.equal(texts.length, 0, 'never a text');
    const o = outcome(mel);
    assert.equal(o.outcome, 'asked');
    assert.match(o.details, /cabin question was dropped/, 'kept for a test user');
  });

  test('reviewed once: nothing new → not reviewed again', async () => {
    model(CONCERN);
    await reflect.tick();
    assert.equal(reviews.length, 0);
  });

  test("not sure enough → no follow-up; for a non-test user only the outcome is kept", async () => {
    const { mel } = melanieScenario();
    model({ ...CONCERN, confidence: 0.5 });
    const before = history(mel).length;
    await reflect.tick();
    assert.equal(history(mel).length, before);
    const o = outcome(mel);
    assert.equal(o.outcome, 'unsure');
    assert.equal(o.details, null);
  });

  test('waits until the conversation has been quiet for a while', async () => {
    const mel = mkUser('Mel Busy'); const s = mkUser('Sean Busy');
    say(mel, 'user', 'maybe friday?', 10);
    sent(mel, s, 'Melanie is free Friday.', 10);
    model(CONCERN);
    await reflect.tick();
    assert.equal(reviews.length, 0, 'only 10 minutes ago');
  });

  test('never in quiet hours', async () => {
    melanieScenario({ tz: tzAtLocalHour(3) });
    model(CONCERN);
    await reflect.tick();
    assert.equal(reviews.length, 0);
  });

  test('at most one follow-up a day', async () => {
    const { mel, sean } = melanieScenario();
    model(CONCERN);
    await reflect.tick();
    assert.equal(outcome(mel).outcome, 'asked');
    // Move that first round two hours back, then another quiet stretch the same day.
    db._raw().prepare('UPDATE reflections SET window_end = ?, created_at = ? WHERE user_id = ?').run(ago(120), ago(120), mel.id);
    db._raw().prepare('UPDATE conversation_history SET created_at = ? WHERE user_id = ? AND created_at > ?').run(ago(120), mel.id, ago(5));
    say(mel, 'user', 'probably saturday', 60);
    sent(mel, sean, 'Melanie picks Saturday.', 60);
    await reflect.tick();
    assert.equal(outcome(mel).outcome, 'held_daily_limit');
  });

  test("nothing sent on the user's behalf → no review at all", async () => {
    const u = mkUser('Just Chatting');
    say(u, 'user', 'what is the weather', 90);
    say(u, 'assistant', 'Sunny.', 89);
    model(CONCERN);
    await reflect.tick();
    assert.equal(reviews.length, 0);
  });
});
