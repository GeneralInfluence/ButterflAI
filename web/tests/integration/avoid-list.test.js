/**
 * avoid-list.test.js — "act on it, never say it" (PRIVACY.md) + private-mode hardening.
 *
 * Avoid lists:
 *  - encrypted at rest (only user_id is plaintext), every read access-logged
 *  - the host's avoided contacts are never invited (Invariant 9, enforced in code)
 *  - an invite FROM an avoided person is auto-declined by default, looking exactly
 *    like a manual decline to the host, with no reason anywhere the host can see
 *  - per-person "ask" policy flags the invite and prompts the invitee instead
 *  - group events that include an avoided person always ask, including when the
 *    avoided person is added after the user was invited (owner decision 2)
 *  - every automatic action is recorded (encrypted) in the owner's activity log
 *  - owner-only HTTP routes, scoped per user (Invariant 4)
 *
 * Private mode:
 *  - plain-text write tools refused in code (Invariant 7)
 *  - the user's message and the reply are kept only encrypted; the queued copy is
 *    scrubbed; only the owner's chat view decrypts them (owner decision 4)
 *  - GET /api/chat/sensitive-mode returns the persisted state
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'avoid-list-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: () => Promise.resolve({ sid: 'MOCK' }) } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const multiparty = require('../../multiparty');
const agent = require('../../agent');
const avoid = require('../../avoid');
const sensitive = require('../../sensitive');

const FUTURE = () => Math.floor(Date.now() / 1000) + 3 * 24 * 3600;

function mkUser(phone, name) {
  const existing = db.getUserByPhone(phone);
  if (existing) return existing;
  db._raw().prepare(
    `INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/New_York')`
  ).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}

// `owner`'s contact row for `person` ({ name, phone }).
function contactOf(owner, person) {
  return db.upsertContact({ invited_by_user_id: owner.id, name: person.name, phone: person.phone, tier: 2 });
}

function invitation(eventId, phone) {
  return db._raw().prepare(
    `SELECT ei.* FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?`
  ).get(eventId, phone);
}

function pendingFor(user) {
  return db.getPendingInboundMessages().filter((m) => m.from_id === user.id);
}

// Everything the host side can see: its queued agent messages, chat history, agent_messages.
function hostVisibleText(host) {
  const inbound = db._raw().prepare('SELECT text FROM inbound_messages WHERE from_id = ?').all(host.id).map((r) => r.text);
  const history = db._raw().prepare('SELECT text FROM conversation_history WHERE user_id = ?').all(host.id).map((r) => r.text);
  const a2a = db._raw().prepare('SELECT body FROM agent_messages WHERE to_user = ?').all(host.id).map((r) => r.body);
  return [...inbound, ...history, ...a2a].join('\n');
}

async function cookieFor(user) {
  await request.post('/auth/otp/send').send({ phone: user.phone });
  const { code } = db._raw().prepare(
    `SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1`
  ).get(user.phone);
  const res = await request.post('/auth/otp/verify').send({ phone: user.phone, code });
  return res.headers['set-cookie'][0];
}

describe('avoid list storage', () => {
  let owner, julie, julieId;
  before(() => {
    owner = mkUser('+12025557001', 'Store Owner');
    julie = { name: 'Julie Storage', phone: '+12025557002' };
    julieId = contactOf(owner, julie);
  });

  test('entry is encrypted at rest — no name or phone in the row', () => {
    const r = avoid.addAvoid(owner.id, julieId);
    assert.equal(r.ok, true);
    assert.equal(r.on_invite, 'auto_decline', 'default policy minimizes questions');
    const raw = JSON.stringify(db._raw().prepare('SELECT * FROM avoid_list WHERE user_id = ?').all(owner.id));
    assert.ok(!raw.includes('Julie'), 'name must not be stored in plaintext');
    assert.ok(!raw.includes('5557002'), 'phone must not be stored in plaintext');
  });

  test('adding the same contact again updates instead of duplicating', () => {
    avoid.addAvoid(owner.id, julieId, { onInvite: 'ask' });
    const list = avoid.listAvoid(owner.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].on_invite, 'ask');
  });

  test('reads are access-logged', () => {
    avoid.listAvoid(owner.id, { context: 'test read' });
    const log = sensitive.getAccessLog(owner.id, 50);
    assert.ok(log.some((l) => l.data_key === 'avoid_list' && l.action === 'read' && l.context === 'test read'));
  });

  test("cannot add another user's contact, or touch another user's entry", () => {
    const other = mkUser('+12025557003', 'Other Owner');
    assert.equal(avoid.addAvoid(other.id, julieId).error, 'CONTACT_NOT_FOUND');
    const entryId = avoid.listAvoid(owner.id)[0].id;
    assert.equal(avoid.removeAvoid(other.id, entryId).error, 'NOT_FOUND');
    assert.equal(avoid.setPolicy(other.id, entryId, 'auto_decline').error, 'NOT_FOUND');
    assert.equal(avoid.listAvoid(owner.id).length, 1, 'entry untouched');
  });

  test('entries never expire — no TTL column, still present', () => {
    const cols = db._raw().prepare('PRAGMA table_info(avoid_list)').all().map((c) => c.name);
    assert.ok(!cols.some((c) => /purge|expire|ttl/.test(c)));
  });
});

describe('host side — avoided contacts are never invited (Invariant 9)', () => {
  test('inviteContacts skips an avoided contact and reports it', async () => {
    const host = mkUser('+12025557101', 'Filter Host');
    const dave = { name: 'Dave Avoided', phone: '+12025557102' };
    const sam  = { name: 'Sam Friend',   phone: '+12025557103' };
    const daveId = contactOf(host, dave);
    const samId  = contactOf(host, sam);
    avoid.addAvoid(host.id, daveId);

    const eventId = multiparty.createEvent(host.id, { title: 'Filter Dinner', activity_type: 'dinner', scheduled_at: FUTURE() });
    const r = await multiparty.inviteContacts(eventId, [daveId, samId]);

    assert.deepEqual(r.avoided, ['Dave Avoided']);
    assert.equal(r.sent, 1);
    assert.equal(invitation(eventId, dave.phone), undefined, 'no invitation row for the avoided contact');
    assert.ok(invitation(eventId, sam.phone), 'others still invited');
  });

  test('create_social_event tells the agent who was left out', async () => {
    const host = mkUser('+12025557111', 'Tool Host');
    const daveId = contactOf(host, { name: 'Dave Tool', phone: '+12025557112' });
    avoid.addAvoid(host.id, daveId);
    const r = await agent.executeTool('create_social_event',
      { title: 'Tool Drinks', activity_type: 'drinks', scheduled_at: new Date(FUTURE() * 1000).toISOString(), contact_ids: [daveId] },
      host.id, host.phone);
    assert.deepEqual(r.avoided_not_invited, ['Dave Tool']);
    assert.equal(r.invites_sent, 0);
  });
});

describe('invitee side — invites from an avoided person', () => {
  let julieHost, me, meContactAtJulie;
  before(() => {
    julieHost = mkUser('+12025557201', 'Julie Host');
    me = mkUser('+12025557202', 'Me Invitee');
    meContactAtJulie = contactOf(julieHost, me);
    const julieAtMe = contactOf(me, julieHost);
    avoid.addAvoid(me.id, julieAtMe); // default: auto_decline
  });

  test('auto_decline: declined, host gets the ordinary decline notice, no reason anywhere', async () => {
    const eventId = multiparty.createEvent(julieHost.id, { title: 'Julie Brunch', activity_type: 'brunch', scheduled_at: FUTURE() });
    const r = await multiparty.inviteContacts(eventId, [meContactAtJulie]);
    assert.equal(r.sent, 1, 'from the host side the invite was delivered like any other');

    const inv = invitation(eventId, me.phone);
    assert.equal(inv.status, 'declined');
    assert.ok(inv.responded_at);

    const notice = pendingFor(julieHost).map((m) => m.text).find((t) => t.includes('Julie Brunch'));
    assert.match(notice, /^\[Agent-to-Agent RSVP\] ❌ .+ has declined the invite for "Julie Brunch" on /,
      'same format as a manual decline (shared queueHostRsvpNotice)');
    assert.doesNotMatch(hostVisibleText(julieHost), /avoid|automatic|auto-declin/i, 'nothing the host can see hints at why');
    assert.equal(pendingFor(me).filter((m) => m.text.includes('Julie Brunch')).length, 0, 'invitee is not asked');
  });

  test('auto_decline is recorded, encrypted, in the invitee activity log', () => {
    const acts = avoid.listActivity(me.id);
    const a = acts.find((x) => x.kind === 'auto_declined' && x.text.includes('Julie Brunch'));
    assert.ok(a, 'activity entry exists');
    assert.match(a.text, /avoid list/);
    const raw = JSON.stringify(db._raw().prepare('SELECT * FROM agent_activity WHERE user_id = ?').all(me.id));
    assert.ok(!raw.includes('Julie'), 'activity description is not stored in plaintext');
  });

  test('ask policy: invite stays open, flagged, and the invitee is prompted', async () => {
    const entry = avoid.listAvoid(me.id)[0];
    avoid.setPolicy(me.id, entry.id, 'ask');
    const eventId = multiparty.createEvent(julieHost.id, { title: 'Julie Picnic', activity_type: 'picnic', scheduled_at: FUTURE() });
    await multiparty.inviteContacts(eventId, [meContactAtJulie]);

    const inv = invitation(eventId, me.phone);
    assert.equal(inv.status, 'invited');
    assert.equal(inv.needs_owner_decision, 1);
    assert.ok(pendingFor(me).some((m) => m.text.startsWith('[Invite needs your decision]') && m.text.includes('Julie Picnic')));
    assert.ok(!pendingFor(julieHost).some((m) => m.text.includes('Julie Picnic')), 'host is not told anything yet');
    assert.ok(avoid.listActivity(me.id).some((a) => a.kind === 'needs_decision' && a.text.includes('Julie Picnic')));
  });

  test('answering the invite clears the flag', async () => {
    const eventId = multiparty.createEvent(julieHost.id, { title: 'Julie Movie', activity_type: 'movie', scheduled_at: FUTURE() });
    await multiparty.inviteContacts(eventId, [meContactAtJulie]);
    const inv = invitation(eventId, me.phone);
    await agent.executeTool('confirm_coordination_invite', { invitation_id: inv.id, status: 'declined' }, me.id, me.phone);
    assert.equal(invitation(eventId, me.phone).needs_owner_decision, 0);
  });
});

describe('group events with an avoided person always ask (owner decision 2)', () => {
  let host, me, dave, meAtHost, daveAtHost;
  before(() => {
    host = mkUser('+12025557301', 'Group Host');
    me   = mkUser('+12025557302', 'Group Me');
    dave = { name: 'Dave Group', phone: '+12025557303' };
    meAtHost   = contactOf(host, me);
    daveAtHost = contactOf(host, dave);
    // Default auto_decline policy — the group rule must still ask, not decline.
    avoid.addAvoid(me.id, contactOf(me, dave));
  });

  test('avoided person already invited → asked, not declined', async () => {
    const eventId = multiparty.createEvent(host.id, { title: 'Group Bowling', activity_type: 'bowling', scheduled_at: FUTURE() });
    await multiparty.inviteContacts(eventId, [daveAtHost]);
    await multiparty.inviteContacts(eventId, [meAtHost]);
    const inv = invitation(eventId, me.phone);
    assert.equal(inv.status, 'invited');
    assert.equal(inv.needs_owner_decision, 1);
    const prompt = pendingFor(me).find((m) => m.text.includes('Group Bowling'));
    assert.ok(prompt, 'invitee prompted');
    assert.ok(!prompt.text.includes('Dave'), 'queued prompt names nobody — the name is only in the encrypted activity log');
  });

  test('avoided person added AFTER the user was invited → user is asked then', async () => {
    const eventId = multiparty.createEvent(host.id, { title: 'Group Karaoke', activity_type: 'karaoke', scheduled_at: FUTURE() });
    await multiparty.inviteContacts(eventId, [meAtHost]);
    assert.equal(invitation(eventId, me.phone).needs_owner_decision, 0, 'no conflict yet');
    await multiparty.inviteContacts(eventId, [daveAtHost]);
    assert.equal(invitation(eventId, me.phone).needs_owner_decision, 1);
    assert.ok(pendingFor(me).some((m) => m.text.includes('Group Karaoke')));
    assert.ok(avoid.listActivity(me.id).some((a) => a.text.includes('Dave Group') && a.text.includes('Group Karaoke')));
  });

  test("agent's state snapshot marks the invite ASK YOUR USER", async () => {
    // buildSystemPrompt's snapshot is assembled in processMessage; check the query it uses.
    const rows = db._raw().prepare(`
      SELECT ei.needs_owner_decision FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
      JOIN social_events se ON se.id = ei.event_id WHERE c.phone = ? AND se.title = 'Group Karaoke'`).all(me.phone);
    assert.equal(rows[0].needs_owner_decision, 1);
  });
});

describe('manage_avoid_list tool', () => {
  test('add / set_policy / list / remove', async () => {
    const u = mkUser('+12025557401', 'Tool User');
    const cid = contactOf(u, { name: 'Nate Tool', phone: '+12025557402' });
    assert.equal((await agent.executeTool('manage_avoid_list', { action: 'add', contact_id: cid }, u.id, u.phone)).on_invite, 'auto_decline');
    assert.equal((await agent.executeTool('manage_avoid_list', { action: 'set_policy', contact_id: cid, on_invite: 'ask' }, u.id, u.phone)).on_invite, 'ask');
    const list = await agent.executeTool('manage_avoid_list', { action: 'list' }, u.id, u.phone);
    assert.deepEqual(list.entries, [{ contact_id: cid, name: 'Nate Tool', on_invite: 'ask' }]);
    assert.equal((await agent.executeTool('manage_avoid_list', { action: 'remove', contact_id: cid }, u.id, u.phone)).removed, true);
    assert.equal(avoid.listAvoid(u.id).length, 0);
  });
});

describe('avoid list + activity HTTP routes are owner-only (Invariant 4)', () => {
  let owner, intruder, cookieOwner, cookieIntruder, entryId;
  before(async () => {
    owner = mkUser('+12025557501', 'Route Owner');
    intruder = mkUser('+12025557502', 'Route Intruder');
    const cid = contactOf(owner, { name: 'Julie Route', phone: '+12025557503' });
    entryId = avoid.addAvoid(owner.id, cid).id;
    avoid.recordActivity(owner.id, 'auto_declined', { text: 'Declined Julie Route invite' });
    cookieOwner = await cookieFor(owner);
    cookieIntruder = await cookieFor(intruder);
  });

  test('owner sees their list and activity; intruder sees none of it', async () => {
    const mine = await request.get('/api/user/avoid-list').set('Cookie', cookieOwner);
    assert.deepEqual(mine.body.entries.map((e) => e.name), ['Julie Route']);
    const theirs = await request.get('/api/user/avoid-list').set('Cookie', cookieIntruder);
    assert.deepEqual(theirs.body.entries, []);
    const act = await request.get('/api/user/activity').set('Cookie', cookieIntruder);
    assert.deepEqual(act.body.activity, []);
    const ownAct = await request.get('/api/user/activity').set('Cookie', cookieOwner);
    assert.ok(ownAct.body.activity.some((a) => a.text.includes('Julie Route')));
  });

  test("intruder cannot change or delete the owner's entry", async () => {
    const p = await request.patch(`/api/user/avoid-list/${entryId}`).set('Cookie', cookieIntruder).send({ on_invite: 'ask' });
    assert.equal(p.status, 404);
    const d = await request.delete(`/api/user/avoid-list/${entryId}`).set('Cookie', cookieIntruder);
    assert.equal(d.status, 404);
    assert.equal(avoid.listAvoid(owner.id)[0].on_invite, 'auto_decline');
  });

  test('owner can switch a person to "ask me first"', async () => {
    const p = await request.patch(`/api/user/avoid-list/${entryId}`).set('Cookie', cookieOwner).send({ on_invite: 'ask' });
    assert.equal(p.status, 200);
    assert.equal(avoid.listAvoid(owner.id)[0].on_invite, 'ask');
  });

  test('unauthenticated requests are rejected', async () => {
    const r = await request.get('/api/user/avoid-list');
    assert.ok([302, 401].includes(r.status));
  });
});

describe('private mode — enforced in code, history kept only encrypted', () => {
  let u, cookie;
  before(async () => {
    u = mkUser('+12025557601', 'Private User');
    sensitive.setSensitiveMode(u.id, true);
    cookie = await cookieFor(u);
  });

  test('plain-text write tools are refused while private mode is on', async () => {
    const p = await agent.executeTool('update_preferences', { vibe: 'dive bars' }, u.id, u.phone);
    assert.equal(p.error, 'PRIVATE_MODE_ON');
    const n = await agent.executeTool('save_agent_note', { note: 'something private' }, u.id, u.phone);
    assert.equal(n.error, 'PRIVATE_MODE_ON');
    const prefs = db._raw().prepare('SELECT vibe FROM user_preferences WHERE user_id = ?').get(u.id);
    assert.ok(!String(prefs?.vibe || '').includes('dive'), 'nothing written to user_preferences');
  });

  test('GET /api/chat/sensitive-mode reports the persisted state', async () => {
    const r = await request.get('/api/chat/sensitive-mode').set('Cookie', cookie);
    assert.equal(r.body.sensitive_mode, true);
  });

  test('message + reply stored only encrypted, queue scrubbed, owner view decrypts', async () => {
    agent._setAnthropic({ messages: { create: async () => ({
      id: 'msg_private', content: [{ type: 'text', text: 'Noted, kept private.' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }) } });
    const SECRET = 'my STI test came back fine';
    db.storeInboundMessage({ from_phone: u.phone, from_type: 'user', from_id: u.id, channel: 'webchat', text: SECRET });
    await agent.tick();

    const rows = db._raw().prepare('SELECT * FROM conversation_history WHERE user_id = ? ORDER BY created_at').all(u.id);
    assert.ok(rows.length >= 2, 'user message and reply stored');
    assert.ok(rows.every((r) => r.text === '🔒 Private message' && r.private_ct), 'only placeholders in plaintext');
    assert.ok(!JSON.stringify(rows).includes('STI'), 'secret not in the history table');

    const queued = db._raw().prepare('SELECT text FROM inbound_messages WHERE from_id = ?').all(u.id);
    assert.ok(!JSON.stringify(queued).includes('STI'), 'queued copy scrubbed');

    const view = await request.get('/api/chat/messages').set('Cookie', cookie);
    const texts = view.body.messages.map((m) => m.text);
    assert.ok(texts.includes(SECRET), 'owner sees their own message');
    assert.ok(texts.includes('Noted, kept private.'), 'owner sees the reply');
    assert.ok(view.body.messages.every((m) => m.private === true));
  });

  test('with private mode off, history is plain text as before', async () => {
    sensitive.setSensitiveMode(u.id, false);
    db.storeInboundMessage({ from_phone: u.phone, from_type: 'user', from_id: u.id, channel: 'webchat', text: 'what is on friday' });
    await agent.tick();
    const row = db._raw().prepare(`SELECT * FROM conversation_history WHERE user_id = ? AND text = 'what is on friday'`).get(u.id);
    assert.ok(row && !row.private_ct);
  });
});
