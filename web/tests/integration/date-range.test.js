/**
 * date-range.test.js — 🐛 #25 (Sean, 2026-10-20): "You locked it into just Friday which destroys
 * all the Saturday events." The agent locked in Melanie's weekend with when = "Friday October 23
 * through Saturday October 24"; that was read as Friday, and setting a date dropped the Fri–Sat range.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'date-range-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
require('../../server');
const db = require('../../db');
const planops = require('../../planops');
const plan = require('../../plan');
const datetime = require('../../datetime');

let n = 0;
function mkUser(name) {
  const phone = `+1202538${String(2000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
const now = new Date('2026-10-20T00:03:00Z');

describe('a range in words is a range', () => {
  for (const [said, want] of [['Friday October 23 through Saturday October 24', ['2026-10-23', '2026-10-24']], ['Oct 23-24', ['2026-10-23', '2026-10-24']],
    ['Oct 23 to Oct 25', ['2026-10-23', '2026-10-25']], ['Oct 23 – Oct 24', ['2026-10-23', '2026-10-24']]]) {
    test(`"${said}"`, () => { const r = datetime.resolveRange(said, 'America/Los_Angeles', now); assert.deepEqual([r.from, r.to], want); });
  }
  test('one day is not a range', () => assert.equal(datetime.resolveRange('October 30', 'America/Los_Angeles', now), null));
});

describe('🐛 #25: locking in the weekend keeps Saturday', () => {
  const D = (k) => new Date(Date.now() + k * 86400e3).toISOString().slice(0, 10);
  test('the agent\'s exact call (tentative false, when "… through …") → both days, confirmed', async () => {
    const sean = mkUser('Sean D1');
    const e = (await planops.create(sean.id, { title: 'Weekend', proposed_dates: [{ from: D(4), to: D(5) }] })).eventId;
    const words = `${new Date(D(4) + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })} through ${new Date(D(5) + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })}`;
    const r = planops.update(sean.id, e, { tentative: false, when: words, notes: 'Friday: massages. Saturday: hot springs, dinner.' }, { via: 'agent' });
    assert.equal(r.ok, true, r.message);
    const p = plan.planFor(e, sean.id);
    assert.deepEqual([p.stage, p.dates.kind, p.days], ['confirmed', 'days', [D(4), D(5)]]);
  });
  test('a single date over a multi-day plan is refused unless the range is dropped on purpose', async () => {
    const sean = mkUser('Sean D2');
    const e = (await planops.create(sean.id, { title: 'Weekend 2', proposed_dates: [{ from: D(4), to: D(5) }] })).eventId;
    assert.equal(planops.update(sean.id, e, { when: D(4) }, { via: 'agent' }).error, 'WOULD_DROP_DAYS');
    assert.equal(planops.update(sean.id, e, { when: D(4), proposed_dates: [] }, { via: 'agent' }).ok, true);
    assert.deepEqual(plan.planFor(e, sean.id).days, [D(4)]);
  });
  test('creating a plan with a range in words gives it those days', async () => {
    const sean = mkUser('Sean D3');
    const e = (await planops.create(sean.id, { title: 'Trip', when: 'Oct 23-24' })).eventId;
    assert.equal(plan.planFor(e, sean.id).dates.proposals.length, 1);
  });
  test('retro: Melanie\'s weekend back to Fri–Sat, locked in, notes kept', async () => {
    const sean = mkUser('Sean D4');
    const e = (await planops.create(sean.id, { title: "Melanie's Birthday Weekend", proposed_dates: [{ from: '2026-10-23', to: '2026-10-24' }] })).eventId;
    planops.update(sean.id, e, { when: 'October 23', proposed_dates: [], tentative: false, notes: 'Saturday: hot springs' }, { via: 'app' });   // as the bad change left it
    db.createFeedback({ user_id: sean.id, rating: 'down', user_note: 'You locked it into just Friday which destroys all the Saturday events', context_json: '[]', state_json: '{}' });
    db._raw().prepare("UPDATE feedback SET id = 25 WHERE user_note LIKE 'You locked it into just Friday%'").run();
    const task = require('../../retro').TASKS.find((t) => t.id === '2026-10-20-weekend-keeps-saturday');
    assert.equal(task.run(sean), 'Fri–Sat, locked in');
    const row = db._raw().prepare('SELECT proposed_dates, tentative, notes FROM social_events WHERE id = ?').get(e);
    assert.deepEqual([row.proposed_dates, row.tentative, row.notes], ['[{"from":"2026-10-23","to":"2026-10-24"}]', 0, 'Saturday: hot springs']);
    assert.equal(task.run(sean), 'not as left');
  });
});
