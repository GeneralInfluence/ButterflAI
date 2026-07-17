'use strict';

/**
 * calendar-tz.test.js — DST-aware wall-clock <-> UTC conversion for free-slot finding.
 *
 * findFreeSlots used the SERVER's timezone (UTC on Fly/Docker) to build "8am" windows,
 * so suggested slots landed at the wrong hour for the user. The fix does all wall-clock
 * reasoning in the user's calendar timezone via _wallToUtcMs. These tests pin that helper
 * (where the correctness lives), including both DST transitions — and pass under ANY
 * process timezone. (docs/REARCHITECTURE.md Phase 0 tz sweep.)
 *
 * Run: DB_PATH=:memory: JWT_SECRET=test node --test tests/unit/calendar-tz.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';

const { _wallToUtcMs, _tzParts, formatSlotLabel } = require('../../calendar');

// Helper: what UTC ISO does a given LA wall-clock map to?
const iso = ms => new Date(ms).toISOString();

describe('_wallToUtcMs converts a zone wall-clock to the correct UTC instant', () => {

  test('LA summer (PDT, UTC-7): 8:00 local → 15:00Z', () => {
    // 2026-07-15 is in PDT.
    assert.strictEqual(iso(_wallToUtcMs(2026, 7, 15, 8, 0, 'America/Los_Angeles')), '2026-07-15T15:00:00.000Z');
  });

  test('LA winter (PST, UTC-8): 8:00 local → 16:00Z', () => {
    // 2026-01-15 is in PST.
    assert.strictEqual(iso(_wallToUtcMs(2026, 1, 15, 8, 0, 'America/Los_Angeles')), '2026-01-15T16:00:00.000Z');
  });

  test('NY (EST, UTC-5): 9:00 local → 14:00Z', () => {
    assert.strictEqual(iso(_wallToUtcMs(2026, 1, 15, 9, 0, 'America/New_York')), '2026-01-15T14:00:00.000Z');
  });

  test('the day AFTER US spring-forward is PDT (UTC-7)', () => {
    // Spring-forward 2026 is 2026-03-08. 09:00 on 03-09 should be PDT → 16:00Z.
    assert.strictEqual(iso(_wallToUtcMs(2026, 3, 9, 9, 0, 'America/Los_Angeles')), '2026-03-09T16:00:00.000Z');
  });

  test('the day BEFORE spring-forward is still PST (UTC-8)', () => {
    // 09:00 on 03-07 (before the jump) is PST → 17:00Z.
    assert.strictEqual(iso(_wallToUtcMs(2026, 3, 7, 9, 0, 'America/Los_Angeles')), '2026-03-07T17:00:00.000Z');
  });

  test('after fall-back is PST again (UTC-8)', () => {
    // Fall-back 2026 is 2026-11-01. 09:00 on 11-02 is PST → 17:00Z.
    assert.strictEqual(iso(_wallToUtcMs(2026, 11, 2, 9, 0, 'America/Los_Angeles')), '2026-11-02T17:00:00.000Z');
  });
});

describe('_tzParts reads an instant in the given zone', () => {
  test('an early-UTC instant is the previous evening in LA', () => {
    // 2026-06-20T05:30:00Z = 2026-06-19 22:30 PDT.
    const p = _tzParts(Date.UTC(2026, 5, 20, 5, 30, 0), 'America/Los_Angeles');
    assert.deepStrictEqual([p.year, p.month, p.day, p.hour], [2026, 6, 19, 22]);
  });
});

describe('formatSlotLabel renders in the given zone', () => {
  test('8:00 PDT slot labels as 8am on the LA date', () => {
    const ms = _wallToUtcMs(2026, 7, 15, 8, 0, 'America/Los_Angeles'); // 15:00Z
    assert.strictEqual(formatSlotLabel(ms, 'America/Los_Angeles'), 'Wed Jul 15 at 8am');
  });
  test('same instant labels differently in NY', () => {
    const ms = _wallToUtcMs(2026, 7, 15, 8, 0, 'America/Los_Angeles'); // 15:00Z = 11am EDT
    assert.strictEqual(formatSlotLabel(ms, 'America/New_York'), 'Wed Jul 15 at 11am');
  });
});
