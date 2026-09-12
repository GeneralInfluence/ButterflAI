/**
 * date-context.test.js — unit tests for buildDateContext(timezone, now).
 *
 * The agent must never compute calendar dates itself (Haiku mislabels weekdays).
 * buildDateContext hands it an exact weekday->date table. These tests pin the
 * behaviour with a fixed clock so they're deterministic, and verify tz-awareness
 * and internal weekday/date consistency.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildDateContext } = require('../../agent');

// weekday name for an ISO date, computed independently (UTC noon avoids tz edges)
function weekdayOf(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

describe('buildDateContext', () => {
  // Sat 2026-09-12, 2pm in New York (18:00Z, EDT = UTC-4)
  const SAT_AFTERNOON = new Date('2026-09-12T18:00:00Z');

  test('anchors today and this weekend to the exact dates (America/New_York)', () => {
    const ctx = buildDateContext('America/New_York', SAT_AFTERNOON);
    assert.match(ctx, /Right now it is Saturday, 2026-09-12/);
    assert.ok(ctx.includes('"This weekend" = Saturday 2026-09-12 and Sunday 2026-09-13'), 'weekend dates');
    assert.ok(ctx.includes('Saturday 2026-09-12  <- TODAY'), 'today marker');
    assert.ok(ctx.includes('Sunday 2026-09-13  <- tomorrow'), 'tomorrow marker');
  });

  test('the next Friday is Sep 18 (not the following day)', () => {
    const ctx = buildDateContext('America/New_York', SAT_AFTERNOON);
    assert.ok(ctx.includes('Friday 2026-09-18'), 'next Friday resolves to 2026-09-18');
    // and NOT the off-by-one Saturday the model kept producing
    assert.ok(!/Friday 2026-09-19/.test(ctx), 'Sep 19 is Saturday, must not be labeled Friday');
  });

  test('every weekday->date row is internally consistent', () => {
    const ctx = buildDateContext('America/New_York', SAT_AFTERNOON);
    const rows = ctx.split('\n').map(l => l.match(/- (\w+) (\d{4}-\d{2}-\d{2})/)).filter(Boolean);
    assert.ok(rows.length >= 11, 'at least 11 day rows');
    for (const [, wd, iso] of rows) {
      assert.equal(wd, weekdayOf(iso), `${iso} should be ${weekdayOf(iso)}, block said ${wd}`);
    }
  });

  test('is timezone-aware: same instant can be a different local day', () => {
    // 2026-09-13T05:00Z → 1am Sun in NY (UTC-4), still 10pm Sat in LA (UTC-7)
    const instant = new Date('2026-09-13T05:00:00Z');
    const ny = buildDateContext('America/New_York', instant);
    const la = buildDateContext('America/Los_Angeles', instant);
    assert.match(ny, /Right now it is Sunday, 2026-09-13/);
    assert.match(la, /Right now it is Saturday, 2026-09-12/);
  });
});
