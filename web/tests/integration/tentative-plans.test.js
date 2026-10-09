/**
 * tentative-plans.test.js — trips the group is still figuring out, and the Home feed.
 *
 * Owner, 2026-10-09 (the Grover Hot Springs trip): it was coordinated across three
 * people's agents but never created, so nothing showed on Home. "It should be something
 * ButterflAI manages … tentative as the group figures out the details" — friends who are
 * clearly in have it on their calendar; the feed is prioritized by days out and by the
 * actions needed to make progress; trips weeks out show; so do questions waiting.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'tentative-test';
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
  const phone = `+1202555${String(8300 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const inTwoWeeks = () => new Date(Date.now() + 23 * 86400e3).toISOString();   // past the old 14-day window

describe('a trip being planned', () => {
  let sean, allie, mel, eventId, allieC, melC;
  before(async () => {
    sean = mkUser('Sean Gonzalez'); allie = mkUser('Allie McLaine'); mel = mkUser('Melanie Noel');
    allieC = knows(sean, allie); melC = knows(sean, mel); knows(allie, sean); knows(mel, sean);
    const r = await agent.executeTool('create_social_event', { title: 'Grover Hot Springs', activity_type: 'camping trip',
      scheduled_at: inTwoWeeks(), duration_mins: 2880, tentative: true, contact_ids: [allieC, melC] }, sean.id, sean.phone);
    eventId = r.eventId;
    assert.equal(r.invites_sent, 2);
  });

  test('created tentative; shows on everyone\'s Home 23 days out', () => {
    assert.equal(db._raw().prepare('SELECT tentative FROM social_events WHERE id = ?').get(eventId).tentative, 1);
    const host = plans.feedFor(sean.id).items.find((i) => i.event_id === eventId);
    assert.equal(host.tentative, true);
    assert.deepEqual(host.waiting_on.sort(), ['Allie', 'Melanie']);
    const guest = plans.feedFor(allie.id).items.find((i) => i.event_id === eventId);
    assert.equal(guest.type, 'invite');
    assert.match(guest.action, /Interested/);
  });

  test("coordination needs the event: without it nothing is sent; with it (host or invitee) it goes", async () => {
    const no = await agent.executeTool('message_agent', { contact_id: allieC, topic: 'coordination', message: 'Cabin or shiftpod?' }, sean.id, sean.phone);
    assert.equal(no.error, 'CREATE_EVENT_FIRST');
    const yes = await agent.executeTool('message_agent', { contact_id: allieC, topic: 'coordination', message: 'Cabin or shiftpod?', event_id: eventId }, sean.id, sean.phone);
    assert.equal(yes.sent, true);
    const back = await agent.executeTool('message_agent', { contact_id: knows(allie, sean), topic: 'coordination', message: 'Shiftpod works', event_id: eventId }, allie.id, allie.phone);
    assert.equal(back.sent, true, 'an invitee can coordinate on the event too');
    // Availability questions don't need an event.
    assert.equal((await agent.executeTool('message_agent', { contact_id: allieC, topic: 'availability', message: 'Free Friday?' }, sean.id, sean.phone)).sent, true);
  });

  test('clearly in → recorded as interested; it\'s on their calendar and the host sees it', async () => {
    const r = await agent.executeTool('record_rsvp', { event_id: eventId, contact_phone: allie.phone, status: 'accepted', source: "her ButterflAI's reply" }, sean.id, sean.phone);
    assert.equal(r.action_status, 'RSVP_RECORDED');
    const guest = plans.feedFor(allie.id).items.find((i) => i.event_id === eventId);
    assert.equal(guest.type, 'event');
    assert.equal(guest.tentative, true);
    const host = plans.feedFor(sean.id).items.find((i) => i.event_id === eventId);
    assert.deepEqual(host.interested, ['Allie']);
    assert.deepEqual(host.waiting_on, ['Melanie']);
    assert.equal(host.action, null, 'still waiting on Melanie');
  });

  test('everyone answered and still tentative → "lock in" is the host\'s next step, at the top', async () => {
    await agent.executeTool('record_rsvp', { event_id: eventId, contact_phone: mel.phone, status: 'accepted' }, sean.id, sean.phone);
    const feed = plans.feedFor(sean.id).items;
    const host = feed.find((i) => i.event_id === eventId);
    assert.match(host.action, /Lock in/);
    // Above everything that doesn't need Sean (an unanswered question from Allie, from the
    // earlier step, also needs him and may come first).
    const idx = feed.findIndex((i) => i.event_id === eventId);
    assert.ok(feed.slice(0, idx).every((i) => i.type === 'question' || i.type === 'invite' || i.action), JSON.stringify(feed.slice(0, idx)));
    const u = await agent.executeTool('update_event', { event_id: eventId, tentative: false }, sean.id, sean.phone);
    assert.deepEqual(u.updated, ['tentative']);
    assert.equal(plans.feedFor(sean.id).items.find((i) => i.event_id === eventId).action, null);
  });

  test("record_rsvp only works on your own event", async () => {
    const other = mkUser('Other Host');
    const r = await agent.executeTool('record_rsvp', { event_id: eventId, contact_phone: allie.phone, status: 'declined' }, other.id, other.phone);
    assert.equal(r.error, 'EVENT_NOT_FOUND');
  });

  test('non-users get a "tentatively … details still being worked out" invite', async () => {
    const pat = db.upsertContact({ invited_by_user_id: sean.id, name: 'Pat', phone: '+12025558399', tier: 1 });
    db.writeConsent('+12025558399', 'INVITE_PAGE');
    const ev = await agent.executeTool('create_social_event', { title: 'Tahoe weekend', activity_type: 'a Tahoe weekend', scheduled_at: inTwoWeeks(), tentative: true, contact_ids: [pat] }, sean.id, sean.phone);
    assert.equal(ev.invites_sent, 1);
    assert.match(texts.at(-1).body, /tentatively .* details still being worked out\). Interested\?/);
  });
});

describe('questions on the feed', () => {
  test('a question waiting on you is at the top; the asker sees who they\'re waiting on', async () => {
    const a = mkUser('Asker Amy'); const b = mkUser('Bea Answer');
    const bc = knows(a, b);
    plans.sharePlan(a.id, { text: 'Free tonight', until: 'tonight' });   // something else on b's feed
    knows(b, a);
    await agent.executeTool('message_agent', { contact_id: bc, topic: 'availability', message: 'Free Saturday for a hike?' }, a.id, a.phone);
    const bFeed = plans.feedFor(b.id).items;
    assert.equal(bFeed[0].type, 'question');
    assert.equal(bFeed[0].who, 'Asker');
    assert.equal(bFeed[0].action, 'Answer in chat');
    const waiting = plans.feedFor(a.id).items.find((i) => i.type === 'waiting');
    assert.deepEqual(waiting.who, ['Bea']);
    // Once answered, both go away.
    const q = db._raw().prepare("SELECT id FROM agent_messages WHERE from_user = ? AND kind = 'query'").get(a.id);
    await agent.executeTool('reply_agent', { message_id: q.id, body: 'Yes!' }, b.id, b.phone);
    assert.ok(!plans.feedFor(b.id).items.some((i) => i.type === 'question'));
    assert.ok(!plans.feedFor(a.id).items.some((i) => i.type === 'waiting'));
  });
});
