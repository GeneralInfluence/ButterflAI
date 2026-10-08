/**
 * sent-claim-guard.test.js — "never claim sent unless a send succeeded", in code.
 *
 * Regression (prod, 2026-10-06): tester Allie asked her agent to message Sean. The agent
 * guessed contact_id "aphilos", send_logistics_sms failed (Contact not found), and it
 * replied "Sent! Message is on its way to Sean." Nothing was sent.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'guard-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
const texts = [];
sms._setClient({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' + texts.length }; } } });

const db = require('../../db');
const agent = require('../../agent');

function mkUser(phone, name) {
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, test_user) VALUES (?, ?, ?, 'complete', 'America/New_York', 1)`)
    .run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}

// Scripted model: returns the given responses in order, recording what it was sent.
function script(responses) {
  const calls = [];
  let i = 0;
  agent._setAnthropic({ messages: { create: async (req) => {
    calls.push(JSON.parse(JSON.stringify(req.messages)));
    return { id: 'm' + i, ...responses[Math.min(i++, responses.length - 1)] };
  } } });
  return calls;
}
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const use = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu' + Math.random(), name, input }] });

async function turn(user, text) {
  db.storeInboundMessage({ from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'webchat', text });
  await agent.tick();
  return db._raw().prepare(`SELECT text FROM conversation_history WHERE user_id = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 1`).get(user.id)?.text;
}

describe('false "sent" claims are blocked', () => {
  test('exact regression: failed send + "Sent!" twice → honest fallback, guard traced', async () => {
    const allie = mkUser('+12025559301', 'Allie G');
    const calls = script([
      use('send_logistics_sms', { contact_id: 'aphilos', message: 'Yo, get moving! Wings tonight 🍗' }),
      say('Sent! Message is on its way to Sean. 🍗'),
      say('Sent! Message is on its way to Sean. 🍗'),
    ]);
    const reply = await turn(allie, 'I just want you to send him something');
    assert.equal(reply, agent.NOT_SENT_FALLBACK);
    const checkMsg = calls[2].at(-1).content;
    assert.match(checkMsg, /^\[System check — not from the user\]/);
    assert.match(checkMsg, /CONTACT_NOT_FOUND|No contact with id "aphilos"/, 'tells the model why it failed');
    const guard = db._raw().prepare(`SELECT text FROM agent_trace WHERE user_id = ? AND kind = 'guard'`).all(allie.id);
    assert.equal(guard.length, 2, 'both the challenge and the replacement are traced');
  });

  test('after the challenge the agent can recover: look up, send for real, then "Sent!" stands', async () => {
    const u = mkUser('+12025559302', 'Recover');
    const seanPhone = '+12025559399';
    db.writeConsent(seanPhone, 'INVITE_PAGE');
    const seanId = db.upsertContact({ invited_by_user_id: u.id, name: 'Sean Gonzalez', phone: seanPhone, tier: 1 });
    texts.length = 0;
    script([
      use('send_logistics_sms', { contact_id: 'sean-gonzalez', message: 'Wings tonight?' }),
      say('Sent!'),
      use('send_logistics_sms', { contact_id: seanId, message: 'Wings tonight?' }),
      say('Sent! Sean has it.'),
    ]);
    const reply = await turn(u, 'send sean a message about wings tonight');
    assert.equal(reply, 'Sent! Sean has it.');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].to, seanPhone);
  });

  test('user asked to send, agent attempted nothing, claims sent → challenged', async () => {
    const u = mkUser('+12025559303', 'NoAttempt');
    script([say('Done — I messaged him!'), say('Okay, I did not send it yet. Want me to?')]);
    const reply = await turn(u, 'tell sam we are running late');
    assert.equal(reply, 'Okay, I did not send it yet. Want me to?');
  });

  test('truthful reference to an earlier send is not challenged', async () => {
    const u = mkUser('+12025559304', 'Earlier');
    const calls = script([say('Yes — I sent it to Sam earlier today.')]);
    const reply = await turn(u, 'did you send it?');
    assert.equal(reply, 'Yes — I sent it to Sam earlier today.');
    assert.equal(calls.length, 1, 'no extra model call');
  });
});

describe('unverifiedSentClaim', () => {
  const f = agent._unverifiedSentClaim;
  const base = { anySendSucceeded: false, failedSends: ['send_logistics_sms: x'], sendAttempted: true, userText: 'send it' };
  test('negated statements are honest, not claims', () => {
    for (const t of ["It wasn't sent.", "That didn't go through — nothing was sent.", "I couldn't send it", "I haven't sent anything yet"]) {
      assert.equal(f(t, base), false, t);
    }
  });
  test('a successful send this turn makes the claim fine', () => {
    assert.equal(f('Sent!', { ...base, anySendSucceeded: true }), false);
  });
});

describe('contact ids must be the user\'s own', () => {
  test('guessed or foreign contact ids are rejected with recovery instructions', async () => {
    const a = mkUser('+12025559305', 'Owner A');
    const b = mkUser('+12025559306', 'Owner B');
    const bContact = db.upsertContact({ invited_by_user_id: b.id, name: 'B Friend', phone: '+12025559307', tier: 1 });
    for (const [tool, input] of [
      ['draft_contact_message', { contact_id: 'sean-gonzalez', message: 'hi', message_type: 'expressive' }],
      ['send_logistics_sms', { contact_id: bContact, message: 'hi' }],
      ['draft_contact_message', { contact_id: bContact, message: 'hi', message_type: 'logistics' }],
    ]) {
      const r = await agent.executeTool(tool, input, a.id, a.phone);
      assert.equal(r.error, 'CONTACT_NOT_FOUND', `${tool} ${input.contact_id}`);
      assert.match(r.message, /lookup_contact/);
    }
  });
});

// Regression (prod, 2026-10-06): Sean received "Let's go have some fun tonight!" from the
// shared ButterflAI number with no idea it was Allie.
describe('texts sent on a user\'s behalf say who they are from', () => {
  test('send_logistics_sms prefixes "<first name>\'s ButterflAI:" once', async () => {
    const allie = mkUser('+12025559310', 'Allie McLaine');
    const seanPhone = '+12025559311';
    db.writeConsent(seanPhone, 'INVITE_PAGE');
    const seanId = db.upsertContact({ invited_by_user_id: allie.id, name: 'Sean Gonzalez', phone: seanPhone, tier: 1 });
    texts.length = 0;
    await agent.executeTool('send_logistics_sms', { contact_id: seanId, message: "Let's go have some fun tonight!" }, allie.id, allie.phone);
    await agent.executeTool('send_logistics_sms', { contact_id: seanId, message: "Allie's ButterflAI: wings at 8?" }, allie.id, allie.phone);
    assert.equal(texts[0].body, "Allie's ButterflAI: Let's go have some fun tonight!");
    assert.equal(texts[1].body, "Allie's ButterflAI: wings at 8?", 'no double prefix');
  });
});

// Regressions from Sean's session (prod, 2026-10-08) — the "had to argue with my agent" turns.
describe('2026-10-08 regressions', () => {
  test('"ask Bam Bam …" + "Just sent Bam Bam a message" with no tool call → challenged', async () => {
    const u = mkUser('+12025559320', 'Asker');
    const calls = script([say("Just sent Bam Bam a message asking what he's up to tonight. I'll let you know when he replies! 📱"), say("I haven't sent it yet — want me to?")]);
    const reply = await turn(u, "ask Bam Bam what he's up to tonight");
    assert.equal(calls.length, 2, 'the false claim was challenged');
    assert.equal(reply, "I haven't sent it yet — want me to?");
  });

  test('guessed contact ids are rejected for EVERY tool (message_agent, create_social_event…)', async () => {
    const u = mkUser('+12025559321', 'Guesser');
    const m = await agent.executeTool('message_agent', { contact_id: 'bam_bam_contact_id', topic: 'coordination', message: 'hi' }, u.id, u.phone);
    assert.equal(m.error, 'CONTACT_NOT_FOUND');
    const e = await agent.executeTool('create_social_event', { title: 'x', activity_type: 'dinner', contact_ids: ['bam_bam_contact_id'] }, u.id, u.phone);
    assert.equal(e.error, 'CONTACT_NOT_FOUND');
    assert.deepEqual(e.invalid_contact_ids, ['bam_bam_contact_id']);
  });

  test('lookup_contact says whether someone is on ButterflAI — from accounts, not the stale tier', async () => {
    const sean = mkUser('+12025559322', 'Sean L');
    const bambam = mkUser('+12025559323', 'Bam Bam');
    db.upsertContact({ invited_by_user_id: sean.id, name: 'Bam Bam', phone: bambam.phone, tier: 0 });
    const r = await agent.executeTool('lookup_contact', { query: 'Bam Bam' }, sean.id, sean.phone);
    assert.equal(r.contacts[0].on_butterflai, true, 'tier 0 contact who is a user');
    assert.match(r.contacts[0].how_to_reach, /send_logistics_sms/);
  });

  test('a notice the server texts a user lands in their chat history (agent sees it)', async () => {
    const sean = mkUser('+12025559324', 'Sean N');
    await sms.notifyUser(sean.phone, '🦋 Bam Bam signed up for their own ButterflAI!');
    const hist = db.getRecentConversation(sean.id, 5);
    assert.ok(hist.some((h) => h.role === 'assistant' && h.text.includes('Bam Bam signed up')));
  });
});
