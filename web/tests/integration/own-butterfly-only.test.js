/**
 * own-butterfly-only.test.js — owner, 2026-10-23: "there was also a whole lot of back and forth about, like, my butterfly
 * said this or my butterfly said that. Nobody should ever get that. It should only be that person's butterfly talking to
 * them. They should never hear what my butterfly said, ever. The fact that it did is a security breach."
 * Melanie's chat showed "[Agent reply from Sean Gonzalez's agent | …] Press Start is the 5pm start time. Sean expects to
 * be back around 6:30-7pm…" as if she'd typed it, and her ButterflAI said "my message to Sean's agent didn't actually
 * send". That reply's "7pm" then became Practical Magic's time.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'own-butterfly-test';
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

let k = 0;
function mkUser(name) {
  const phone = `+1202546${String(1000 + k++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', 1700000000)").run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
const SEANS_AGENT = "[Agent reply from Sean Gonzalez's agent | thread=x | topic=coordination] Press Start is the 5pm start time. Sean expects to be back around 6:30-7pm with the boys.";
function script(replies) {
  let i = 0; const seen = [];
  agent._setAnthropic({ messages: { create: async (req) => { seen.push(JSON.stringify(req.messages)); const r = replies[i++] || replies[replies.length - 1]; return r; } } });
  return seen;
}
const say = (text) => ({ id: 's' + Math.random(), stop_reason: 'end_turn', content: [{ type: 'text', text }] });

describe('only your own ButterflAI talks to you', () => {
  test('another agent\'s reply is never in your chat — your ButterflAI still knows it', async () => {
    const mel = mkUser('Melanie O');
    db._raw().prepare('UPDATE inbound_messages SET processed = 1').run();
    db.storeInboundMessage({ from_phone: mel.phone, from_type: 'user', from_id: mel.id, channel: 'agent_reply', text: SEANS_AGENT });
    const seen = script([say('Sean’s taking the boys to Press Start at 5.')]);
    await agent.tick();
    assert.match(seen[0], /Sean expects to be back/, 'her agent has it');
    const msgs = (await request.get('/api/chat/messages').set('Cookie', await cookieFor(mel))).body.messages.map((m) => m.text);
    assert.ok(!msgs.some((t) => /Agent reply from|Sean expects to be back/.test(t)), msgs.join(' | '));
    assert.ok(msgs.includes('Sean’s taking the boys to Press Start at 5.'));
  });
  test('a reply that relays another agent goes back to be rewritten', async () => {
    const mel = mkUser('Melanie R');
    db._raw().prepare('UPDATE inbound_messages SET processed = 1').run();
    db.storeInboundMessage({ from_phone: mel.phone, from_type: 'user', from_id: mel.id, channel: 'webchat', text: 'did Sean confirm' });
    const seen = script([say("Sean's agent says he's in, but it's asking when the screening starts."), say('Sean hasn’t answered yet. When does the screening start?')]);
    await agent.tick();
    assert.equal(seen.length, 2);
    assert.match(JSON.stringify(JSON.parse(seen[1]).at(-1)), /Never mention another person's ButterflAI/);
    const last = db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND role = 'assistant' ORDER BY rowid DESC").get(mel.id).text;
    assert.equal(last, 'Sean hasn’t answered yet. When does the screening start?');
  });
  test('a time from another agent\'s reply isn\'t hers: "make Practical Magic a separate event" stays time TBD', async () => {
    const mel = mkUser('Melanie T');
    db.appendConversation(mel.id, 'user', SEANS_AGENT, null, 'internal');
    db._raw().prepare('UPDATE inbound_messages SET processed = 1').run();
    db.storeInboundMessage({ from_phone: mel.phone, from_type: 'user', from_id: mel.id, channel: 'webchat', text: 'make Practical Magic a separate event, tomorrow' });
    script([{ id: 'a', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'create_social_event', input: { title: 'Practical Magic', activity_type: 'movie', when: 'tomorrow 7pm' } }] }, say('Made it.')]);
    await agent.tick();
    assert.equal(db._raw().prepare("SELECT time_tbd FROM social_events WHERE host_user_id = ? AND title = 'Practical Magic'").get(mel.id).time_tbd, 1, 'no 7pm she never said');
  });
  test('the rule is in the prompt', () => {
    assert.match(agent.buildSystemPrompt({ id: 'x', name: 'M', phone: '+1' }, ''), /ONLY YOU TALK TO YOUR USER/);
  });
  test('retro: those already in people\'s chats are hidden', async () => {
    const mel = mkUser('Melanie H');
    db.appendConversation(mel.id, 'user', SEANS_AGENT);
    db.appendConversation(mel.id, 'user', '[System notification — inform the user proactively via SMS] [Agent-to-Agent RSVP] ✅ Sean accepted');
    db.appendConversation(mel.id, 'user', 'sean is taking the boys to press start at 5');
    assert.equal(await require('../../retro').TASKS.find((x) => x.id === '2026-10-23-hide-other-agents-words').run(mel), 'hid 2');
    const msgs = (await request.get('/api/chat/messages').set('Cookie', await cookieFor(mel))).body.messages.map((m) => m.text);
    assert.deepEqual(msgs, ['sean is taking the boys to press start at 5']);
  });
});
