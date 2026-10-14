/**
 * plan-object.test.js — the plan as one object (plan.js), and cleaning up what the old
 * spaghetti left behind (owner, 2026-10-12: "operate on single objects").
 * Regressions: "Melanie's Birthday Weekend" and "Liam's Birthday Party" were created a
 * second time (duplicate invites to the whole group, originals left undated); "Waiting on
 * Allie, Melanie…" stayed on Home from a question thread tied to no plan.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'plan-object-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const retro = require('../../retro');
const home = require('../../home');
const multiparty = require('../../multiparty');

let n = 0;
function mkUser(name, old = false) {
  const phone = `+1202556${String(4000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', ?)`)
    .run(uuidv4(), name, phone, old ? Date.UTC(2026, 8, 1) / 1000 : Math.floor(Date.now() / 1000));
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
const onlyTasks = (u, keep) => { for (const t of retro.TASKS) if (!keep.includes(t.id)) db._raw().prepare('INSERT OR IGNORE INTO retro_runs (task_id, user_id, outcome) VALUES (?, ?, ?)').run(t.id, u.id, 'skip'); };

describe('one plan per name', () => {
  test("creating a plan you already have is refused and points at it (no duplicate invites)", async () => {
    const sean = mkUser('Sean Dup'); const allie = mkUser('Allie Dup');
    const first = await agent.executeTool('create_social_event', { title: "Melanie's Birthday Weekend", activity_type: 'trip', contact_ids: [knows(sean, allie)] }, sean.id, sean.phone);
    const again = await agent.executeTool('create_social_event', { title: "melanie's birthday  weekend", activity_type: 'trip',
      proposed_dates: [{ from: '2026-10-23', to: '2026-10-24' }], contact_ids: [knows(sean, allie)] }, sean.id, sean.phone);
    assert.equal(again.error, 'PLAN_EXISTS');
    assert.equal(again.eventId, first.eventId);
    assert.equal(db._raw().prepare("SELECT count(*) c FROM social_events WHERE host_user_id = ?").get(sean.id).c, 1);
    assert.equal(db._raw().prepare("SELECT count(*) c FROM event_invitations").get().c >= 1, true);
  });

  test('retro: duplicates already created are folded into the original (dates, place, people kept)', async () => {
    const sean = mkUser('Sean Old Dup', true); const mel = mkUser('Mel Old Dup');
    const orig = multiparty.createEvent(sean.id, { title: "Melanie's Birthday Weekend", activity_type: 'trip', date_tbd: true });
    db._raw().prepare(`INSERT INTO conversation_history (id, user_id, role, text, event_id) VALUES (?, ?, 'user', 'original chat', ?)`).run(uuidv4(), sean.id, orig);
    // Sean's duplicate was made days later, so its placeholder date differed.
    db._raw().prepare('UPDATE social_events SET scheduled_at = scheduled_at - 3 * 86400 WHERE id = ?').run(orig);
    const dup = multiparty.createEvent(sean.id, { title: "Melanie's Birthday Weekend", activity_type: 'trip', venue_name: 'Carson City Hot Springs',
      proposed_dates: [{ from: '2026-10-23', to: '2026-10-24' }] });
    await multiparty.inviteContacts(dup, [knows(sean, mel)]);
    onlyTasks(sean, ['2026-10-12-merge-duplicate-plans']);
    await retro.tick();
    const kept = db._raw().prepare('SELECT * FROM social_events WHERE id = ?').get(orig);
    assert.equal(kept.venue_name, 'Carson City Hot Springs');
    assert.deepEqual(JSON.parse(kept.proposed_dates), [{ from: '2026-10-23', to: '2026-10-24' }]);
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(dup).status, 'cancelled');
    assert.equal(db._raw().prepare('SELECT count(*) c FROM event_invitations WHERE event_id = ?').get(orig).c, 1, 'Mel moved over');
    assert.ok(home.feedFor(mel.id).items.filter((i) => i.title === "Melanie's Birthday Weekend").length === 1, 'one card for Mel');
  });
});

describe('questions belong to plans', () => {
  test('a plan card shows who was asked and hasn\'t answered; no free-floating "waiting" items', async () => {
    const sean = mkUser('Sean Ask'); const allie = mkUser('Allie Ask'); knows(allie, sean);
    const ac = knows(sean, allie);
    const ev = (await agent.executeTool('create_social_event', { title: 'Grover', activity_type: 'camping', contact_ids: [ac] }, sean.id, sean.phone)).eventId;
    await agent.executeTool('message_agent', { contact_id: ac, topic: 'coordination', event_id: ev, message: 'Heater OK?' }, sean.id, sean.phone);
    const card = home.feedFor(sean.id).items.find((i) => i.event_id === ev);
    assert.deepEqual(card.asked, ['Allie']);
    assert.ok(!home.feedFor(sean.id).items.some((i) => i.type === 'waiting'));
  });

  test('retro: old questions tied to no plan are closed', async () => {
    const sean = mkUser('Sean Orphan', true); const mel = mkUser('Mel Orphan');
    db._raw().prepare(`INSERT INTO agent_messages (id, from_user, to_user, thread_id, kind, topic, body, created_at) VALUES (?, ?, ?, 'grover-trip-oct23-25', 'query', 'coordination', 'old', ?)`)
      .run(uuidv4(), sean.id, mel.id, Math.floor(Date.now() / 1000) - 5 * 86400);
    onlyTasks(sean, ['2026-10-12-close-orphan-questions']);
    await retro.tick();
    assert.equal(db._raw().prepare("SELECT processed FROM agent_messages WHERE from_user = ?").get(sean.id).processed, 1);
  });
});

describe('/api/plans', () => {
  test('your plans, one object each; someone else\'s are not included', async () => {
    const a = mkUser('Api A'); const b = mkUser('Api B');
    multiparty.createEvent(a.id, { title: 'Mine', activity_type: 'x', date_tbd: true });
    multiparty.createEvent(b.id, { title: 'Theirs', activity_type: 'x', date_tbd: true });
    const r = await request.get('/api/plans').set('Cookie', await cookieFor(a));
    assert.deepEqual(r.body.plans.map((p) => [p.title, p.stage, p.role, p.dates.label]), [['Mine', 'idea', 'host', 'Date TBD']]);
    assert.equal((await request.get('/api/plans')).status, 401);
  });
});
