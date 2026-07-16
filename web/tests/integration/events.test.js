/**
 * events.test.js — Integration tests for event management features
 *
 * Covers issues found 2026-07-16:
 *   - Event deduplication (same title+host within 6h returns existing id)
 *   - event_type private/public
 *   - Invited events API + RSVP
 *   - RSVP notification rules (private always; public stranger decline = silent)
 *   - Event management endpoints (manage, PATCH, invite, DELETE invite)
 *   - Public RSVP endpoint
 *   - RSVP status visible in guest list
 */

'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.ANTHROPIC_API_KEY;

const { test, describe, before } = require('node:test');
const assert  = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create() { return Promise.resolve({ sid: 'SM_TEST' }); } } });

const { app }    = require('../../server');
const db         = require('../../db');
const multiparty = require('../../multiparty');
const request    = supertest(app);

// ── helpers ───────────────────────────────────────────────────────────────────

async function getAuthedCookie(phone) {
  const existing = db.getUserByPhone(phone);
  if (!existing) {
    const id = uuidv4();
    db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Test User', ?, 'complete')`).run(id, phone);
    db.writeConsent(phone, 'INVITE_PAGE');
  }
  const sendRes = await request.post('/auth/otp/send').send({ phone });
  assert.equal(sendRes.status, 200, 'OTP send failed');
  const otpRow = db._raw().prepare(`SELECT code FROM otp_codes WHERE phone=? AND used=0 ORDER BY created_at DESC LIMIT 1`).get(phone);
  const verifyRes = await request.post('/auth/otp/verify').send({ phone, code: otpRow.code });
  assert.equal(verifyRes.status, 200, 'OTP verify failed');
  return verifyRes.headers['set-cookie'][0];
}

function createUser(phone, name) {
  const existing = db.getUserByPhone(phone);
  if (existing) return existing;
  const id = uuidv4();
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'complete')`).run(id, name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}

// ── Event deduplication ───────────────────────────────────────────────────────

describe('createEvent — deduplication', () => {
  test('same title+host within 6h returns the same event id', () => {
    const hostId = createUser('+12025551001', 'Host Dedup').id;
    const ts = Math.floor(Date.now() / 1000) + 3600; // 1h from now

    const id1 = multiparty.createEvent(hostId, {
      title: 'Dedup Pool Party',
      activity_type: 'party',
      scheduled_at: ts,
    });
    const id2 = multiparty.createEvent(hostId, {
      title: 'Dedup Pool Party',
      activity_type: 'party',
      scheduled_at: ts + 1800, // 30 min later — still within 6h window
    });

    assert.equal(id1, id2, 'Duplicate event within 6h should return existing id');
  });

  test('same title but different host creates a new event', () => {
    const host1 = createUser('+12025551002', 'Host A').id;
    const host2 = createUser('+12025551003', 'Host B').id;
    const ts = Math.floor(Date.now() / 1000) + 7200;

    const id1 = multiparty.createEvent(host1, { title: 'Shared Title Event', activity_type: 'dinner', scheduled_at: ts });
    const id2 = multiparty.createEvent(host2, { title: 'Shared Title Event', activity_type: 'dinner', scheduled_at: ts });

    assert.notEqual(id1, id2, 'Different hosts should create separate events');
  });

  test('same title but >6h apart creates a new event', () => {
    const hostId = createUser('+12025551004', 'Host Far Apart').id;
    const ts = Math.floor(Date.now() / 1000) + 3600;

    const id1 = multiparty.createEvent(hostId, { title: 'Far Apart Event', activity_type: 'hike', scheduled_at: ts });
    const id2 = multiparty.createEvent(hostId, { title: 'Far Apart Event', activity_type: 'hike', scheduled_at: ts + 8 * 3600 });

    assert.notEqual(id1, id2, 'Events >6h apart should be separate');
  });
});

// ── event_type: private vs public ────────────────────────────────────────────

describe('createEvent — event_type', () => {
  test('default event_type is private', () => {
    const hostId = createUser('+12025551010', 'Host Private').id;
    const id = multiparty.createEvent(hostId, { title: 'Private Default', activity_type: 'dinner', scheduled_at: Math.floor(Date.now()/1000)+3600 });
    const ev = db._raw().prepare('SELECT event_type FROM social_events WHERE id=?').get(id);
    assert.equal(ev.event_type, 'private');
  });

  test('event_type=public is stored correctly', () => {
    const hostId = createUser('+12025551011', 'Host Public').id;
    const id = multiparty.createEvent(hostId, { title: 'Public Concert', activity_type: 'concert', scheduled_at: Math.floor(Date.now()/1000)+3600, event_type: 'public' });
    const ev = db._raw().prepare('SELECT event_type FROM social_events WHERE id=?').get(id);
    assert.equal(ev.event_type, 'public');
  });

  test('invalid event_type falls back to private', () => {
    const hostId = createUser('+12025551012', 'Host BadType').id;
    const id = multiparty.createEvent(hostId, { title: 'Bad Type Event', activity_type: 'dinner', scheduled_at: Math.floor(Date.now()/1000)+3600, event_type: 'nonsense' });
    const ev = db._raw().prepare('SELECT event_type FROM social_events WHERE id=?').get(id);
    assert.equal(ev.event_type, 'private');
  });
});

// ── Invited events API ────────────────────────────────────────────────────────

describe('GET /api/events/invited/me', () => {
  let organizer, inviteePhone, inviteeCookie, contactId, eventId;

  before(async () => {
    inviteePhone = '+12025551020';
    organizer    = createUser('+12025551021', 'Organizer Invite');
    const invitee = createUser(inviteePhone, 'Invitee Person');
    inviteeCookie = await getAuthedCookie(inviteePhone);

    // Organizer has invitee in their contacts
    contactId = db.upsertContact({ invited_by_user_id: organizer.id, name: 'Invitee Person', phone: inviteePhone, tier: 1 });

    // Organizer creates event and invites the contact
    eventId = multiparty.createEvent(organizer.id, {
      title: 'Invited Events Test Party',
      activity_type: 'party',
      scheduled_at: Math.floor(Date.now()/1000) + 3600,
    });
    await multiparty.inviteContacts(eventId, [contactId]);
  });

  test('invitee sees the event in their invited list', async () => {
    const res = await request.get('/api/events/invited/me').set('Cookie', inviteeCookie);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.events), 'events should be array');
    const found = res.body.events.find(e => e.id === eventId);
    assert.ok(found, 'Invited event should appear');
    assert.equal(found.rsvp_status, 'invited', 'Default RSVP status should be invited');
  });

  test('unauthenticated → 401', async () => {
    const res = await request.get('/api/events/invited/me');
    assert.equal(res.status, 401);
  });
});

// ── RSVP from web app ─────────────────────────────────────────────────────────

describe('POST /api/events/rsvp', () => {
  let organizerPhone, inviteePhone, inviteeCookie, invitationId, eventId;

  before(async () => {
    organizerPhone = '+12025551030';
    inviteePhone   = '+12025551031';
    const org     = createUser(organizerPhone, 'Rsvp Organizer');
    createUser(inviteePhone, 'Rsvp Invitee');
    inviteeCookie = await getAuthedCookie(inviteePhone);

    const contactId = db.upsertContact({ invited_by_user_id: org.id, name: 'Rsvp Invitee', phone: inviteePhone, tier: 1 });
    eventId = multiparty.createEvent(org.id, {
      title: 'RSVP Test Event',
      activity_type: 'dinner',
      scheduled_at: Math.floor(Date.now()/1000) + 3600,
    });
    await multiparty.inviteContacts(eventId, [contactId]);

    const inv = db._raw().prepare(`SELECT ei.id FROM event_invitations ei JOIN contacts c ON c.id=ei.contact_id WHERE ei.event_id=? AND c.phone=?`).get(eventId, inviteePhone);
    invitationId = inv?.id;
  });

  test('invitee can accept', async () => {
    // Need a fresh event for this test
    const org2 = createUser('+12025551032', 'Org2');
    const cid  = db.upsertContact({ invited_by_user_id: org2.id, name: 'Rsvp Invitee', phone: inviteePhone, tier: 1 });
    const eid  = multiparty.createEvent(org2.id, { title: 'Accept Test', activity_type: 'dinner', scheduled_at: Math.floor(Date.now()/1000)+7200 });
    await multiparty.inviteContacts(eid, [cid]);
    const inv = db._raw().prepare(`SELECT ei.id FROM event_invitations ei JOIN contacts c ON c.id=ei.contact_id WHERE ei.event_id=? AND c.phone=?`).get(eid, inviteePhone);

    const res = await request
      .post('/api/events/rsvp')
      .set('Cookie', inviteeCookie)
      .send({ invitation_id: inv.id, status: 'accepted' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'accepted');

    const updated = db._raw().prepare('SELECT status FROM event_invitations WHERE id=?').get(inv.id);
    assert.equal(updated.status, 'accepted');
  });

  test('invitee can decline', async () => {
    const res = await request
      .post('/api/events/rsvp')
      .set('Cookie', inviteeCookie)
      .send({ invitation_id: invitationId, status: 'declined' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'declined');

    const updated = db._raw().prepare('SELECT status FROM event_invitations WHERE id=?').get(invitationId);
    assert.equal(updated.status, 'declined');
  });

  test('wrong phone → 403', async () => {
    // inviteeCookie belongs to inviteePhone; try to RSVP someone else's invite
    const otherOrg  = createUser('+12025551033', 'Other Org');
    const otherInvitee = createUser('+12025551034', 'Other Invitee');
    const cid = db.upsertContact({ invited_by_user_id: otherOrg.id, name: 'Other', phone: '+12025551034', tier: 1 });
    const eid = multiparty.createEvent(otherOrg.id, { title: 'Others Event', activity_type: 'lunch', scheduled_at: Math.floor(Date.now()/1000)+3600 });
    await multiparty.inviteContacts(eid, [cid]);
    const inv = db._raw().prepare(`SELECT ei.id FROM event_invitations ei JOIN contacts c ON c.id=ei.contact_id WHERE ei.event_id=?`).get(eid);

    const res = await request
      .post('/api/events/rsvp')
      .set('Cookie', inviteeCookie)   // inviteeCookie is for inviteePhone, not otherInvitee
      .send({ invitation_id: inv.id, status: 'accepted' });
    assert.equal(res.status, 403);
  });

  test('invalid status → 400', async () => {
    const res = await request
      .post('/api/events/rsvp')
      .set('Cookie', inviteeCookie)
      .send({ invitation_id: invitationId, status: 'maybe' });
    assert.equal(res.status, 400);
  });
});

// ── RSVP notification rules ───────────────────────────────────────────────────

describe('rsvpInvitation — notification rules', () => {
  function makeEvent(hostPhone, hostName, eventType) {
    const host = createUser(hostPhone, hostName);
    const eventId = multiparty.createEvent(host.id, {
      title: `Notify Test ${hostPhone}`,
      activity_type: 'party',
      scheduled_at: Math.floor(Date.now()/1000) + 3600,
      event_type: eventType,
    });
    return { host, eventId };
  }

  function makeContact(ownerUserId, phone, name) {
    return db.upsertContact({ invited_by_user_id: ownerUserId, name, phone, tier: 1 });
  }

  async function rsvpAndGetConvo(hostId, eventId, contactPhone, status, source = 'contact') {
    const inv = db._raw().prepare(`SELECT ei.id FROM event_invitations ei JOIN contacts c ON c.id=ei.contact_id WHERE ei.event_id=? AND c.phone=?`).get(eventId, contactPhone);
    if (!inv) throw new Error('No invitation found');
    if (source !== 'contact') {
      db._raw().prepare('UPDATE event_invitations SET source=? WHERE id=?').run(source, inv.id);
    }
    multiparty.rsvpInvitation(inv.id, contactPhone, status);
    return db._raw().prepare(`SELECT * FROM conversation_history WHERE user_id=? ORDER BY created_at DESC LIMIT 1`).get(hostId);
  }

  test('private event: decline notifies organizer', async () => {
    const invPhone = '+12025551040';
    const { host, eventId } = makeEvent('+12025551041', 'Priv Host Accept', 'private');
    createUser(invPhone, 'Private Invitee');
    const cid = makeContact(host.id, invPhone, 'Private Invitee');
    await multiparty.inviteContacts(eventId, [cid]);

    const msg = await rsvpAndGetConvo(host.id, eventId, invPhone, 'declined');
    assert.ok(msg, 'Should have a conversation message');
    assert.ok(msg.text.includes('declined'), 'Message should mention declined');
  });

  test('public event, contact-sourced: decline notifies organizer', async () => {
    const invPhone = '+12025551042';
    const { host, eventId } = makeEvent('+12025551043', 'Pub Host Contact', 'public');
    createUser(invPhone, 'Public Contact Invitee');
    const cid = makeContact(host.id, invPhone, 'Public Contact Invitee');
    await multiparty.inviteContacts(eventId, [cid]);

    const msg = await rsvpAndGetConvo(host.id, eventId, invPhone, 'declined', 'contact');
    assert.ok(msg, 'Should have a conversation message');
    assert.ok(msg.text.includes('declined'), 'Contact decline on public event should notify organizer');
  });

  test('public event, stranger RSVP: decline does NOT notify organizer', async () => {
    const invPhone = '+12025551044';
    const { host, eventId } = makeEvent('+12025551045', 'Pub Host Stranger', 'public');
    createUser(invPhone, 'Stranger');
    const cid = makeContact(host.id, invPhone, 'Stranger');
    await multiparty.inviteContacts(eventId, [cid]);

    // Mark invitation as public/stranger-sourced
    const convoBefore = db._raw().prepare(`SELECT COUNT(*) as n FROM conversation_history WHERE user_id=?`).get(host.id);
    await rsvpAndGetConvo(host.id, eventId, invPhone, 'declined', 'public');
    const convoAfter = db._raw().prepare(`SELECT COUNT(*) as n FROM conversation_history WHERE user_id=?`).get(host.id);

    assert.equal(convoBefore.n, convoAfter.n, 'Stranger decline on public event should NOT create a notification');
  });

  test('public event, stranger RSVP: accept DOES notify organizer', async () => {
    const invPhone = '+12025551046';
    const { host, eventId } = makeEvent('+12025551047', 'Pub Host Stranger Accept', 'public');
    createUser(invPhone, 'Stranger Accept');
    const cid = makeContact(host.id, invPhone, 'Stranger Accept');
    await multiparty.inviteContacts(eventId, [cid]);

    const msg = await rsvpAndGetConvo(host.id, eventId, invPhone, 'accepted', 'public');
    assert.ok(msg, 'Stranger accepting a public event should notify organizer');
    assert.ok(msg.text.includes('accepted'), 'Message should mention accepted');
  });
});

// ── Event management API ──────────────────────────────────────────────────────

describe('Event management endpoints', () => {
  let orgCookie, orgPhone, orgId, eventId, contactId, invitationId, otherCookie;

  before(async () => {
    orgPhone = '+12025551050';
    const org = createUser(orgPhone, 'Event Manager');
    orgId = org.id;
    orgCookie = await getAuthedCookie(orgPhone);

    const inviteePhone = '+12025551051';
    createUser(inviteePhone, 'Manageable Invitee');
    contactId = db.upsertContact({ invited_by_user_id: orgId, name: 'Manageable Invitee', phone: inviteePhone, tier: 1 });

    eventId = multiparty.createEvent(orgId, {
      title: 'Management Test Event',
      activity_type: 'dinner',
      scheduled_at: Math.floor(Date.now()/1000) + 3600,
    });
    await multiparty.inviteContacts(eventId, [contactId]);

    const inv = db._raw().prepare(`SELECT ei.id FROM event_invitations ei WHERE ei.event_id=?`).get(eventId);
    invitationId = inv?.id;

    // A different user for 403 checks
    const otherPhone = '+12025551052';
    createUser(otherPhone, 'Other Person');
    otherCookie = await getAuthedCookie(otherPhone);
  });

  describe('GET /api/events/:id/manage', () => {
    test('organizer sees event + invitees', async () => {
      const res = await request.get(`/api/events/${eventId}/manage`).set('Cookie', orgCookie);
      assert.equal(res.status, 200);
      assert.ok(res.body.event, 'Should return event');
      assert.ok(Array.isArray(res.body.invitees), 'Should return invitees array');
      assert.equal(res.body.invitees.length, 1);
    });

    test('non-owner → 403', async () => {
      const res = await request.get(`/api/events/${eventId}/manage`).set('Cookie', otherCookie);
      assert.equal(res.status, 403);
    });
  });

  describe('PATCH /api/events/:id', () => {
    test('organizer can make event public', async () => {
      const res = await request
        .patch(`/api/events/${eventId}`)
        .set('Cookie', orgCookie)
        .send({ event_type: 'public' });
      assert.equal(res.status, 200);

      const ev = db._raw().prepare('SELECT event_type FROM social_events WHERE id=?').get(eventId);
      assert.equal(ev.event_type, 'public');
    });

    test('organizer can revert to private', async () => {
      const res = await request
        .patch(`/api/events/${eventId}`)
        .set('Cookie', orgCookie)
        .send({ event_type: 'private' });
      assert.equal(res.status, 200);

      const ev = db._raw().prepare('SELECT event_type FROM social_events WHERE id=?').get(eventId);
      assert.equal(ev.event_type, 'private');
    });

    test('non-owner → 403', async () => {
      const res = await request
        .patch(`/api/events/${eventId}`)
        .set('Cookie', otherCookie)
        .send({ event_type: 'public' });
      assert.equal(res.status, 403);
    });

    test('empty body → 400', async () => {
      const res = await request
        .patch(`/api/events/${eventId}`)
        .set('Cookie', orgCookie)
        .send({});
      assert.equal(res.status, 400);
    });
  });

  describe('DELETE /api/events/:id/invite/:invitationId', () => {
    test('organizer can remove invitee', async () => {
      const res = await request
        .delete(`/api/events/${eventId}/invite/${invitationId}`)
        .set('Cookie', orgCookie);
      assert.equal(res.status, 200);

      const inv = db._raw().prepare('SELECT id FROM event_invitations WHERE id=?').get(invitationId);
      assert.equal(inv, undefined, 'Invitation should be deleted');
    });

    test('non-owner → 403', async () => {
      // Create a fresh invite to test against
      const newEventId = multiparty.createEvent(orgId, { title: 'Del Auth Test', activity_type: 'lunch', scheduled_at: Math.floor(Date.now()/1000)+3600 });
      await multiparty.inviteContacts(newEventId, [contactId]);
      const inv2 = db._raw().prepare('SELECT ei.id FROM event_invitations ei WHERE ei.event_id=?').get(newEventId);

      const res = await request
        .delete(`/api/events/${newEventId}/invite/${inv2.id}`)
        .set('Cookie', otherCookie);
      assert.equal(res.status, 403);
    });
  });
});

// ── Public RSVP ──────────────────────────────────────────────────────────────

describe('POST /api/events/:id/public-rsvp', () => {
  let publicEventId, privateEventId, orgId;

  before(() => {
    const org = createUser('+12025551060', 'Public Event Org');
    orgId = org.id;
    publicEventId  = multiparty.createEvent(orgId, { title: 'Public Party', activity_type: 'party', scheduled_at: Math.floor(Date.now()/1000)+3600, event_type: 'public' });
    privateEventId = multiparty.createEvent(orgId, { title: 'Private Party', activity_type: 'party', scheduled_at: Math.floor(Date.now()/1000)+3600, event_type: 'private' });
  });

  test('stranger can RSVP yes to a public event', async () => {
    const res = await request
      .post(`/api/events/${publicEventId}/public-rsvp`)
      .send({ name: 'Jane Stranger', phone: '+12025551099', status: 'accepted' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'accepted');
  });

  test('stranger can RSVP no to a public event', async () => {
    const res = await request
      .post(`/api/events/${publicEventId}/public-rsvp`)
      .send({ name: 'Bob Stranger', status: 'declined' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'declined');
  });

  test('public RSVP accepted → organizer gets notification in conversation', () => {
    multiparty.publicRsvp(publicEventId, { name: 'Notif Guest', phone: '+12025551098', status: 'accepted' });
    const msg = db._raw().prepare(`SELECT * FROM conversation_history WHERE user_id=? ORDER BY created_at DESC LIMIT 1`).get(orgId);
    assert.ok(msg?.text.includes('attending') || msg?.text.includes('accepted'), 'Organizer should be notified of public acceptance');
  });

  test('public RSVP declined → organizer gets NO notification', () => {
    const convoBefore = db._raw().prepare(`SELECT COUNT(*) as n FROM conversation_history WHERE user_id=?`).get(orgId).n;
    multiparty.publicRsvp(publicEventId, { name: 'Silent Decliner', phone: '+12025551097', status: 'declined' });
    const convoAfter = db._raw().prepare(`SELECT COUNT(*) as n FROM conversation_history WHERE user_id=?`).get(orgId).n;
    assert.equal(convoBefore, convoAfter, 'Public decline should not notify organizer');
  });

  test('public-rsvp on a private event → 404', async () => {
    const res = await request
      .post(`/api/events/${privateEventId}/public-rsvp`)
      .send({ name: 'Sneak', status: 'accepted' });
    assert.equal(res.status, 404);
  });

  test('invalid status → 400', async () => {
    const res = await request
      .post(`/api/events/${publicEventId}/public-rsvp`)
      .send({ name: 'Bad Status', status: 'maybe' });
    assert.equal(res.status, 400);
  });
});

// ── Contact nicknames ─────────────────────────────────────────────────────────

describe('PATCH /api/contacts/:id/nickname', () => {
  let cookie, userId, contactId;

  before(async () => {
    const phone = '+12025551070';
    const user  = createUser(phone, 'Nick Tester');
    userId = user.id;
    cookie = await getAuthedCookie(phone);
    contactId = db.upsertContact({ invited_by_user_id: userId, name: 'Original Name', phone: '+12025551071', tier: 0 });
  });

  test('can set a nickname on a contact', async () => {
    const res = await request
      .patch(`/api/contacts/${contactId}/nickname`)
      .set('Cookie', cookie)
      .send({ nickname: 'Nickname!' });
    assert.equal(res.status, 200);

    const c = db._raw().prepare('SELECT nickname FROM contacts WHERE id=?').get(contactId);
    assert.equal(c.nickname, 'Nickname!');
  });

  test('can clear a nickname (null/empty)', async () => {
    const res = await request
      .patch(`/api/contacts/${contactId}/nickname`)
      .set('Cookie', cookie)
      .send({ nickname: '' });
    assert.equal(res.status, 200);

    const c = db._raw().prepare('SELECT nickname FROM contacts WHERE id=?').get(contactId);
    assert.ok(!c.nickname, 'Nickname should be cleared');
  });

  test('cannot set nickname on another user\'s contact → 404', async () => {
    const otherPhone = '+12025551072';
    const other = createUser(otherPhone, 'Other Nick');
    const otherCookie = await getAuthedCookie(otherPhone);

    const res = await request
      .patch(`/api/contacts/${contactId}/nickname`)
      .set('Cookie', otherCookie)
      .send({ nickname: 'Hacked' });
    assert.equal(res.status, 404);
  });
});

// ── Profile name update ───────────────────────────────────────────────────────

describe('PATCH /api/user/me', () => {
  let cookie;

  before(async () => {
    const phone = '+12025551080';
    createUser(phone, 'Profile Tester');
    cookie = await getAuthedCookie(phone);
  });

  test('can update display name', async () => {
    const res = await request
      .patch('/api/user/me')
      .set('Cookie', cookie)
      .send({ name: 'New Name' });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'New Name');
  });

  test('can update nickname and also_known_as', async () => {
    const res = await request
      .patch('/api/user/me')
      .set('Cookie', cookie)
      .send({ name: 'New Name', nickname: 'Nicky', also_known_as: 'OldName, AltName' });
    assert.equal(res.status, 200);
    assert.equal(res.body.nickname, 'Nicky');
    assert.equal(res.body.also_known_as, 'OldName, AltName');
  });

  test('blank name → 400', async () => {
    const res = await request
      .patch('/api/user/me')
      .set('Cookie', cookie)
      .send({ name: '   ' });
    assert.equal(res.status, 400);
  });

  test('missing name → 400', async () => {
    const res = await request
      .patch('/api/user/me')
      .set('Cookie', cookie)
      .send({ nickname: 'only nick' });
    assert.equal(res.status, 400);
  });
});

// ── Push subscription ─────────────────────────────────────────────────────────

describe('Push subscription endpoints', () => {
  let cookie;

  before(async () => {
    const phone = '+12025551090';
    createUser(phone, 'Push Tester');
    cookie = await getAuthedCookie(phone);
  });

  test('GET /api/push/vapid-key → 200 with publicKey field', async () => {
    const res = await request.get('/api/push/vapid-key');
    assert.equal(res.status, 200);
    assert.ok('publicKey' in res.body, 'Should have publicKey field (may be null if not configured)');
  });

  test('POST /api/push/subscribe with valid subscription → 200', async () => {
    const sub = {
      endpoint: 'https://fcm.googleapis.com/test-endpoint-' + Date.now(),
      keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtZ5MpQ1tjDmQ4s', auth: 'tBHItJI5svbpez7KI4CCXg==' },
    };
    const res = await request.post('/api/push/subscribe').set('Cookie', cookie).send(sub);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  test('POST /api/push/subscribe without auth → 401', async () => {
    const sub = {
      endpoint: 'https://fcm.googleapis.com/test-endpoint-unauthed',
      keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtZ5MpQ1tjDmQ4s', auth: 'tBHItJI5svbpez7KI4CCXg==' },
    };
    const res = await request.post('/api/push/subscribe').send(sub);
    assert.equal(res.status, 401);
  });

  test('POST /api/push/subscribe missing fields → 400', async () => {
    const res = await request
      .post('/api/push/subscribe')
      .set('Cookie', cookie)
      .send({ endpoint: 'https://test.com' }); // missing keys
    assert.equal(res.status, 400);
  });
});

// ── Contact Groups API ────────────────────────────────────────────────────────
describe('Contact Groups API', () => {
  let cookie, userId;
  before(async () => {
    cookie = await getAuthedCookie('+15559990101');
    userId = db.getUserByPhone('+15559990101').id;
    // Create a test contact owned by this user
    db._raw().prepare(`INSERT OR IGNORE INTO contacts (id, invited_by_user_id, name, phone, tier)
      VALUES ('grp-test-contact-id', ?, 'Group Test Contact', '+15559990202', 1)`).run(userId);
  });

  test('GET /api/contacts/groups returns empty array when no groups', async () => {
    const res = await request.get('/api/contacts/groups').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.groups));
  });

  test('GET /api/contacts/groups without auth → 401', async () => {
    const res = await request.get('/api/contacts/groups');
    assert.equal(res.status, 401);
  });

  test('GET /api/contacts/groups returns groups with members', async () => {
    const groupId = db.upsertContactGroup(userId, 'Test Circle', '🎯');
    db.addContactToGroup(groupId, 'grp-test-contact-id');

    const res = await request.get('/api/contacts/groups').set('Cookie', cookie);
    assert.equal(res.status, 200);
    const group = res.body.groups.find(g => g.name === 'Test Circle');
    assert.ok(group, 'group should exist');
    assert.equal(group.emoji, '🎯');
    assert.ok(Array.isArray(group.members));
    assert.equal(group.members.length, 1);

    db.deleteContactGroup(groupId, userId);
  });

  test('DELETE /api/contacts/groups/:id deletes the group', async () => {
    const groupId = db.upsertContactGroup(userId, 'Temp Group', '🗑');
    const res = await request
      .delete(`/api/contacts/groups/${groupId}`)
      .set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    // Should be gone
    const groups = db.getContactGroups(userId);
    assert.ok(!groups.find(g => g.id === groupId));
  });

  test('DELETE /api/contacts/groups/:id without auth → 401', async () => {
    const groupId = db.upsertContactGroup(userId, 'Auth Test Group', null);
    const res = await request.delete(`/api/contacts/groups/${groupId}`);
    assert.equal(res.status, 401);
    db.deleteContactGroup(groupId, userId);
  });

  test('DELETE /api/contacts/groups/:groupId/members/:contactId removes member', async () => {
    const groupId = db.upsertContactGroup(userId, 'Member Test', '👋');
    const contactId = 'grp-test-contact-id';
    db.addContactToGroup(groupId, contactId);

    const res = await request
      .delete(`/api/contacts/groups/${groupId}/members/${contactId}`)
      .set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const groups = db.getContactGroups(userId);
    const group = groups.find(g => g.id === groupId);
    assert.equal(group.members.length, 0);

    db.deleteContactGroup(groupId, userId);
  });

  test('DELETE .../members/:contactId for group not owned → 404', async () => {
    // Create a second user whose group we try to access
    const otherId = require('crypto').randomUUID();
    db.createUser({ id: otherId, phone: '+15550009999', name: 'Other User' });
    const otherGroupId = db.upsertContactGroup(otherId, 'Other Group', null);

    const res = await request
      .delete(`/api/contacts/groups/${otherGroupId}/members/fake-contact-id`)
      .set('Cookie', cookie);
    assert.equal(res.status, 404);

    db.deleteContactGroup(otherGroupId, otherId);
  });
});

// ── Invitation dismiss ────────────────────────────────────────────────────────
describe('Invitation dismiss', () => {
  let hostCookie, guestCookie, guestPhone, eventId, invitationId;

  before(async () => {
    hostCookie  = await getAuthedCookie('+15559990001');
    guestPhone  = '+15559990002';
    guestCookie = await getAuthedCookie(guestPhone);

    // Host creates event
    const hostUser = db.getUser(db.getUserByPhone('+15559990001')?.id || '');
    const hostId   = db.getUserByPhone('+15559990001')?.id;
    // Add guest as a contact of host
    const contactId = db.upsertContact({ invited_by_user_id: hostId, name: 'Guest', phone: guestPhone });

    // Create event + invite (direct /api/events endpoint, not agent tool)
    const hostId2 = db.getUserByPhone('+15559990001')?.id;
    const eRes = await request.post('/api/events')
      .send({ userId: hostId2, title: 'Dismiss Test Event',
              scheduled_at: Math.floor(Date.now()/1000) + 7200,
              activity_type: 'hangout', contactIds: [contactId] });
    eventId = eRes.body?.eventId;

    // Find invitation via the invited events API (proves it appears before dismiss)
    const invRes = await request.get('/api/events/invited/me').set('Cookie', guestCookie);
    const inv = invRes.body?.events?.find(e => e.title === 'Dismiss Test Event');
    invitationId = inv?.invitation_id;
  });

  test('invited event appears in GET /api/events/invited before dismiss', async () => {
    const res = await request.get('/api/events/invited/me').set('Cookie', guestCookie);
    assert.equal(res.status, 200);
    assert.ok(res.body.events.some(e => e.invitation_id === invitationId), 'event should be visible before dismiss');
  });

  test('POST /api/events/invitations/:id/dismiss removes it from invited list', async () => {
    const res = await request.post(`/api/events/invitations/${invitationId}/dismiss`).set('Cookie', guestCookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.dismissed, true);

    const check = await request.get('/api/events/invited/me').set('Cookie', guestCookie);
    assert.ok(!check.body.events.some(e => e.invitation_id === invitationId), 'dismissed event must not appear in invited list');
  });

  test('POST .../dismiss without auth → 401', async () => {
    const res = await request.post(`/api/events/invitations/${invitationId}/dismiss`);
    assert.equal(res.status, 401);
  });

  test('POST .../dismiss for another user\'s invitation → 403', async () => {
    // Create another guest
    const otherCookie = await getAuthedCookie('+15559990003');
    const res = await request.post(`/api/events/invitations/${invitationId}/dismiss`).set('Cookie', otherCookie);
    assert.equal(res.status, 403);
  });
});
