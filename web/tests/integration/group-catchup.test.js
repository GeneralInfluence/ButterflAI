/**
 * group-catchup.test.js — joining a group means joining its plans.
 *
 * Owner, 2026-10-09: "add Alex Spargo to My Favorite Mamas … she should be updated with
 * all the current plans going on with that group, which would include the camping trip."
 * Decision: always, automatically — one catch-up message, not one per plan; plan details
 * only (never the group's discussion); opt-outs and avoid lists apply as for any invite.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'group-catchup-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
const texts = [];
sms._setClient({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' + texts.length }; } } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const avoid = require('../../avoid');
const plans = require('../../plans');

let n = 0;
function mkUser(name) {
  const phone = `+1202555${String(8900 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const history = (u) => db._raw().prepare('SELECT text, kind FROM conversation_history WHERE user_id = ? ORDER BY rowid').all(u.id);

describe('adding someone to a group catches them up on its plans', () => {
  let sean, allie, mel, gid, eventId;
  before(async () => {
    sean = mkUser('Sean Gonzalez'); allie = mkUser('Allie McLaine'); mel = mkUser('Melanie Noel');
    gid = db.upsertContactGroup(sean.id, "Favorite Mama's");
    db.addContactToGroup(gid, knows(sean, allie));
    db.addContactToGroup(gid, knows(sean, mel));
    // A group plan: "my favorite mamas" matches "Favorite Mama's".
    const r = await agent.executeTool('create_social_event', { title: 'Grover Hot Springs', activity_type: 'camping trip', group: 'my favorite mamas',
      tentative: true, scheduled_at: new Date(Date.now() + 14 * 86400e3).toISOString(), duration_mins: 2880,
      venue_name: 'Grover Hot Springs State Park', notes: 'heated shiftpod for everyone' }, sean.id, sean.phone);
    eventId = r.eventId;
    assert.equal(r.invites_sent, 2, 'every member invited');
    await agent.executeTool('record_rsvp', { event_id: eventId, contact_phone: mel.phone, status: 'accepted' }, sean.id, sean.phone);
    // Something said in the discussion that must NOT be in a catch-up.
    db.appendConversation(sean.id, 'user', "Allie's on a budget, cabin is too pricey for her");
  });

  test('a ButterflAI user: invited, one labelled catch-up with dates, place, plan so far and who\'s in — nothing from the discussion', async () => {
    const bam = mkUser('Bam Bam');
    const r = await agent.executeTool('manage_contact_group', { action: 'add_member', group_id: gid, contact_id: knows(sean, bam) }, sean.id, sean.phone);
    assert.deepEqual(r.caught_up_on, ['Grover Hot Springs']);
    const inv = db._raw().prepare(`SELECT ei.status FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?`).get(eventId, bam.phone);
    assert.equal(inv.status, 'invited');
    const card = history(bam).find((m) => m.kind === 'incoming');
    assert.match(card.text, /^💬 From Sean's ButterflAI: You're now in Sean's "Favorite Mama's" group\. What's planned:\n• Grover Hot Springs \(tentative\) — \w{3}, \w{3} \d+ – \w{3}, \w{3} \d+ · Grover Hot Springs State Park · plan so far: heated shiftpod for everyone · in: Sean, Melanie/);
    assert.ok(!card.text.includes('budget'), 'nothing from the discussion');
    assert.ok(plans.feedFor(bam.id).items.some((i) => i.event_id === eventId), 'on their Home');
  });

  test('someone not on ButterflAI: one first-contact text that identifies itself and offers STOP', async () => {
    texts.length = 0;
    const alexC = db.upsertContact({ invited_by_user_id: sean.id, name: 'Alex Spargo', phone: '+12025558999', tier: 0 });
    const r = await agent.executeTool('manage_contact_group', { action: 'add_member', group_id: gid, contact_id: alexC }, sean.id, sean.phone);
    assert.equal(r.catch_up_via, 'sms');
    assert.equal(texts.length, 1, 'one text, not one per plan');
    assert.match(texts[0].body, /^Hi Alex! This is Sean's ButterflAI\. Sean added you to the "Favorite Mama's" group\. What's planned:\n• Grover Hot Springs/);
    assert.match(texts[0].body, /Reply STOP to opt out\.$/);
    assert.ok(history(sean).some((m) => m.kind === 'outgoing' && m.text.startsWith('📤 To Alex Spargo (by text): caught up on Grover Hot Springs')));
  });

  test('re-adding someone already in the group sends nothing', async () => {
    texts.length = 0;
    const alexC = db._raw().prepare("SELECT id FROM contacts WHERE phone = '+12025558999'").get().id;
    const r = await agent.executeTool('manage_contact_group', { action: 'add_member', group_id: gid, contact_id: alexC }, sean.id, sean.phone);
    assert.equal(r.already_member, true);
    assert.equal(texts.length, 0);
  });

  test("someone who avoids Sean: their own avoid list applies — no catch-up", async () => {
    const pat = mkUser('Pat Avoids');
    avoid.addAvoid(pat.id, knows(pat, sean));
    const r = await agent.executeTool('manage_contact_group', { action: 'add_member', group_id: gid, contact_id: knows(sean, pat) }, sean.id, sean.phone);
    assert.equal(r.caught_up_on, undefined);
    assert.ok(!history(pat).some((m) => m.kind === 'incoming'));
  });

  test('adding in the app (People → Groups → Add people) does the same and reports it', async () => {
    const zoe = mkUser('Zoe App');
    await request.post('/auth/otp/send').send({ phone: sean.phone });
    const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(sean.phone);
    const cookie = (await request.post('/auth/otp/verify').send({ phone: sean.phone, code })).headers['set-cookie'][0];
    const res = await request.post(`/api/contacts/groups/${gid}/members`).set('Cookie', cookie).send({ contact_id: knows(sean, zoe) });
    assert.deepEqual(res.body.caught_up_on, ['Grover Hot Springs']);
    assert.ok(history(zoe).some((m) => m.kind === 'incoming' && m.text.includes('Grover Hot Springs')));
  });

  test('a group with no upcoming plans: added quietly, no message', async () => {
    texts.length = 0;
    const g2 = db.upsertContactGroup(sean.id, 'Book club');
    const quiet = mkUser('Quiet One');
    const r = await agent.executeTool('manage_contact_group', { action: 'add_member', group_id: g2, contact_id: knows(sean, quiet) }, sean.id, sean.phone);
    assert.equal(r.added, true);
    assert.equal(r.caught_up_on, undefined);
    assert.ok(!history(quiet).length);
  });
});
