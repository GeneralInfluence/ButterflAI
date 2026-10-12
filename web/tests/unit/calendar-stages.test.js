/**
 * calendar-stages.test.js — plans on the calendar by stage (events.html).
 * Owner, 2026-10-12: every plan belongs on the calendar; stages color-coded; tentative
 * plans striped on their proposed dates. Runs the page's own functions.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/events.html'), 'utf8');
const grab = (name) => html.match(new RegExp(`  function ${name}\\(e\\) \\{[\\s\\S]*?\\n  \\}\\n`))[0];
const { stageOf, daysOf } = new Function(`${grab('proposalsOf')}${grab('stageOf')}${grab('daysOf')} return { stageOf, daysOf };`)();

const now = Date.now() / 1000;
const day = (offset) => { const d = new Date(Date.now() + offset * 86400e3); return d.toISOString().slice(0, 10); };

test('stages', () => {
  assert.equal(stageOf({ date_tbd: 1, tentative: 1 }), 'idea');
  assert.equal(stageOf({ date_tbd: 1, tentative: 1, proposed_dates: JSON.stringify([{ from: day(10), to: day(12) }]) }), 'proposed');
  assert.equal(stageOf({ tentative: 1, scheduled_at: now + 86400 * 5 }), 'proposed');
  assert.equal(stageOf({ tentative: 0, scheduled_at: now + 86400 * 5 }), 'confirmed');
  assert.equal(stageOf({ _isInvite: true, rsvp_status: 'invited', tentative: 0, scheduled_at: now + 86400 }), 'invited');
  assert.equal(stageOf({ tentative: 0, scheduled_at: now - 86400 * 3 }), 'past');
  assert.equal(stageOf({ date_tbd: 1, proposed_dates: JSON.stringify([{ from: day(-10), to: day(-8) }]) }), 'past');
});

test('days covered: each proposed range; a multi-day plan spans its days; undated covers none', () => {
  const props = daysOf({ date_tbd: 1, proposed_dates: JSON.stringify([{ from: '2026-10-23', to: '2026-10-25' }, { from: '2026-11-06', to: '2026-11-06' }]) });
  assert.deepEqual(props, ['2026-9-23', '2026-9-24', '2026-9-25', '2026-10-6']);
  const start = new Date(2026, 9, 23, 15, 0).getTime() / 1000;
  assert.deepEqual(daysOf({ scheduled_at: start, duration_mins: 2880 }), ['2026-9-23', '2026-9-24', '2026-9-25']);
  assert.deepEqual(daysOf({ scheduled_at: start, duration_mins: 120 }), ['2026-9-23']);
  assert.deepEqual(daysOf({ date_tbd: 1 }), []);
});

test('page: legend, undated strip, striped proposed chips, pending invites on the calendar', () => {
  assert.ok(html.includes('<div class="cal-legend">') && html.includes('id="cal-undated"'));
  assert.match(html, /\.stage-proposed \{ background: repeating-linear-gradient/);
  assert.ok(html.includes("['accepted', 'invited'].includes(e.rsvp_status)"));
});
