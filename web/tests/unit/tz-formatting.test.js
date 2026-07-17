'use strict';

/**
 * tz-formatting.test.js — durable timezone-correctness guards.
 *
 * These pin that date formatters render in the CALLER's timezone, not the process
 * timezone. The trick: assert a NON-UTC rendering. If the code ignores the timezone
 * argument and falls back to the process zone, the assertion fails even under a UTC
 * runner (GitHub CI) — so these catch regressions that the UTC-only CI would otherwise
 * mask. (See docs/REARCHITECTURE.md Phase 0 tz sweep.)
 *
 * Run: DB_PATH=:memory: JWT_SECRET=test node --test tests/unit/tz-formatting.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';

const { formatEventLabel } = require('../../cadence');
const { computeWindowIntersection } = require('../../coordination');

// An instant that falls on DIFFERENT calendar days in LA vs NY:
//   2026-06-20T05:30:00Z  =  Fri Jun 19, 10:30 PM PDT (America/Los_Angeles, UTC-7)
//                         =  Sat Jun 20, 01:30 AM EDT (America/New_York,   UTC-4)
const SPLIT_INSTANT_S = Math.floor(Date.UTC(2026, 5, 20, 5, 30, 0) / 1000);

describe('formatEventLabel renders in the given timezone', () => {
  const event = { activity_type: 'dinner', scheduled_at: SPLIT_INSTANT_S };

  test('America/Los_Angeles → Friday Jun 19', () => {
    const label = formatEventLabel(event, 'America/Los_Angeles');
    assert.ok(label.includes('Friday'), `expected Friday, got: ${label}`);
    assert.ok(label.includes('Jun 19'), `expected Jun 19, got: ${label}`);
  });

  test('America/New_York → Saturday Jun 20', () => {
    const label = formatEventLabel(event, 'America/New_York');
    assert.ok(label.includes('Saturday'), `expected Saturday, got: ${label}`);
    assert.ok(label.includes('Jun 20'), `expected Jun 20, got: ${label}`);
  });

  test('no timezone → falls back to LA default (never throws)', () => {
    const label = formatEventLabel(event);
    assert.ok(label.includes('Friday'));
  });
});

describe('computeWindowIntersection resolves the weekday timezone-independently', () => {
  // weekStart is a Friday; a Friday window must resolve to that same Friday date in
  // EVERY runtime timezone. Before the fix this produced Saturday under US zones.
  test('Friday window → Friday isoStart', () => {
    const fri = [{ day: 'fri', period: 'evening', earliest: '19:00', latest: '23:00' }];
    const friEarly = [{ day: 'fri', period: 'evening', earliest: '18:00', latest: '21:00' }];
    const result = computeWindowIntersection([fri, friEarly], '2026-06-19'); // a Friday
    assert.equal(result.length, 1);
    assert.match(result[0].isoStart, /^2026-06-19T/, `isoStart must be Friday 2026-06-19, got ${result[0].isoStart}`);
  });
});
