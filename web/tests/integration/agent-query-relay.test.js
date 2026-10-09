/**
 * agent-query-relay.test.js — what reaches a user when their agent answers another agent.
 *
 * 2026-10-09: Sean's agent asked Allie's and Melanie's agents about the Grover Hot Springs
 * trip. Both were texted their agent's reasoning ("I don't have an active event … Let me
 * ask her directly: ---"), and their chats showed "[Agent query from Sean Gonzalez's
 * agent | thread=…]" as if they'd typed it. Rule in code: in an agent_query turn the final
 * text reaches no one; only reply_agent and tell_my_user do.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'agent-query-relay-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
const texts = [];
sms._setClient({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' + texts.length }; } } });

require('../../server');
const db = require('../../db');
const agent = require('../../agent');
const avoid = require('../../avoid');

let n = 0;
function mkUser(name) {
  const phone = `+1202555${String(8100 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const history = (u) => db._raw().prepare('SELECT role, text FROM conversation_history WHERE user_id = ? ORDER BY rowid').all(u.id);

const REASONING = "I don't have an active event with Sean for that weekend in my current state snapshot, so I need to check with Allie first.\n\nLet me ask her directly:\n\n---\n\n";
const FOR_ALLIE = "Sean says Grover Hot Springs may drop to 29°F Saturday night (Oct 24) — heated cabin or different dates?";

// Script the model: each call returns the next response.
function script(responses) {
  let i = 0;
  agent._setAnthropic({ messages: { create: async () => responses[Math.min(i++, responses.length - 1)] } });
}
const toolUse = (name, input) => ({ id: 'm' + Math.random(), stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't' + Math.random(), name, input }] });
const endText = (text) => ({ id: 'm' + Math.random(), stop_reason: 'end_turn', content: [{ type: 'text', text }] });

// Sean's agent asks Allie's agent (the real message_agent path).
async function seanAsks(sean, allie) {
  const r = await agent.executeTool('message_agent', { contact_id: knows(sean, allie), topic: 'coordination',
    message: "Grover Hot Springs Oct 23–24 looks like 29°F Saturday night. Heated cabin or reschedule? What do you think?" }, sean.id, sean.phone);
  assert.equal(r.sent, true);
}

describe('answering another agent', () => {
  let sean, allie;
  before(() => { sean = mkUser('Sean Gonzalez'); allie = mkUser('Allie McLaine'); knows(allie, sean); });

  test('tell_my_user delivers ONLY its message; the reasoning text reaches no one', async () => {
    await seanAsks(sean, allie);
    script([toolUse('tell_my_user', { message: FOR_ALLIE }), endText(REASONING + 'Once she answers I will loop back.')]);
    texts.length = 0;
    await agent.tick();
    // Allie has no push → texted right away (MEMORY.md §10), with only the clean message.
    assert.deepEqual(texts.map((t) => [t.to, t.body]), [[allie.phone, FOR_ALLIE]]);
    const h = history(allie);
    assert.ok(h.some((m) => m.role === 'assistant' && m.text === FOR_ALLIE));
    assert.ok(!h.some((m) => /state snapshot|Agent query|thread=|loop back/.test(m.text)), 'no reasoning or raw query in her chat');
  });

  test('text-only answer: challenged once, then still delivered to no one', async () => {
    await seanAsks(sean, allie);
    script([endText(REASONING + FOR_ALLIE), endText(REASONING + FOR_ALLIE)]);
    texts.length = 0;
    const before = history(allie).length;
    await agent.tick();
    assert.equal(texts.length, 0);
    assert.equal(history(allie).length, before);
  });

  test('tell_my_user only once per turn, and not outside agent_query turns', async () => {
    await seanAsks(sean, allie);
    script([toolUse('tell_my_user', { message: 'one' }), toolUse('tell_my_user', { message: 'two' }), endText('')]);
    texts.length = 0;
    await agent.tick();
    assert.deepEqual(texts.map((t) => t.body), ['one']);
    assert.equal((await agent.executeTool('tell_my_user', { message: 'x' }, allie.id, allie.phone)).error, 'NOT_AVAILABLE');
  });

  test("someone your user avoids can't put things in front of them", async () => {
    const pat = mkUser('Pat Avoided');
    avoid.addAvoid(allie.id, knows(allie, pat));
    await seanAsks(pat, allie);
    script([toolUse('tell_my_user', { message: 'Pat wants to hang' }), endText('')]);
    texts.length = 0;
    await agent.tick();
    assert.equal(texts.length, 0);
    assert.ok(!history(allie).some((m) => m.text === 'Pat wants to hang'));
  });
});
