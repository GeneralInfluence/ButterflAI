/**
 * in-on-it.test.js — Sean, 2026-10-21: Allie had sent 5 messages about Melanie's Birthday Weekend and was made a
 * co-host, "but it still says she hasn't responded. Either she needs to be prompted for this stuff, or you need to
 * infer it." Not having answered also kept her from the plan's details: "why didn't Melanie's comment turn into an
 * event detail that everybody could see? Is it because Allie hasn't rsvp'd?" (🐛 #73, #74). And 🐛 #75: Sean's agent
 * marking Melanie's massage item "booked" became a suggestion waiting on Melanie he couldn't act on.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'in-on-it-test';
delete process.env.TWILIO_ACCOUNT_SID;
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
const todos = require('../../todos');

let n = 0;
function mkUser(name) {
  const phone = `+1202537${String(1000 + n++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')").run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
async function weekend() {
  const sean = mkUser('Sean I'); const allie = mkUser('Allie I'); const mel = mkUser('Mel I');
  const c = (u) => db.upsertContact({ invited_by_user_id: sean.id, name: u.name, phone: u.phone, tier: 1 });
  const e = (await planops.create(sean.id, { title: `Melanie's Weekend ${n}`, scheduled_at: new Date(Date.now() + 3 * 86400e3).toISOString(), notes: 'Massages at the Renaissance, Friday 10am', contact_ids: [c(allie), c(mel)] })).eventId;
  const inv = (u) => db._raw().prepare('SELECT ei.id FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?').get(e, u.phone).id;
  return { sean, allie, mel, e, inv };
}
const statusOf = (w, u) => db._raw().prepare('SELECT status, going FROM event_invitations WHERE id = ?').get(w.inv(u));
const notices = (u) => db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND kind = 'notice'").all(u.id).map((r) => r.text);
async function say(u, e, text) {
  db.storeInboundMessage({ from_phone: u.phone, from_type: 'user', from_id: u.id, channel: 'webchat', text, event_id: e });
  agent._setAnthropic({ messages: { create: async () => ({ id: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }) } });
  await agent.tick();
}

describe('in on it means interested', () => {
  test('made a co-host → interested, told once; they now see the plan\'s details', async () => {
    const w = await weekend();
    planops.setCohost(w.sean.id, w.e, w.inv(w.allie), true);
    assert.deepEqual(statusOf(w, w.allie), { status: 'accepted', going: 0 });
    assert.ok(notices(w.allie).some((t) => /put you down as interested in .* since you're a co-host/.test(t)));
    assert.match(plan.planFor(w.e, w.allie.id).notes || '', /Renaissance/);
    // The host's agent knows — nobody is told "Allie accepted".
    assert.ok(db._raw().prepare("SELECT 1 FROM conversation_history WHERE user_id = ? AND text LIKE '%Allie I is in on%put down as interested%'").get(w.sean.id));
    assert.equal(db._raw().prepare("SELECT count(*) n FROM inbound_messages WHERE text LIKE '%accepted the invite%'").get().n, 0);
  });
  test('talking in the plan\'s discussion: the second message puts them down as interested (the first gets the question)', async () => {
    const w = await weekend();
    await say(w.allie, w.e, 'sounds fun');
    assert.equal(statusOf(w, w.allie).status, 'invited');
    await say(w.allie, w.e, 'what time are the massages?');
    assert.equal(statusOf(w, w.allie).status, 'accepted');
  });
  test('taking on a Creating item → interested; never over a no', async () => {
    const w = await weekend();
    const item = todos.add(w.sean.id, w.e, { text: 'Book the spa' }).todo;
    todos.join(w.mel.id, item.id);
    assert.equal(statusOf(w, w.mel).status, 'accepted');
    planops.respond(w.inv(w.allie), 'declined', { by: 'guest', phone: w.allie.phone });
    todos.join(w.allie.id, item.id);
    assert.equal(statusOf(w, w.allie).status, 'declined', 'a no stays a no');
  });
  test('🐛 #75: asking your ButterflAI to change an item is taking it on — it changes, no suggestion left waiting', async () => {
    const w = await weekend();
    planops.respond(w.inv(w.mel), 'accepted', { by: 'guest', phone: w.mel.phone });
    const item = todos.add(w.mel.id, w.e, { text: 'Massages at Renaissance Hotel' }).todo;
    db._raw().prepare('UPDATE inbound_messages SET processed = 1').run();   // (Melanie's yes queued a host notice — not this turn)
    db.storeInboundMessage({ from_phone: w.sean.phone, from_type: 'user', from_id: w.sean.id, channel: 'webchat', text: 'the massages are booked for 4', event_id: w.e });
    let k = 0;
    agent._setAnthropic({ messages: { create: async () => (k++ === 0
      ? { id: 'a', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'manage_todos', input: { event_id: w.e, action: 'update', todo_id: item.id, status: 'booked' } }] }
      : { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Marked booked.' }] }) } });
    const seen = []; agent._setToolObserver((name, input, result) => seen.push(JSON.stringify(result)));
    await agent.tick();
    agent._setToolObserver(null);
    assert.equal(db._raw().prepare('SELECT status FROM event_todos WHERE id = ?').get(item.id).status, 'booked', seen.join(' | '));
    assert.equal(db._raw().prepare("SELECT count(*) n FROM plan_suggestions WHERE todo_id = ? AND status = 'pending'").get(item.id).n, 0);
    assert.ok(todos.team(item.id).some((m) => m.phone === w.sean.phone), 'Sean is on it now');
  });
});
