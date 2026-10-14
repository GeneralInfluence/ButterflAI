/**
 * plan-answers.test.js — every agent question is about a plan, and answers land on it
 * (owner, 2026-10-13: "maximize fun while minimizing communication between people").
 * Regressions: only "coordination" needed a plan; a continued thread replaced the plan id,
 * so in prod none of 15 agent messages were on a plan; answers were forgotten and asked again.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'plan-answers-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

require('../../server');
const db = require('../../db');
const agent = require('../../agent');
const planops = require('../../planops');
const plan = require('../../plan');
const retro = require('../../retro');

let n = 0;
function mkUser(name) {
  const phone = `+1202550${String(5000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', ?)`)
    .run(uuidv4(), name, phone, Date.UTC(2026, 8, 1) / 1000);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const ask = (from, to, input) => agent.executeTool('message_agent', { contact_id: knows(from, to), topic: 'availability', message: 'Free Saturday?', ...input }, from.id, from.phone);
const lastQuery = (from, to) => db._raw().prepare("SELECT * FROM agent_messages WHERE from_user = ? AND to_user = ? AND kind = 'query' ORDER BY rowid DESC").get(from.id, to.id);

describe('every question is about a plan', () => {
  test('no plan, no question — whatever the topic', async () => {
    const sean = mkUser('Sean Q'); const allie = mkUser('Allie Q');
    for (const topic of ['availability', 'constraints', 'rsvp', 'coordination']) {
      assert.equal((await ask(sean, allie, { topic })).error, 'CREATE_EVENT_FIRST', topic);
    }
  });

  test('the plan is the thread, always (an old thread_id that is a plan still works)', async () => {
    const sean = mkUser('Sean T'); const allie = mkUser('Allie T');
    const r = await planops.create(sean.id, { title: 'Hike Saturday', tentative: true });
    assert.equal((await ask(sean, allie, { thread_id: r.eventId })).sent, true);
    assert.equal(lastQuery(sean, allie).thread_id, r.eventId);
  });

  test("a plan you're not in can't be used", async () => {
    const sean = mkUser('Sean Not'); const bam = mkUser('Bam Not'); const allie = mkUser('Allie Not');
    const r = await planops.create(bam.id, { title: "Bam's party", tentative: true });
    assert.equal((await ask(sean, allie, { event_id: r.eventId })).error, 'CREATE_EVENT_FIRST');
  });
});

describe('answers land on the plan; ask once', () => {
  test('the reply is kept on the plan for the asker only, and shown there', async () => {
    const sean = mkUser('Sean A'); const allie = mkUser('Allie A'); const bam = mkUser('Bam A');
    const r = await planops.create(sean.id, { title: 'Grover weekend', tentative: true, contact_ids: [knows(sean, allie), knows(sean, bam)] });
    await ask(sean, allie, { event_id: r.eventId });
    await agent.executeTool('reply_agent', { message_id: lastQuery(sean, allie).id, body: 'Free Saturday, not Sunday' }, allie.id, allie.phone);
    const p = plan.planFor(r.eventId, sean.id);
    assert.deepEqual(p.answers.map((a) => [a.who, a.topic, a.answer]), [['Allie', 'availability', 'Free Saturday, not Sunday']]);
    assert.deepEqual(plan.planFor(r.eventId, bam.id).answers, [], "Bam doesn't see what Allie told Sean");
  });

  test('asking the same person the same thing again returns the answer instead of a message', async () => {
    const sean = mkUser('Sean Once'); const allie = mkUser('Allie Once');
    const r = await planops.create(sean.id, { title: 'Dinner Friday', tentative: true });
    await ask(sean, allie, { event_id: r.eventId });
    const waiting = await ask(sean, allie, { event_id: r.eventId, message: 'Are you free Saturday??' });
    assert.equal(waiting.action_status, 'NOT_SENT_ALREADY_ASKED');
    await agent.executeTool('reply_agent', { message_id: lastQuery(sean, allie).id, body: 'Yes, after 6' }, allie.id, allie.phone);
    const before = db._raw().prepare('SELECT count(*) c FROM agent_messages').get().c;
    const again = await ask(sean, allie, { event_id: r.eventId });
    assert.equal(again.action_status, 'NOT_SENT_ALREADY_ANSWERED');
    assert.equal(again.answer, 'Yes, after 6');
    assert.equal(db._raw().prepare('SELECT count(*) c FROM agent_messages').get().c, before, 'nobody was bothered');
    assert.equal((await ask(sean, allie, { event_id: r.eventId, ask_again: true })).sent, true, 'unless a new answer is truly needed');
  });
});

describe('earlier questions (retro)', () => {
  const task = () => retro.TASKS.find((t) => t.id === '2026-10-13-agent-questions-onto-plans');
  test('a question between two people in exactly one plan is linked to it, and its reply becomes an answer', async () => {
    const sean = mkUser('Sean Old'); const allie = mkUser('Allie Old');
    const r = await planops.create(sean.id, { title: 'Old Trip', tentative: true, contact_ids: [knows(sean, allie)] });
    const qid = db.sendAgentMessage({ fromUserId: sean.id, toUserId: allie.id, threadId: null, kind: 'query', topic: 'availability', body: 'Free the 23rd?' });
    db.sendAgentMessage({ fromUserId: allie.id, toUserId: sean.id, threadId: qid, kind: 'reply', topic: 'availability', body: 'Yes' });   // replies shared the question's thread
    db.markAgentMessageProcessed(qid);
    assert.equal(task().run(sean), 'linked 1, closed 0');
    assert.equal(db._raw().prepare('SELECT thread_id FROM agent_messages WHERE id = ?').get(qid).thread_id, r.eventId);
    assert.equal(plan.planFor(r.eventId, sean.id).answers[0].answer, 'Yes');
  });
  test("an unanswered question that can't be linked is closed", async () => {
    const sean = mkUser('Sean Loose'); const allie = mkUser('Allie Loose');
    db.sendAgentMessage({ fromUserId: sean.id, toUserId: allie.id, threadId: 'gone-thread', kind: 'query', topic: 'coordination', body: 'Cabin?' });
    assert.equal(task().run(sean), 'linked 0, closed 1');
  });
});
