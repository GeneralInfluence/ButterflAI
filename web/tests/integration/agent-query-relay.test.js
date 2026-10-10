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
// Since 2026-10-09 a coordination message needs its event, so the trip is created
// (tentative) first, as the real flow now does.
async function seanAsks(sean, allie) {
  const contactId = knows(sean, allie);
  const ev = await agent.executeTool('create_social_event', { title: 'Grover Hot Springs', activity_type: 'camping trip',
    scheduled_at: new Date(Date.now() + 14 * 86400e3).toISOString(), tentative: true }, sean.id, sean.phone);
  const r = await agent.executeTool('message_agent', { contact_id: contactId, topic: 'coordination', event_id: ev.eventId,
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

  // 2026-10-09: after the question reached them, Allie, Melanie and Bam Bam answered in
  // their chats; each agent said "I already replied to Sean's agent" — none had (it had
  // no message_id to reply with). Sean never got the answers.
  test('the user answers later: the open question is in the state, a false "already replied" is challenged, the answer reaches the asker', async () => {
    const mel = mkUser('Melanie Noel'); const sean2 = mkUser('Sean Two'); knows(mel, sean2);
    await seanAsks(sean2, mel);
    script([toolUse('tell_my_user', { message: 'Sean asks: shiftpod for everyone OK?' }), endText('')]);
    await agent.tick();
    const q = db._raw().prepare("SELECT id FROM agent_messages WHERE to_user = ? AND kind = 'query'").get(mel.id);

    const systems = [];
    let i = 0;
    const steps = [
      endText("I've already replied to Sean's agent — he has your answer."),
      toolUse('reply_agent', { message_id: q.id, body: 'Melanie: shiftpod works if it stays warm.' }),
      endText('Passed that back to Sean.'),
    ];
    agent._setAnthropic({ messages: { create: async (req) => { systems.push(JSON.stringify(req.system)); return { id: 'x' + i, ...steps[Math.min(i++, steps.length - 1)] }; } } });
    db.storeInboundMessage({ from_phone: mel.phone, from_type: 'user', from_id: mel.id, channel: 'webchat', text: 'Yeah that works if we keep it warm' });
    await agent.tick();

    assert.ok(systems[0].includes(`message_id=\\"${q.id}\\"`), 'the open question (with its id) is in the state');
    const reply = db._raw().prepare("SELECT body FROM agent_messages WHERE from_user = ? AND to_user = ? AND kind = 'reply'").get(mel.id, sean2.id);
    assert.equal(reply?.body, 'Melanie: shiftpod works if it stays warm.');
    const queued = db._raw().prepare("SELECT 1 FROM inbound_messages WHERE from_id = ? AND channel = 'agent_reply'").get(sean2.id);
    assert.ok(queued, "Sean's agent gets the answer");
    assert.equal(history(mel).at(-1).text, 'Passed that back to Sean.');
  });

  test('once answered, the question leaves the state and "already replied" is no longer challenged', () => {
    assert.equal(agent._unbackedActionClaim("I've already replied to Sean's agent.", [], { openQuestions: 0 }), null);
    assert.ok(agent._unbackedActionClaim("I've already replied to Sean's agent.", [], { openQuestions: 1 }));
    assert.equal(agent._unbackedActionClaim('Melanie replied: she is in.', [], { openQuestions: 1 }), null, 'reporting someone else\'s reply is not a claim');
  });
});

// Regression (2026-10-09): Melanie answered "how much is a cabin? probably need to
// reschedule"; her agent told Sean's "Melanie says she'd probably need to reschedule
// rather than book a cabin" — her question dropped, a lean turned into a decision.
describe("passing the user's answer back keeps what they meant", () => {
  test('exact regression: question dropped → sent back once; the second try keeps it and goes', async () => {
    const mel = mkUser('Melanie Relay'); const sean3 = mkUser('Sean Relay'); knows(mel, sean3);
    await seanAsks(sean3, mel);
    script([toolUse('tell_my_user', { message: 'Sean asks: heated cabin or reschedule?' }), endText('')]);
    await agent.tick();
    const q = db._raw().prepare("SELECT id FROM agent_messages WHERE to_user = ? AND kind = 'query'").get(mel.id);
    const results = [];
    let i = 0;
    const steps = [
      toolUse('reply_agent', { message_id: q.id, body: "Melanie would rather reschedule than book a cabin." }),
      toolUse('reply_agent', { message_id: q.id, body: "Melanie's asking how much a cabin would be — she's leaning toward rescheduling but hasn't decided." }),
      endText('Passed that to Sean.'),
    ];
    agent._setAnthropic({ messages: { create: async (req) => {
      const last = req.messages.at(-1);
      if (Array.isArray(last.content)) for (const b of last.content) if (b.type === 'tool_result') results.push(JSON.parse(b.content));
      return { id: 'r' + i, ...steps[Math.min(i++, steps.length - 1)] };
    } } });
    db.storeInboundMessage({ from_phone: mel.phone, from_type: 'user', from_id: mel.id, channel: 'webchat', text: 'how much is a cabin?  probably need to reschedule' });
    await agent.tick();
    assert.equal(results[0].error, 'RELAY_CHANGES_MEANING');
    assert.match(results[0].message, /how much is a cabin\?/);
    assert.equal(results[1].replied, true);
    const sent = db._raw().prepare("SELECT body FROM agent_messages WHERE from_user = ? AND kind = 'reply'").all(mel.id).map((r) => r.body);
    assert.deepEqual(sent, ["Melanie's asking how much a cabin would be — she's leaning toward rescheduling but hasn't decided."]);
  });

  test('what counts', () => {
    const p = agent._relayProblem;
    assert.match(p('probably need to reschedule', 'Melanie wants to reschedule.'), /wasn't certain/);
    assert.equal(p('probably need to reschedule', 'Melanie is probably going to reschedule.'), null);
    assert.equal(p('yes, the shiftpod works', 'The shiftpod works for Melanie.'), null);
    assert.equal(p('how much is a cabin?', 'Melanie asks: how much is a cabin?'), null);
    assert.equal(p('how much is a cabin?', 'Cabins are about $180/night — Melanie is checking.'), null, 'answered with a number');
  });
});

