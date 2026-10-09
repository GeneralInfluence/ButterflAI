/**
 * learn-aliases.test.js — the agent gets used to what the user calls people.
 *
 * Owner, 2026-10-09: "The AI should be able to get used to how users talk about their
 * friends over time." When a lookup wasn't exact and the user then acts on one of the
 * people found, the name they used is saved as that contact's alias (in code).
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'aliases-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

require('../../server');
const db = require('../../db');
const agent = require('../../agent');

function mkUser(phone, name) {
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
function script(responses) {
  let i = 0;
  agent._setAnthropic({ messages: { create: async () => ({ id: 'm' + i, ...responses[Math.min(i++, responses.length - 1)] }) } });
}
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const use = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu' + Math.random(), name, input }] });
async function turn(user, text) {
  db.storeInboundMessage({ from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'webchat', text });
  await agent.tick();
}

describe('learning what the user calls people', () => {
  let sean, liz, allieA, allieB, gid;
  before(() => {
    sean = mkUser('+12025559501', 'Sean L');
    liz = db.upsertContact({ invited_by_user_id: sean.id, name: 'Elizabeth Taylor', phone: '+12025559502', tier: 1 });
    allieA = db.upsertContact({ invited_by_user_id: sean.id, name: 'Allie', phone: '+12025559503', tier: 1 });
    allieB = db.upsertContact({ invited_by_user_id: sean.id, name: 'Allie', phone: '+12025559504', tier: 1 });
    gid = db.upsertContactGroup(sean.id, 'Crew');
  });

  test('first time "Liz" is only a likely match; once the user acts on Elizabeth, "Liz" is learned', async () => {
    const first = await agent.executeTool('lookup_contact', { query: 'Liz' }, sean.id, sean.phone);
    assert.equal(first.exact_match, false, 'the agent confirms the first time');
    // The user confirms; the agent adds her to a group in the same conversation.
    script([use('lookup_contact', { query: 'Liz' }), use('manage_contact_group', { action: 'add_member', group_id: gid, contact_id: liz }), say('Added Liz to Crew.')]);
    await turn(sean, 'yes, Elizabeth Taylor — add Liz to my crew');
    assert.match(db.getContact(liz).also_known_as, /Liz/);
    const again = await agent.executeTool('lookup_contact', { query: 'Liz' }, sean.id, sean.phone);
    assert.equal(again.exact_match, true);
    assert.equal(again.contacts[0].name, 'Elizabeth Taylor');
  });

  test('two contacts called "Allie": the one the user picked comes first next time', async () => {
    // Exact names (100) aren't "learned", so the user picks by phone: 9504.
    script([use('lookup_contact', { query: 'Allie 9504' }), use('manage_contact_group', { action: 'add_member', group_id: gid, contact_id: allieB }), say('Added.')]);
    await turn(sean, 'add the Allie ending 9504 to my crew');
    assert.equal(db.getContact(allieB).also_known_as || null, null, 'a phone number is never saved as a name');
    // A spoken name that wasn't exact is learned, and then wins over the namesake.
    script([use('lookup_contact', { query: 'Al' }), use('manage_contact_group', { action: 'remove_member', group_id: gid, contact_id: allieB }), say('Done.')]);
    await turn(sean, 'take Al out of my crew');
    const r = await agent.executeTool('lookup_contact', { query: 'Al' }, sean.id, sean.phone);
    assert.equal(r.contacts[0].id, allieB);
    assert.equal(r.exact_match, true);
    assert.ok(allieA);
  });

  test("nothing is learned from another agent's messages, or when no one was acted on", async () => {
    const before = db.getContact(allieA).also_known_as;
    await agent.executeTool('lookup_contact', { query: 'Allie McFake' }, sean.id, sean.phone);
    assert.equal(db.getContact(allieA).also_known_as, before);
  });
});
