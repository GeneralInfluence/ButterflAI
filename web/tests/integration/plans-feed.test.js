/**
 * plans-feed.test.js — shared plans, quiet interest, and the Home feed (MEMORY.md §11).
 *
 * Owner decisions 2026-10-08: people share plans when they want to (expiry from their
 * wording); "what're my boys up to" answers only from what friends shared and never
 * pings anyone — it leaves a quiet signal in their feed. Home feed replaces overdue
 * check-ins / coming up / invite a friend.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'plans-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
const texts = [];
sms._setClient({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' }; } } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const plans = require('../../plans');
const avoid = require('../../avoid');
const multiparty = require('../../multiparty');
const { resolveUntil } = require('../../datetime');

let n = 0;
function mkUser(name) {
  const phone = `+1202555${String(7000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/New_York')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const counts = () => ({
  inbound: db._raw().prepare('SELECT count(*) c FROM inbound_messages').get().c,
  a2a: db._raw().prepare('SELECT count(*) c FROM agent_messages').get().c,
  texts: texts.length,
});

describe('resolveUntil — expiry from the user\'s wording', () => {
  const thuEvening = new Date('2026-10-08T23:00:00Z'); // Thu Oct 8, 7pm ET
  const label = (p) => resolveUntil(p, 'America/New_York', thuEvening).label;
  test('common phrases', () => {
    assert.equal(label('tonight'), 'Fri, Oct 9, 4:00 AM');
    assert.equal(label('this weekend'), 'Mon, Oct 12, 4:00 AM');
    assert.equal(label('all week'), 'Mon, Oct 12, 4:00 AM');
    assert.equal(label('until saturday'), 'Sun, Oct 11, 4:00 AM');
    assert.equal(label('next week'), 'Mon, Oct 19, 4:00 AM');
    assert.equal(label('for 3 days'), 'Sun, Oct 11, 7:00 PM');
  });
  test('unrecognized → end of tonight; long spans capped at 30 days', () => {
    assert.equal(label('whenever lol'), 'Fri, Oct 9, 4:00 AM');
    const capped = resolveUntil('for 12 weeks', 'America/New_York', thuEvening).ts;
    assert.ok(capped - thuEvening.getTime() / 1000 <= 30 * 86400 + 1);
  });
});

describe('sharing + visibility', () => {
  let dave, sean, stranger, avoided, boy;
  before(() => {
    dave = mkUser('Dave'); sean = mkUser('Sean'); stranger = mkUser('Stranger'); avoided = mkUser('Avoided'); boy = mkUser('Boy');
    knows(dave, sean); knows(dave, avoided); knows(dave, boy);
    avoid.addAvoid(dave.id, db._raw().prepare('SELECT id FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(dave.id, avoided.phone).id);
  });

  test("dave's plan: his contacts see it; strangers and people he avoids don't", () => {
    const r = plans.sharePlan(dave.id, { text: "At Sully's from 9 — come by", until: 'tonight' });
    assert.equal(r.ok, true);
    const seenBy = (u) => plans.plansVisibleTo(u).some((p) => p.text.includes('Sully'));
    assert.equal(seenBy(sean), true);
    assert.equal(seenBy(stranger), false, 'not his contact');
    assert.equal(seenBy(avoided), false, 'on his avoid list');
  });

  test('a group-scoped plan is visible only to that group', () => {
    const gid = db.upsertContactGroup(dave.id, 'The Boys');
    db.addContactToGroup(gid, db._raw().prepare('SELECT id FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(dave.id, boy.phone).id);
    const r = plans.sharePlan(dave.id, { text: 'Poker at mine', until: 'saturday', group: 'my boys' });
    assert.equal(r.ok, true, '"my boys" matches "The Boys"');
    assert.ok(plans.plansVisibleTo(boy).some((p) => p.text === 'Poker at mine'));
    assert.ok(!plans.plansVisibleTo(sean).some((p) => p.text === 'Poker at mine'));
  });

  test('unknown group → clear error listing groups', () => {
    assert.equal(plans.sharePlan(dave.id, { text: 'x', group: 'cousins' }).error, 'GROUP_NOT_FOUND');
  });
});

describe('"what\'re my boys up to tonight" — answers from shared plans, pings nobody', () => {
  let sean, mike, tom, quiet, offApp, hater;
  before(() => {
    sean = mkUser('Sean'); mike = mkUser('Mike'); tom = mkUser('Tom'); quiet = mkUser('Quiet'); hater = mkUser('Hater');
    const gid = db.upsertContactGroup(sean.id, 'boys');
    for (const u of [mike, tom, quiet, hater]) db.addContactToGroup(gid, knows(sean, u));
    offApp = db.upsertContact({ invited_by_user_id: sean.id, name: 'Off App', phone: '+12025557999', tier: 0 });
    db.addContactToGroup(gid, offApp);
    for (const u of [mike, tom, quiet, hater]) knows(u, sean);         // they have Sean too
    plans.sharePlan(mike.id, { text: 'Free after 8', until: 'tonight' });
    plans.sharePlan(tom.id, { text: "At Sully's from 9", until: 'tonight' });
    avoid.addAvoid(hater.id, db._raw().prepare('SELECT id FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(hater.id, sean.phone).id);
  });

  test('reports shared plans, who shared nothing, who is not on ButterflAI', () => {
    const before = counts();
    const r = plans.checkFriendsPlans(sean.id, { group: 'my boys', when: 'tonight' });
    const byName = Object.fromEntries(r.friends.map((f) => [f.name, f.plans]));
    assert.deepEqual(byName.Mike, ['Free after 8']);
    assert.deepEqual(byName.Tom, ["At Sully's from 9"]);
    assert.deepEqual(byName.Quiet, []);
    assert.deepEqual(r.not_on_butterflai, ['Off App']);
    assert.deepEqual(counts(), before, 'no texts, no queued messages, no agent messages — nobody pinged');
  });

  test('leaves a quiet interest signal — except for someone who avoids the asker', () => {
    const quietFeed = plans.feedFor(quiet.id).items;
    assert.ok(quietFeed.some((i) => i.type === 'interest' && i.who === 'Sean' && i.about === 'tonight'));
    assert.ok(!plans.feedFor(hater.id).items.some((i) => i.type === 'interest'), 'no signal to someone who avoids Sean');
    // Hater's own plans also stay hidden from Sean (he avoids Sean)
  });

  test('the agent tool works end to end', async () => {
    const r = await agent.executeTool('check_friends_plans', { group: 'boys', when: 'tonight' }, sean.id, sean.phone);
    assert.ok(r.friends.length >= 3);
    assert.match(r.quiet_signal, /Nobody was pinged/);
  });
});

describe('Home feed ranking', () => {
  test('invites waiting on you → events soon → friends\' plans → interest → later events', async () => {
    const me = mkUser('Me'); const host = mkUser('Host'); const pal = mkUser('Pal');
    knows(pal, me); knows(me, pal);
    const t = Math.floor(Date.now() / 1000);
    // later event I host (5 days out)
    multiparty.createEvent(me.id, { title: 'Later Dinner', activity_type: 'dinner', scheduled_at: t + 5 * 86400 });
    // event soon I host (3 hours out)
    multiparty.createEvent(me.id, { title: 'Soon Drinks', activity_type: 'drinks', scheduled_at: t + 3 * 3600 });
    // invite waiting on me
    const ev = multiparty.createEvent(host.id, { title: 'Host Party', activity_type: 'party', scheduled_at: t + 2 * 86400 });
    await multiparty.inviteContacts(ev, [knows(host, me)]);
    plans.sharePlan(pal.id, { text: 'Bowling tonight', until: 'tonight' });
    plans.checkFriendsPlans(pal.id, { when: 'tonight' });          // pal is up for something → signal to me
    plans.sharePlan(me.id, { text: 'Free tonight', until: 'tonight' });

    const { items, my_plans } = plans.feedFor(me.id);
    assert.deepEqual(items.map((i) => i.type), ['invite', 'event', 'plan', 'interest', 'event']);
    assert.equal(items[1].title, 'Soon Drinks');
    assert.equal(items[4].title, 'Later Dinner');
    assert.deepEqual(my_plans.map((p) => p.text), ['Free tonight']);
  });
});

describe('retention + API', () => {
  test('expired plans and signals are hard-deleted', () => {
    const u = mkUser('Exp');
    db._raw().prepare(`INSERT INTO shared_plans (id, user_id, text, expires_at) VALUES (?, ?, 'old', ?)`).run(uuidv4(), u.id, Math.floor(Date.now() / 1000) - 10);
    assert.ok(plans.purgeExpired() >= 1);
    assert.equal(db._raw().prepare('SELECT count(*) c FROM shared_plans WHERE user_id = ?').get(u.id).c, 0);
  });

  test('feed + quick share + remove are owner-only and need login', async () => {
    const a = mkUser('ApiA'); const b = mkUser('ApiB');
    const cookie = async (u) => {
      await request.post('/auth/otp/send').send({ phone: u.phone });
      const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
      return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
    };
    const ca = await cookie(a); const cb = await cookie(b);
    assert.equal((await request.get('/api/feed')).status, 401);
    const s = await request.post('/api/plans').set('Cookie', ca).send({ text: 'Free tonight', until: 'tonight' });
    assert.equal(s.status, 200);
    const feed = await request.get('/api/feed').set('Cookie', ca);
    assert.deepEqual(feed.body.my_plans.map((p) => p.text), ['Free tonight']);
    await request.delete('/api/plans/' + s.body.plan_id).set('Cookie', cb);   // B can't remove A's
    assert.equal(plans.myPlans(a.id).length, 1);
    await request.delete('/api/plans/' + s.body.plan_id).set('Cookie', ca);
    assert.equal(plans.myPlans(a.id).length, 0);
  });
});
