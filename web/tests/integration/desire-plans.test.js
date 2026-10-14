/**
 * desire-plans.test.js — social desires are plans (owner, 2026-10-13: "make them plans").
 * Event-map contradiction #3: "go out with a friend or two this week" negotiated between
 * agents and ended as "scheduled" with no plan anywhere.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'desire-plans-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

require('../../server');
const db = require('../../db');
const desires = require('../../desires');
const desireplans = require('../../desireplans');
const plan = require('../../plan');

let n = 0;
function mkUser(name) {
  const phone = `+1202552${String(2000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
const social = (over = {}) => ({ type: 'social', horizon: 'one_off', recurrence: 'none', category: 'dining', activityType: 'dinner',
  sizeMin: 1, sizeMax: 2, frequency: 1, priority: 'want', candidateStrategy: 'tier', candidateTierMin: 1,
  windowStart: day(1), windowEnd: day(7), alsoUpdatesPreference: false, ...over });
const plansOf = (u) => plan.plansFor(u.id);

describe('a social desire becomes a plan', () => {
  test('one plan, idea/proposed stage, the desire’s window as proposed dates, named from its kind', async () => {
    const sean = mkUser('Sean Want');
    const r = await desires.storeParsed(sean.id, 'go out to eat with a friend or two this week', [social()]);
    const [p] = plansOf(sean);
    assert.ok(p, 'a plan exists');
    assert.match(p.title, /^Meal out with a friend or two — week of /);
    assert.equal(p.dates.kind, 'proposed');
    assert.deepEqual(p.dates.proposals, [{ from: day(1), to: day(7) }]);
    assert.equal(p.tentative, true);
    assert.match(r.summary, /on your plans as “Meal out with a friend or two/);
    assert.equal(db._raw().prepare('SELECT count(*) c FROM desire_plans').get().c >= 1, true);
  });

  test('"twice" is two plans; people named are invited', async () => {
    const sean = mkUser('Sean Twice'); const allie = mkUser('Allie Twice');
    await desires.storeParsed(sean.id, 'drinks with Allie twice this week', [social({ category: 'drinks', frequency: 2, candidateStrategy: 'specific', sizeMin: 1, sizeMax: 1 })], [knows(sean, allie)]);
    const ps = plansOf(sean);
    assert.equal(ps.length, 2);
    assert.deepEqual(ps.map((p) => p.title.replace(/ — week of .+? \(/, ' (')).sort(), ['Drinks with a friend (1 of 2)', 'Drinks with a friend (2 of 2)']);
    assert.ok(ps.every((p) => p.people.some((x) => x.name === 'Allie')));
  });

  test('solo and protective desires stay holds, not plans', async () => {
    const sean = mkUser('Sean Solo');
    await desires.storeParsed(sean.id, 'work out twice and a chill night', [
      social({ type: 'solo', category: 'active', sizeMin: 0, sizeMax: 0 }), social({ type: 'protective', category: 'chill', sizeMin: 0, sizeMax: 0 })]);
    assert.equal(plansOf(sean).length, 0);
  });

  test('the same desire next week is a different plan, not a duplicate', async () => {
    const sean = mkUser('Sean Weeks');
    await desires.storeParsed(sean.id, 'x', [social()]);
    await desires.storeParsed(sean.id, 'x', [social()]);
    const titles = plansOf(sean).map((p) => p.title);
    assert.equal(titles.length, 2);
    assert.equal(new Set(titles).size, 2);
  });
});

describe('negotiation and deletion act on the plan', () => {
  test('an agreed time sets the plan’s date and invites who agreed', async () => {
    const sean = mkUser('Sean Neg'); const bam = mkUser('Bam Neg');
    db._raw().prepare('UPDATE users SET agent_endpoint = ? WHERE id = ?').run('https://agent/bam', bam.id);
    knows(sean, bam);
    const r = await desires.storeParsed(sean.id, 'x', [social()]);
    const desireId = r.desires[0].id;
    const sessionId = uuidv4();
    const start = Math.floor(Date.now() / 1000) + 3 * 86400;
    db._raw().prepare(`INSERT INTO coordination_sessions (id, desire_id, initiator_user_id, state, round, agreed_slot_start, agreed_slot_duration, expires_at, purge_after)
      VALUES (?, ?, ?, 'scheduled', 3, ?, 90, ?, ?)`).run(sessionId, desireId, sean.id, new Date(start * 1000).toISOString(), new Date((start + 86400) * 1000).toISOString(), new Date((start + 8 * 86400) * 1000).toISOString());
    db._raw().prepare(`INSERT INTO coord_session_peers (id, session_id, peer_agent_id, state) VALUES (?, ?, ?, 'confirmed')`).run(uuidv4(), sessionId, 'https://agent/bam');
    const eventId = await desireplans.scheduled(sessionId);
    const p = plan.planFor(eventId, sean.id);
    assert.equal(p.dates.kind, 'set');
    assert.equal(p.at, start);
    assert.ok(p.people.some((x) => x.name === 'Bam'), 'who agreed is invited');
  });

  test('deleting the desire cancels its plans nobody joined; a joined one stays', async () => {
    const sean = mkUser('Sean Del'); const allie = mkUser('Allie Del');
    const r = await desires.storeParsed(sean.id, 'x', [social({ frequency: 2, candidateStrategy: 'specific' })], [knows(sean, allie)]);
    const [a, b] = plansOf(sean);
    const inv = db._raw().prepare(`SELECT ei.id FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?`).get(a.id, allie.phone).id;
    require('../../planops').respond(inv, 'accepted', { by: 'guest', phone: allie.phone });
    const out = await desires.deleteAllDesires(sean.id, null);
    assert.equal(out.plansCancelled, 1);
    assert.equal(plan.planFor(a.id, sean.id).stage !== 'cancelled', true, 'Allie said yes — kept');
    assert.equal(plan.planFor(b.id, sean.id).stage, 'cancelled');
    assert.ok(r.desires.length);
  });
});

describe('the coordination view', () => {
  test('has the v2 columns (recurring templates, named people) and never raw_text', () => {
    const cols = db._raw().prepare("SELECT name FROM pragma_table_info('coord_desires')").all().map((c) => c.name);
    for (const c of ['horizon', 'recurrence_end', 'candidate_strategy', 'candidate_ids', 'parent_desire_id']) assert.ok(cols.includes(c), c);
    assert.ok(!cols.includes('raw_text'));
  });
  test('a recurring social desire spawns an instance with its own plan', async () => {
    const sean = mkUser('Sean Weekly');
    await desires.storeParsed(sean.id, 'dinner with a friend every week', [social({ horizon: 'recurring', recurrence: 'weekly' })]);
    assert.equal(plansOf(sean).length, 0, 'the template itself is not a plan');
    await require('../../coord-loop')._tickRecurring();
    assert.equal(plansOf(sean).length, 1);
  });
});
