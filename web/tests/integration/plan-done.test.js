/**
 * plan-done.test.js — 🐛 #84 (Sean, 2026-10-21): "The power cord was done. I said I dropped it at the front desk. That
 * means it's finished and should be removed." His agent only changed the venue and the notes; the plan stayed open.
 * Now "it's done" marks a plan done (status completed → stage past, off every list) or a Creating item done.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'plan-done-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

require('../../sms')._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
require('../../server');
const db = require('../../db');
const planops = require('../../planops');
const plan = require('../../plan');
const understand = require('../../understand');
const retro = require('../../retro');

let n = 0;
function mkUser(name) {
  const phone = `+1202538${String(1000 + n++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', 1700000000)").run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
const WORDS = "this is done I dropped off the power cord at the front desk of Alex's work and it's completed";

describe('🐛 #84: done is done', () => {
  test('update_event done: the plan is over — stage past, off the plan lists, kept (not cancelled), logged as "marked it done"', async () => {
    const sean = mkUser('Sean D');
    const p = await planops.create(sean.id, { title: 'Power cord pickup', activity_type: 'errand', when: 'tomorrow' }, { via: 'agent' });
    assert.ok(plan.plansFor(sean.id).some((x) => x.id === p.eventId));
    const r = planops.update(sean.id, p.eventId, { done: true }, { via: 'agent' });
    assert.deepEqual(r.updated, ['status']);
    const v = plan.planFor(p.eventId, sean.id);
    assert.equal(v.stage, 'past'); assert.equal(v.done, true);
    assert.ok(!plan.plansFor(sean.id).some((x) => x.id === p.eventId), 'gone from the lists');
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(p.eventId).status, 'completed');
    assert.match(JSON.stringify(planops.history(p.eventId)), /completed/);
    planops.update(sean.id, p.eventId, { done: false }, { via: 'agent' });
    assert.notEqual(plan.planFor(p.eventId, sean.id).stage, 'past', 'done: false reopens it');
  });
  test('Sean\'s exact words, read by understand: done in code, with an Undo', async () => {
    const sean = mkUser('Sean U');
    const p = await planops.create(sean.id, { title: 'Power cord pickup', activity_type: 'errand', when: 'tomorrow' }, { via: 'agent' });
    const plans = plan.plansFor(sean.id);
    const [d] = understand.decide([{ kind: 'done', event_id: p.eventId, quote: 'this is done I dropped off the power cord', confidence: 0.95 }],
      { userId: sean.id, userText: WORDS, eventId: p.eventId, plans, isNamed: () => false });
    assert.equal(d.decision, 'apply');
    const res = understand._applyOne(sean.id, d, {});
    assert.equal(res.ok, true); assert.match(res.label, /^Done · Power cord pickup/);
    assert.equal(plan.planFor(p.eventId, sean.id).stage, 'past');
    assert.match(require('fs').readFileSync(require('path').join(__dirname, '../../understand.js'), 'utf8'), /- done \{item_id\? \| event_id\?\}/);
  });
  test('a guest can\'t mark someone else\'s plan done (passed to the agent to ask)', async () => {
    const host = mkUser('Host G'); const guest = mkUser('Guest G');
    const cid = db.upsertContact({ invited_by_user_id: host.id, name: 'Guest', phone: guest.phone, tier: 1 });
    const p = await planops.create(host.id, { title: 'Dinner G', activity_type: 'meal', when: 'tomorrow', contact_ids: [cid] }, { via: 'agent' });
    const [d] = understand.decide([{ kind: 'done', event_id: p.eventId, quote: 'it\'s done', confidence: 0.95 }],
      { userId: guest.id, userText: 'it\'s done', eventId: p.eventId, plans: plan.plansFor(guest.id), isNamed: () => false });
    assert.equal(d.decision, 'agent');
  });
  test('the rule and the tool field are there', () => {
    const agent = require('../../agent');
    assert.match(agent.buildSystemPrompt({ id: 'x', name: 'S', phone: '+1' }, ''), /DONE IS DONE/);
    assert.match(require('fs').readFileSync(require('path').join(__dirname, '../../agent.js'), 'utf8'), /done: +\{ type: 'boolean', description: 'true when the plan is finished/);
  });
  test('retro: the power cord plan, whose last message says it\'s completed, is marked done', async () => {
    const sean = mkUser('Sean T');
    const id = uuidv4(); const past = Math.floor(Date.now() / 1000) - 7200;
    db._raw().prepare("INSERT INTO social_events (id, host_user_id, title, activity_type, scheduled_at) VALUES (?, ?, 'Power cord pickup', 'errand', ?)").run(id, sean.id, past);
    db._raw().prepare("INSERT INTO conversation_history (id, user_id, role, text, event_id, created_at) VALUES (?, ?, 'user', ?, ?, ?)").run(uuidv4(), sean.id, WORDS, id, past + 60);
    const other = uuidv4();
    db._raw().prepare("INSERT INTO social_events (id, host_user_id, title, activity_type, scheduled_at) VALUES (?, ?, 'Lunch', 'meal', ?)").run(other, sean.id, past);
    db._raw().prepare("INSERT INTO conversation_history (id, user_id, role, text, event_id, created_at) VALUES (?, ?, 'user', 'see you there', ?, ?)").run(uuidv4(), sean.id, other, past + 60);
    assert.equal(await retro.TASKS.find((x) => x.id === '2026-10-22-finished-plans-done').run(sean), 'done 1');
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(id).status, 'completed');
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(other).status, 'open');
  });
});
