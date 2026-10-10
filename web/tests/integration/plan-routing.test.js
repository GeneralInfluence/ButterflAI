/**
 * plan-routing.test.js — "Every conversation in ButterflAI is about an event — a new
 * event, an existing event, or combining two." (owner, 2026-10-09)
 *
 * Decisions: related housekeeping attaches to its plan, else a General pill; a plan is
 * created on first mention (no date needed → "date TBD"); combining two plans asks first.
 * No real model calls: the agent and topics.js's router are stubs.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'plan-routing-test';
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
const plans = require('../../plans');
const multiparty = require('../../multiparty');

let n = 0;
function mkUser(name) {
  const phone = `+1202555${String(9800 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const use = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu' + Math.random(), name, input }] });
function script(responses) {
  const calls = [];
  let i = 0;
  agent._setAnthropic({ messages: { create: async (req) => { calls.push(JSON.stringify(req.messages)); return { id: 'm' + i, ...responses[Math.min(i++, responses.length - 1)] }; } } });
  return calls;
}
let routerCalls = 0;
function router(answer) {
  routerCalls = 0;
  topics._setClient({ messages: { create: async () => { routerCalls++; return { content: [{ type: 'text', text: answer }] }; } } });
}
async function turn(user, text, extra = {}) {
  db.storeInboundMessage({ from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'webchat', text, ...extra });
  await agent.tick();
}
const filed = (u, ev) => db._raw().prepare('SELECT text FROM conversation_history WHERE user_id = ? AND event_id IS ? ORDER BY rowid').all(u.id, ev).map((r) => r.text);
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}

describe('plans exist from their first mention', () => {
  after(() => topics._setClient(null));

  test('no date given → "date TBD": tentative, upcoming, on Home and the pills; a date clears it; it never drifts into the past', async () => {
    const u = mkUser('Sean TBD');
    const r = await agent.executeTool('create_social_event', { title: 'Grover camping', activity_type: 'camping' }, u.id, u.phone);
    const e = db._raw().prepare('SELECT * FROM social_events WHERE id = ?').get(r.eventId);
    assert.equal(e.date_tbd, 1);
    assert.equal(e.tentative, 1);
    assert.equal(e.flexible_time, 0);
    assert.ok(e.scheduled_at > Date.now() / 1000 + 30 * 86400, 'placeholder well ahead');
    assert.equal(plans.feedFor(u.id).items.find((i) => i.event_id === r.eventId).date_tbd, true);
    assert.ok(topics.discussionsFor(u.id).some((d) => d.event_id === r.eventId));
    db._raw().prepare('UPDATE social_events SET scheduled_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) + 86400, r.eventId);
    assert.ok(multiparty.rollDateTbd() >= 1);
    assert.ok(db._raw().prepare('SELECT scheduled_at FROM social_events WHERE id = ?').get(r.eventId).scheduled_at > Date.now() / 1000 + 30 * 86400);
    await agent.executeTool('update_event', { event_id: r.eventId, scheduled_at: new Date(Date.now() + 14 * 86400e3).toISOString() }, u.id, u.phone);
    assert.equal(db._raw().prepare('SELECT date_tbd FROM social_events WHERE id = ?').get(r.eventId).date_tbd, 0);
  });

  test('first mention of a plan that doesn\'t exist → the agent is made to create it, and the conversation is filed there', async () => {
    const u = mkUser('Sean First');
    router('NEW: Grover Hot Springs camping');
    const calls = script([
      say('Sounds fun! Want me to help plan it?'),
      use('create_social_event', { title: 'Grover Hot Springs camping', activity_type: 'camping', tentative: true }),
      say("I've started a Grover Hot Springs camping plan — date TBD."),
    ]);
    await turn(u, 'we should go camping at Grover hot springs with the mamas');
    assert.match(calls[1], /a plan that doesn't exist yet \(\\"Grover Hot Springs camping\\"\)/);
    const ev = db._raw().prepare("SELECT id, date_tbd FROM social_events WHERE host_user_id = ? AND title = 'Grover Hot Springs camping'").get(u.id);
    assert.ok(ev, 'created');
    assert.equal(ev.date_tbd, 1);
    assert.deepEqual(filed(u, ev.id), ['we should go camping at Grover hot springs with the mamas', "I've started a Grover Hot Springs camping plan — date TBD."]);
  });

  test('about an existing plan → filed there; standalone housekeeping → General (no new plan)', async () => {
    const u = mkUser('Sean Route');
    const ev = (await agent.executeTool('create_social_event', { title: 'Tahoe', activity_type: 'ski' }, u.id, u.phone)).eventId;
    router('1');
    script([say('Tahoe is looking snowy.')]);
    await turn(u, 'how is the snow looking for tahoe');
    assert.ok(filed(u, ev).includes('how is the snow looking for tahoe'));
    router('0');
    script([say('Synced.')]);
    await turn(u, 'sync my contacts');
    assert.ok(filed(u, null).includes('sync my contacts'));
    assert.equal(db._raw().prepare('SELECT count(*) c FROM social_events WHERE host_user_id = ?').get(u.id).c, 1, 'no plan created');
  });

  test('the General pill: shows messages about no plan; what you send there isn\'t routed', async () => {
    const u = mkUser('Sean General');
    await agent.executeTool('create_social_event', { title: 'Dinner', activity_type: 'dinner' }, u.id, u.phone);
    router('NEW: should not be asked');
    script([say('Done.')]);
    const cookie = await cookieFor(u);
    await request.post('/api/chat/send').set('Cookie', cookie).send({ text: 'turn on notifications', event_id: 'general' });
    await agent.tick();
    assert.equal(routerCalls, 0, 'not routed');
    const r = await request.get('/api/chat/messages?event=general').set('Cookie', cookie);
    assert.deepEqual(r.body.messages.map((m) => m.text), ['turn on notifications', 'Done.']);
  });
});

describe('combining two plans asks first', () => {
  let sean, allie, mel, grover, bday;
  before(async () => {
    sean = mkUser('Sean Merge'); allie = mkUser('Allie Merge'); mel = mkUser('Mel Merge');
    grover = (await agent.executeTool('create_social_event', { title: 'Grover camping', activity_type: 'camping',
      contact_ids: [knows(sean, allie)] }, sean.id, sean.phone)).eventId;                          // date TBD
    bday = (await agent.executeTool('create_social_event', { title: "Melanie's birthday weekend", activity_type: 'birthday', tentative: true,
      scheduled_at: new Date(Date.now() + 14 * 86400e3).toISOString(), notes: "Liam's party Sunday", contact_ids: [knows(sean, mel), knows(sean, allie)] }, sean.id, sean.phone)).eventId;
    await agent.executeTool('record_rsvp', { event_id: bday, contact_phone: allie.phone, status: 'accepted' }, sean.id, sean.phone);
    db._raw().prepare(`INSERT INTO conversation_history (id, user_id, role, text, event_id) VALUES (?, ?, 'user', 'bday chat', ?)`).run(uuidv4(), sean.id, bday);
  });

  test('first call only proposes (nothing changes); after the user says yes, it combines', async () => {
    const results = [];
    let i = 0;
    const steps1 = [use('merge_plans', { keep_event_id: grover, merge_event_id: bday }), use('merge_plans', { keep_event_id: grover, merge_event_id: bday }), say("Grover and Melanie's birthday weekend look like one plan — combine them?")];
    agent._setAnthropic({ messages: { create: async (req) => {
      const last = req.messages.at(-1);
      if (Array.isArray(last.content)) for (const b of last.content) if (b.type === 'tool_result') results.push(JSON.parse(b.content));
      return { id: 'a' + i, ...steps1[Math.min(i++, steps1.length - 1)] };
    } } });
    await turn(sean, 'grover is the same thing as melanies birthday weekend');
    assert.equal(results[0].needs_confirmation, true);
    assert.equal(results[1].needs_confirmation, true, 'calling again in the same turn still only asks');
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(bday).status, 'open');

    script([use('merge_plans', { keep_event_id: grover, merge_event_id: bday }), say('Combined.')]);
    await turn(sean, 'yes combine them');
    const keep = db._raw().prepare('SELECT * FROM social_events WHERE id = ?').get(grover);
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(bday).status, 'cancelled');
    const inv = db._raw().prepare(`SELECT c.name, ei.status FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? ORDER BY c.name`).all(grover);
    assert.deepEqual(inv.map((x) => [x.name, x.status]), [['Allie Merge', 'accepted'], ['Mel Merge', 'invited']], 'one row each; the more committed status wins');
    assert.equal(keep.date_tbd, 0, 'took the real date');
    assert.match(keep.notes, /Liam's party Sunday/);
    assert.ok(db._raw().prepare("SELECT 1 FROM conversation_history WHERE text = 'bday chat' AND event_id = ?").get(grover), 'discussion moved');
    assert.ok(!topics.discussionsFor(sean.id).some((d) => d.event_id === bday), 'one pill now');
  });

  test("you can't combine someone else's plans", async () => {
    const other = mkUser('Other Merge');
    const theirs = (await agent.executeTool('create_social_event', { title: 'Theirs', activity_type: 'x' }, other.id, other.phone)).eventId;
    const r = await agent.executeTool('merge_plans', { keep_event_id: grover, merge_event_id: theirs }, sean.id, sean.phone);
    assert.equal(r.error, 'NOT_YOUR_PLANS');
  });
});
