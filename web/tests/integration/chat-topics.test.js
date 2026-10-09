/**
 * chat-topics.test.js — the chat filtered to one plan's discussion.
 *
 * Owner, 2026-10-09: "if I'm talking with these groups about a particular event, it should
 * filter out any other side things I might have done, so I can read through the
 * discussion." No real model calls: topics.js's model is a stub here.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'topics-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const topics = require('../../topics');

let n = 0;
function mkUser(name) {
  const phone = `+1202555${String(8500 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const tagged = (u, ev) => db._raw().prepare('SELECT role, text FROM conversation_history WHERE user_id = ? AND event_id = ? ORDER BY rowid').all(u.id, ev).map((r) => r.text);

function script(responses) {
  let i = 0;
  agent._setAnthropic({ messages: { create: async () => ({ id: 'm' + i, ...responses[Math.min(i++, responses.length - 1)] }) } });
}
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const use = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu' + Math.random(), name, input }] });
// topics.js model stub: returns the given answers in order, counting calls.
function topicModel(answers) {
  const calls = [];
  topics._setClient({ messages: { create: async (req) => { calls.push(req); return { content: [{ type: 'text', text: answers[Math.min(calls.length - 1, answers.length - 1)] }] }; } } });
  return calls;
}
async function turn(user, text) {
  db.storeInboundMessage({ from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'webchat', text });
  await agent.tick();
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}

describe('chat filtered by discussion', () => {
  let sean, allie, eventId;
  before(() => { sean = mkUser('Sean T'); allie = mkUser('Allie T'); knows(sean, allie); knows(allie, sean); });
  after(() => topics._setClient(null));

  test('a turn that works on an event is filed under it (in code, no model call)', async () => {
    const calls = topicModel(['0']);
    script([use('create_social_event', { title: 'Grover Hot Springs', activity_type: 'camping trip', tentative: true,
      scheduled_at: new Date(Date.now() + 20 * 86400e3).toISOString() }), say('Created Grover as a tentative trip.')]);
    await turn(sean, 'Put Grover on the calendar as tentative');
    eventId = db._raw().prepare("SELECT id FROM social_events WHERE title = 'Grover Hot Springs'").get().id;
    assert.deepEqual(tagged(sean, eventId), ['Put Grover on the calendar as tentative', 'Created Grover as a tentative trip.']);
    assert.equal(calls.length, 0);
  });

  test('a follow-up with no tools is matched by the model; a side thing is not', async () => {
    topicModel(['1']);
    script([say('Allie suggested the heater for the shiftpod.')]);
    await turn(sean, 'who said anything about a heated shift pod?');
    topicModel(['0']);
    script([say('Added Bam Bam to the group.')]);
    await turn(sean, 'add Bam Bam to my favorite mamas group');
    const t = tagged(sean, eventId);
    assert.ok(t.includes('who said anything about a heated shift pod?'));
    assert.ok(!t.includes('add Bam Bam to my favorite mamas group'));
  });

  test('older messages are sorted in once, the first time the discussion is opened; the API returns only it', async () => {
    db._raw().prepare("UPDATE conversation_history SET event_id = NULL WHERE user_id = ? AND text LIKE '%shift pod%'").run(sean.id);
    const rows = db._raw().prepare('SELECT text FROM conversation_history WHERE user_id = ? AND event_id IS NULL ORDER BY created_at, rowid').all(sean.id).map((r) => r.text);
    const want = rows.indexOf('who said anything about a heated shift pod?') + 1;
    const calls = topicModel([String(want)]);
    const cookie = await cookieFor(sean);
    const res = await request.get('/api/chat/messages?event=' + eventId).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.event.title, 'Grover Hot Springs');
    const texts = res.body.messages.map((m) => m.text);
    assert.ok(texts.includes('who said anything about a heated shift pod?'));
    assert.ok(!texts.includes('add Bam Bam to my favorite mamas group'));
    await request.get('/api/chat/messages?event=' + eventId).set('Cookie', cookie);
    assert.equal(calls.length, 1, 'sorted once');
  });

  test("someone not on the event can't open its discussion", async () => {
    const stranger = mkUser('Stranger T');
    const res = await request.get('/api/chat/messages?event=' + eventId).set('Cookie', await cookieFor(stranger));
    assert.equal(res.status, 403);
  });

  test("a friend's question passed on by their agent is filed under the event in their chat", async () => {
    topicModel(['0']);
    await agent.executeTool('create_social_event', { title: 'x', activity_type: 'x', scheduled_at: new Date(Date.now() + 86400e3).toISOString() }, sean.id, sean.phone);
    const inv = await agent.executeTool('create_social_event', { title: 'Grover Hot Springs', activity_type: 'camping trip', tentative: true,
      scheduled_at: new Date(Date.now() + 20 * 86400e3).toISOString(), contact_ids: [db._raw().prepare('SELECT id FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(sean.id, allie.phone).id] }, sean.id, sean.phone);
    assert.equal(inv.eventId, eventId, 'same trip (deduped)');
    await agent.executeTool('message_agent', { contact_id: db._raw().prepare('SELECT id FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(sean.id, allie.phone).id,
      topic: 'coordination', event_id: eventId, message: 'Shiftpod OK for everyone?' }, sean.id, sean.phone);
    script([use('tell_my_user', { message: 'Sean asks: shiftpod OK for everyone?' }), say('')]);
    await agent.tick();
    assert.deepEqual(tagged(allie, eventId), ['Sean asks: shiftpod OK for everyone?']);
  });
});
