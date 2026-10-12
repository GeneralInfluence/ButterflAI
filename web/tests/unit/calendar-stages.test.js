/**
 * calendar-stages.test.js — plans on the calendar by stage.
 * Owner, 2026-10-12: every plan on the calendar; stages color-coded; tentative plans on
 * their proposed dates. Since the "one plan object" change the stage and the days a plan
 * covers are computed once on the server (plan.js), so these tests run against it (they
 * used to run the page's own client-side functions, which were removed).
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'calendar-stages-test';
delete process.env.ANTHROPIC_API_KEY;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const db = require('../../db');
const multiparty = require('../../multiparty');
const plan = require('../../plan');

let n = 0;
function mkUser(name) {
  const phone = `+1202556${String(3000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
const now = Math.floor(Date.now() / 1000);
const day = (offset) => new Date(Date.now() + offset * 86400e3).toISOString().slice(0, 10);
const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/events.html'), 'utf8');

test('stages', async () => {
  const host = mkUser('Host Stage'); const guest = mkUser('Guest Stage');
  const mk = (o) => multiparty.createEvent(host.id, { title: 'P' + Math.random(), activity_type: 'x', ...o });
  const stage = (id, who = host) => plan.planFor(id, who.id).stage;
  assert.equal(stage(mk({ date_tbd: true })), 'idea');
  assert.equal(stage(mk({ date_tbd: true, proposed_dates: [{ from: day(10), to: day(12) }] })), 'proposed');
  assert.equal(stage(mk({ tentative: true, scheduled_at: now + 86400 * 5 })), 'proposed');
  assert.equal(stage(mk({ scheduled_at: now + 86400 * 5 })), 'confirmed');
  assert.equal(stage(mk({ scheduled_at: now - 86400 * 3 })), 'past');
  assert.equal(stage(mk({ date_tbd: true, proposed_dates: [{ from: day(-10), to: day(-8) }] })), 'past');
  const invited = mk({ scheduled_at: now + 86400 * 2 });
  const c = db.upsertContact({ invited_by_user_id: host.id, name: guest.name, phone: guest.phone, tier: 1 });
  await multiparty.inviteContacts(invited, [c]);
  assert.equal(stage(invited, guest), 'invited', 'waiting on the guest\'s answer');
  assert.equal(plan.planFor(mk({ scheduled_at: now + 86400 }), guest.id), null, 'not in it → not visible');
});

test('days covered: each proposed range; a multi-day plan spans its days; undated covers none', () => {
  const host = mkUser('Host Days');
  const days = (o) => plan.planFor(multiparty.createEvent(host.id, { title: 'D' + Math.random(), activity_type: 'x', ...o }), host.id).days;
  assert.deepEqual(days({ date_tbd: true, proposed_dates: [{ from: '2026-10-23', to: '2026-10-25' }, { from: '2026-11-06', to: '2026-11-06' }] }),
    ['2026-10-23', '2026-10-24', '2026-10-25', '2026-11-06']);
  const start = Date.parse('2026-10-23T15:00:00-07:00') / 1000;
  assert.deepEqual(days({ scheduled_at: start, duration_mins: 2880 }), ['2026-10-23', '2026-10-24', '2026-10-25']);
  assert.deepEqual(days({ scheduled_at: start, duration_mins: 120 }), ['2026-10-23']);
  assert.deepEqual(days({ date_tbd: true }), []);
});

test('page: reads plans from the server; legend, undated strip, striped proposed chips; long names can\'t widen the grid', () => {
  assert.ok(html.includes("fetch('/api/plans')") && html.includes('p.days') && html.includes('chip.className = `cal-chip stage-${e.stage}`'));
  assert.ok(!html.includes('function stageOf('), 'no second copy of the stage logic in the page');
  assert.ok(html.includes('<div class="cal-legend">') && html.includes('id="cal-undated"'));
  assert.match(html, /\.stage-proposed \{ background: repeating-linear-gradient/);
  assert.match(html, /\.cal-days \{[\s\S]*?grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
});
