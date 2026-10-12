/**
 * plansync.test.js — say it, store it.
 *
 * Regression (2026-10-12): Sean's agent told him "Melanie's Birthday Weekend — Fri–Sat,
 * Oct 23–24 at Carson City Hot Springs", said "Done" and "Let me create both events…",
 * but never saved anything: both plans stayed undated and off the calendar.
 * No real model calls: the agent and plansync's check are stubs.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'plansync-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

require('../../server');
const db = require('../../db');
const agent = require('../../agent');
const plansync = require('../../plansync');
const actioncheck = require('../../actioncheck');
const retro = require('../../retro');
const topics = require('../../topics');

function tzAtLocalHour(h) {
  const off = (new Date().getUTCHours() - h + 24) % 24;
  return off <= 12 ? `Etc/GMT+${off}` : `Etc/GMT-${24 - off}`;
}
let n = 0;
function mkUser(name, created = null) {
  const phone = `+1202556${String(2000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', ?, ?)`)
    .run(uuidv4(), name, phone, tzAtLocalHour(14), created || Math.floor(Date.now() / 1000));
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const use = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu' + Math.random(), name, input }] });
function script(responses) {
  const calls = [];
  let i = 0;
  agent._setAnthropic({ messages: { create: async (req) => { calls.push(JSON.stringify(req.messages)); return { id: 'm' + i, ...responses[Math.min(i++, responses.length - 1)] }; } } });
  return calls;
}
// plansync's model (used by the retro task) and actioncheck's (the every-reply check,
// which replaced the plan-only check in the agent loop on 2026-10-12).
let checks = 0;
function stub(missing, key) {
  return { messages: { create: async () => { checks++; const m = Array.isArray(missing) ? missing : missing(); return { content: [{ type: 'text', text: JSON.stringify({ missing: key ? m.map((d) => ({ detail: d })) : m }) }] }; } } };
}
function checker(missing) { checks = 0; plansync._setClient(stub(missing, true)); }
function actions(missing) { checks = 0; actioncheck._setClient(stub(missing, false)); }
async function turn(user, text, extra = {}) {
  db.storeInboundMessage({ from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'webchat', text, ...extra });
  await agent.tick();
}

describe('say it, store it', () => {
  after(() => { plansync._setClient(null); actioncheck._setClient(null); retro._setClient(null); topics._setClient(null); });

  test('exact regression: details stated in a plan\'s chat but not saved → the agent must save them before replying', async () => {
    const sean = mkUser('Sean Sync');
    const ev = (await agent.executeTool('create_social_event', { title: "Melanie's Birthday Weekend", activity_type: 'weekend' }, sean.id, sean.phone)).eventId;
    let stored = false;
    actions(() => stored ? [] : ['save dates 2026-10-23 to 2026-10-24 on the plan', 'save place Carson City Hot Springs']);
    const calls = script([
      say("Melanie's Birthday Weekend — Fri–Sat, Oct 23–24 at Carson City Hot Springs. Done."),
      use('update_event', { event_id: ev, proposed_dates: [{ from: '2026-10-23', to: '2026-10-24' }], venue_name: 'Carson City Hot Springs' }),
      say("Saved: Oct 23–24 at Carson City Hot Springs (proposed)."),
    ]);
    const realUpdate = agent._setToolObserver;
    agent._setToolObserver((name) => { if (name === 'update_event') stored = true; });
    await turn(sean, "we're going to Carson City hot springs instead, Fri and Sat the 23rd", { event_id: ev });
    agent._setToolObserver(null);
    assert.ok(calls[1].includes("These still aren't done") && calls[1].includes('save dates 2026-10-23 to 2026-10-24') && calls[1].includes(ev));
    const e = db._raw().prepare('SELECT venue_name, proposed_dates FROM social_events WHERE id = ?').get(ev);
    assert.equal(e.venue_name, 'Carson City Hot Springs');
    assert.deepEqual(JSON.parse(e.proposed_dates), [{ from: '2026-10-23', to: '2026-10-24' }]);
    assert.ok(realUpdate);
  });

  test('nothing missing → no extra step (every reply is still checked)', async () => {
    const sean = mkUser('Sean Fine');
    const ev = (await agent.executeTool('create_social_event', { title: 'Dinner', activity_type: 'dinner' }, sean.id, sean.phone)).eventId;
    actions([]);
    const calls = script([say('Sounds good.')]);
    await turn(sean, 'sounds good', { event_id: ev });
    assert.equal(calls.length, 1);
    assert.equal(checks, 1);
  });

  test('"Done. Grover is gone." / "Let me create both events…" with no change → challenged', () => {
    const claim = (t, log = []) => agent._unbackedActionClaim(t, log);
    assert.ok(claim('Done. Grover Hot Springs event is gone.'));
    assert.ok(claim('Got it. Let me create both events with your favorite Mamas.'));
    assert.ok(claim("I've updated the plan with the new dates."));
    assert.equal(claim("I've updated the plan with the new dates.", [{ name: 'update_event', result: { ok: true } }]), null);
  });

  test('retro: details decided in an older discussion are offered to the host (not saved)', async () => {
    const sean = mkUser('Sean Old', Date.UTC(2026, 8, 1) / 1000);
    const ev = (await agent.executeTool('create_social_event', { title: "Liam's Birthday Party", activity_type: 'party' }, sean.id, sean.phone)).eventId;
    db._raw().prepare(`INSERT INTO conversation_history (id, user_id, role, text, event_id) VALUES (?, ?, 'user', 'Liam party is Sunday the 25th at the Silver Queen', ?)`).run(uuidv4(), sean.id, ev);
    for (const t of retro.TASKS) if (t.id !== '2026-10-12-store-plan-details-from-discussion') db._raw().prepare('INSERT INTO retro_runs (task_id, user_id, outcome) VALUES (?, ?, ?)').run(t.id, sean.id, 'skip');
    topics._setClient({ messages: { create: async () => ({ content: [{ type: 'text', text: 'none' }] }) } });
    checker(['dates: 2026-10-25', 'place: Silver Queen Saloon']);
    await retro.tick();
    const last = db._raw().prepare('SELECT text FROM conversation_history WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').get(sean.id).text;
    assert.ok(last.includes("never made it onto your plans:\n• Liam's Birthday Party: dates: 2026-10-25; place: Silver Queen Saloon\nWant me to save them?"));
    assert.equal(db._raw().prepare('SELECT venue_name FROM social_events WHERE id = ?').get(ev).venue_name, null, 'not saved without a yes');
  });
});

describe('every reply is checked for an action that should have happened (2026-10-12)', () => {
  after(() => actioncheck._setClient(null));

  test('a promised action outside any plan ("I\'ll text her") is sent back to be done', async () => {
    const u = mkUser('Sean Promise');
    actions(['send Allie the address']);
    const calls = script([say("I'll text Allie the address."), say("I couldn't find Allie in your contacts — what's her number?")]);
    await turn(u, 'send allie the address');
    assert.ok(calls[1].includes("These still aren't done") && calls[1].includes('send Allie the address'));
    assert.equal(checks, 1, 'checked once per turn');
  });

  test('a plan can be cancelled; delete_desires only runs when the user talks about desires', async () => {
    const u = mkUser('Sean Cancel');
    const ev = (await agent.executeTool('create_social_event', { title: 'Grover', activity_type: 'camping' }, u.id, u.phone)).eventId;
    const r = await agent.executeTool('update_event', { event_id: ev, cancel: true }, u.id, u.phone);
    assert.deepEqual(r.updated, ['status']);
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(ev).status, 'cancelled');
    actions([]);
    const results = [];
    let i = 0;
    const steps = [use('delete_desires', { confirm: true }), say("There's no Grover plan.")];
    agent._setAnthropic({ messages: { create: async (req) => {
      const last = req.messages.at(-1);
      if (Array.isArray(last.content)) for (const b of last.content) if (b.type === 'tool_result') results.push(JSON.parse(b.content));
      return { id: 'd' + i, ...steps[Math.min(i++, steps.length - 1)] };
    } } });
    await turn(u, 'delete grover, it is not happening');
    assert.equal(results[0].error, 'NOT_ABOUT_DESIRES');
  });

  test("Home's Creating: yours, then anyone's, then suggestions waiting to be kept", async () => {
    const plans = require('../../plans');
    const u = mkUser('Sean Home');
    const ev = (await agent.executeTool('create_social_event', { title: 'Melanie weekend', activity_type: 'trip' }, u.id, u.phone)).eventId;
    await agent.executeTool('manage_todos', { event_id: ev, action: 'suggest', items: ['Book a room', 'Plan dinner'] }, u.id, u.phone);
    await agent.executeTool('manage_todos', { event_id: ev, action: 'add', items: ['Buy a cake'] }, u.id, u.phone);
    await agent.executeTool('manage_todos', { event_id: ev, action: 'add', items: ['Call the spa'], assignee: 'me' }, u.id, u.phone);
    const f = plans.feedFor(u.id);
    assert.deepEqual(f.creating.map((i) => [i.text, i.who]), [['Call the spa', 'you'], ['Buy a cake', 'anyone']]);
    assert.deepEqual(f.creating_suggestions.map((x) => [x.title, x.count]), [['Melanie weekend', 2]]);
  });
});

