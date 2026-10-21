/**
 * counts.test.js — Sean, 2026-10-21: "according to her, she didn't book it for four people. She only booked it for
 * herself … where did that come from?" Nobody said four: Sean's agent turned "Massages are supposed to happen before 3:00
 * on Friday" into "Book spas … for 4 people" and asked Melanie's agent about booking "for 4 people"; Melanie said "booked a
 * massage at Rennisance hotel at 10 am on Friday", and her agent told Sean's "Massages booked … for 4 people".
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'counts-test';
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

let n = 0;
function mkUser(name) {
  const phone = `+1202540${String(1000 + n++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')").run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
async function turn(u, text, eventId, toolName, input) {
  db._raw().prepare('UPDATE inbound_messages SET processed = 1').run();
  db.storeInboundMessage({ from_phone: u.phone, from_type: 'user', from_id: u.id, channel: 'webchat', text, event_id: eventId });
  const results = [];
  let k = 0;
  agent._setAnthropic({ messages: { create: async (req) => {
    const last = req.messages.at(-1);
    if (Array.isArray(last.content)) for (const b of last.content) if (b.type === 'tool_result') results.push(String(b.content));
    return k++ === 0 ? { id: 'a', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: toolName, input }] }
      : { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
  } } });
  await agent.tick();
  return results.join(' ');
}

describe('how many people — only if they said it', () => {
  test('Sean\'s words had no number: "for 4 people" isn\'t added to Creating', async () => {
    const sean = mkUser('Sean N'); const mel = mkUser('Melanie N');
    const e = (await planops.create(sean.id, { title: 'Melanie Weekend N', scheduled_at: new Date(Date.now() + 3 * 86400e3).toISOString(),
      contact_ids: [db.upsertContact({ invited_by_user_id: sean.id, name: mel.name, phone: mel.phone, tier: 1 })] })).eventId;
    const r = await turn(sean, 'Massages are supposed to happen before 3:00 on Friday', e, 'manage_todos',
      { event_id: e, action: 'add', items: ['Book spas in Carson City for Friday morning/early afternoon for 4 people'] });
    assert.match(r, /COUNT_NOT_SAID/);
    assert.match(r, /never said how many people/); assert.match(r, /for 4/);
    assert.equal(db._raw().prepare('SELECT count(*) n FROM event_todos WHERE event_id = ?').get(e).n, 0);
  });
  test('Melanie said "booked a massage": her agent can\'t tell Sean\'s it was "for 4 people", nor write it in the notes', async () => {
    const mel = mkUser('Melanie M'); const sean = mkUser('Sean M');
    const e = (await planops.create(mel.id, { title: 'Weekend M', scheduled_at: new Date(Date.now() + 3 * 86400e3).toISOString() })).eventId;
    const words = 'booked a massage at Rennisance hotel at 10 am on Friday 10/23/26 then lunch with Allie after';
    const r1 = await turn(mel, words, e, 'update_event', { event_id: e, notes: 'Friday: Massages for 4 at Renaissance Hotel 10am, then lunch with Allie.' });
    assert.match(r1, /COUNT_NOT_SAID/);
    const r2 = await turn(mel, words, e, 'message_agent', { contact_id: db.upsertContact({ invited_by_user_id: mel.id, name: sean.name, phone: sean.phone, tier: 1 }), event_id: e, topic: 'coordination',
      message: 'Massages booked at Renaissance Hotel, Friday 10 am for 4 people.' });
    assert.match(r2, /COUNT_NOT_SAID/);
    const ok = await turn(mel, words, e, 'update_event', { event_id: e, notes: 'Friday: massage at Renaissance Hotel 10am, then lunch with Allie.' });
    assert.ok(!/COUNT_NOT_SAID/.test(ok), 'no number: fine');
  });
  test('a number they did say is fine; times and hours are not headcounts', async () => {
    const u = mkUser('Sean O');
    const e = (await planops.create(u.id, { title: 'Dinner O', scheduled_at: new Date(Date.now() + 3 * 86400e3).toISOString() })).eventId;
    assert.ok(!/COUNT_NOT_SAID/.test(await turn(u, 'book a table for four of us', e, 'update_event', { event_id: e, notes: 'Table for 4 people at 7' })));
    assert.ok(!/COUNT_NOT_SAID/.test(await turn(u, 'lets do it around then', e, 'update_event', { event_id: e, notes: 'Starts at 4 pm, plan for 3 hours' })));
    const p = agent.buildSystemPrompt({ id: 'x', name: 'Sean', phone: '+1' }, '');
    assert.match(p, /NUMBERS ARE THEIRS/);
  });
});
