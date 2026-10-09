/**
 * defer.test.js — "I'll go with whatever they decide" on a plan.
 *
 * Owner, 2026-10-09: Allie told her ButterflAI the Grover details were up to Melanie and
 * Sean (it's Melanie's birthday), yet questions kept coming to her and Sean's feed kept
 * "waiting on Allie". Decisions: plan only; no questions reach her — her ButterflAI
 * answers with a fixed line, never her reasons; FYI on big changes; she can take it back.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'defer-test';
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
const plans = require('../../plans');

let n = 0;
function mkUser(name) {
  const phone = `+1202555${String(8600 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const history = (u) => db._raw().prepare('SELECT text, kind FROM conversation_history WHERE user_id = ? ORDER BY rowid').all(u.id);
let modelCalls = 0;
function script(responses) {
  let i = 0;
  agent._setAnthropic({ messages: { create: async () => { modelCalls++; return { id: 'm' + i, ...responses[Math.min(i++, responses.length - 1)] }; } } });
}

describe('deferring on a plan', () => {
  let sean, allie, mel, eventId, allieC, melC, allieInv;
  before(async () => {
    sean = mkUser('Sean Gonzalez'); allie = mkUser('Allie McLaine'); mel = mkUser('Melanie Noel');
    allieC = knows(sean, allie); melC = knows(sean, mel); knows(allie, sean); knows(mel, sean);
    eventId = (await agent.executeTool('create_social_event', { title: 'Grover Hot Springs', activity_type: 'camping trip', tentative: true,
      scheduled_at: new Date(Date.now() + 20 * 86400e3).toISOString(), contact_ids: [allieC, melC] }, sean.id, sean.phone)).eventId;
    allieInv = db._raw().prepare('SELECT id FROM event_invitations WHERE event_id = ? AND contact_id = ?').get(eventId, allieC).id;
    // Sean's agent already asked Allie something before she deferred.
    await agent.executeTool('message_agent', { contact_id: allieC, topic: 'coordination', event_id: eventId, message: 'Cabin or shiftpod?' }, sean.id, sean.phone);
  });

  test("she defers: she's in, who decides is recorded, the open question gets her standing answer (no reasons)", async () => {
    const r = await agent.executeTool('defer_on_plan', { invitation_id: allieInv, defer_to: ['Melanie', 'Sean Gonzalez'] }, allie.id, allie.phone);
    assert.equal(r.ok, true);
    assert.equal(r.answered_open_questions, 1);
    const inv = db._raw().prepare('SELECT status, defers_to FROM event_invitations WHERE id = ?').get(allieInv);
    assert.equal(inv.status, 'accepted');
    assert.deepEqual(JSON.parse(inv.defers_to), ['Melanie', 'Sean']);
    const reply = db._raw().prepare("SELECT body FROM agent_messages WHERE from_user = ? AND kind = 'reply'").get(allie.id);
    assert.equal(reply.body, "Allie's happy with whatever Melanie and Sean decide — no need to ask.");
  });

  test("Sean's feed: not waiting on Allie — shows she goes with whatever you & Melanie decide", () => {
    const card = plans.feedFor(sean.id).items.find((i) => i.event_id === eventId && i.type === 'event');
    assert.deepEqual(card.waiting_on, ['Melanie']);
    assert.deepEqual(card.deferring, [{ who: 'Allie', to: ['Melanie', 'you'] }]);
    assert.ok(!card.interested.includes('Allie'));
  });

  test("asking her again: Sean's agent gets her answer without messaging her agent", async () => {
    const before = db._raw().prepare('SELECT count(*) c FROM agent_messages').get().c;
    const r = await agent.executeTool('message_agent', { contact_id: allieC, topic: 'coordination', event_id: eventId, message: 'Ok with the heater?' }, sean.id, sean.phone);
    assert.equal(r.action_status, 'NOT_SENT_DEFERRED');
    assert.match(r.answer, /whatever Melanie and Sean decide/);
    assert.equal(db._raw().prepare('SELECT count(*) c FROM agent_messages').get().c, before);
  });

  test("a question from someone else (Melanie) gets Allie's answer at once — her agent isn't even messaged", async () => {
    const r = await agent.executeTool('message_agent', { contact_id: knows(mel, allie), topic: 'coordination', event_id: eventId, message: 'Allie, hot springs or hiking?' }, mel.id, mel.phone);
    assert.equal(r.action_status, 'NOT_SENT_DEFERRED');
  });

  test('a question queued before she deferred: handled in code — no model call, nothing in her chat, not answered twice', async () => {
    // Sean's first question (asked before she deferred) is still in her agent's queue.
    assert.ok(db._raw().prepare("SELECT 1 FROM inbound_messages WHERE from_id = ? AND channel = 'agent_query' AND processed = 0").get(allie.id));
    db._raw().prepare('UPDATE inbound_messages SET processed = 1 WHERE from_id != ?').run(allie.id);   // only her turn
    script([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'SHOULD NOT RUN' }] }]);
    modelCalls = 0;
    const seen = history(allie).length;
    await agent.tick();
    assert.equal(modelCalls, 0, 'no model call for a deferred plan');
    assert.equal(history(allie).length, seen, 'nothing in her chat');
    assert.equal(db._raw().prepare("SELECT count(*) c FROM agent_messages WHERE from_user = ? AND kind = 'reply'").get(allie.id).c, 1, 'answered once');
  });

  test('big change → an FYI to Allie (not a question); her chat files it under the plan', async () => {
    texts.length = 0;
    const later = new Date(Date.now() + 27 * 86400e3).toISOString();
    const r = await agent.executeTool('update_event', { event_id: eventId, scheduled_at: later, tentative: false }, sean.id, sean.phone);
    assert.equal(r.fyi_sent_to_deferred, 1);
    const fyi = db._raw().prepare("SELECT text, kind, event_id FROM conversation_history WHERE user_id = ? ORDER BY rowid DESC LIMIT 1").get(allie.id);
    assert.match(fyi.text, /^ℹ️ FYI from Sean's ButterflAI — Grover Hot Springs: the date is now .*; it's locked in\. Nothing you need to do\.$/);
    assert.equal(fyi.kind, 'notice');
    assert.equal(fyi.event_id, eventId);
    // Allie has no push → texted per the usual rule.
    assert.ok(texts.some((t) => t.to === allie.phone && t.body.startsWith('ℹ️ FYI')));
  });

  test('she can take it back; another of her invitations is unaffected (plan only)', async () => {
    const r = await agent.executeTool('defer_on_plan', { invitation_id: allieInv, undo: true }, allie.id, allie.phone);
    assert.equal(r.undone, true);
    const again = await agent.executeTool('message_agent', { contact_id: allieC, topic: 'coordination', event_id: eventId, message: 'Bring a sleeping bag?' }, sean.id, sean.phone);
    assert.equal(again.sent, true);
  });

  test("you can only defer on your own invitation", async () => {
    const melInv = db._raw().prepare('SELECT id FROM event_invitations WHERE event_id = ? AND contact_id = ?').get(eventId, melC).id;
    const r = await agent.executeTool('defer_on_plan', { invitation_id: melInv, defer_to: ['Sean'] }, allie.id, allie.phone);
    assert.equal(r.error, 'INVITATION_NOT_FOUND');
  });
});
