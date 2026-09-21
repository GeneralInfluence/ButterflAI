/**
 * datetime.test.js — deterministic day/time resolution (date-hardening).
 *
 * Fixed clock: Monday 2026-09-21, 12:00 in New York (16:00Z, EDT = UTC-4).
 * Verifies the resolver picks the right date for weekday/relative phrases, keeps
 * weekday↔date consistent, parses times, and is timezone-aware.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resolveEventDateTime, parseTime } = require('../../datetime');

const MON = new Date('2026-09-21T16:00:00Z');   // Monday in ET
const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

function weekdayOf(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

describe('resolveEventDateTime', () => {
  test('"friday 7pm" resolves to the next Friday (Sep 25), not a Saturday', () => {
    const r = resolveEventDateTime('friday 7pm', NY, MON);
    assert.equal(r.date, '2026-09-25');
    assert.equal(r.weekday, 'Friday');
    assert.equal(weekdayOf(r.date), 'Friday', 'date/weekday internally consistent');
  });

  test('"saturday 8pm" resolves to Sep 26 (Saturday) — the exact case Haiku kept missing', () => {
    const r = resolveEventDateTime('saturday 8pm', NY, MON);
    assert.equal(r.date, '2026-09-26');
    assert.equal(r.weekday, 'Saturday');
  });

  test('"tomorrow at 8pm" → Tuesday Sep 22', () => {
    const r = resolveEventDateTime('tomorrow at 8pm', NY, MON);
    assert.equal(r.date, '2026-09-22');
    assert.equal(r.weekday, 'Tuesday');
  });

  test('"today 6pm" → Monday Sep 21', () => {
    const r = resolveEventDateTime('today 6pm', NY, MON);
    assert.equal(r.date, '2026-09-21');
  });

  test('"this weekend, saturday evening" → Sep 26 at 19:00 local', () => {
    const r = resolveEventDateTime('saturday evening', NY, MON);
    assert.equal(r.date, '2026-09-26');
    // 7pm ET on Sep 26 (EDT, UTC-4) = 23:00Z
    assert.equal(r.iso, '2026-09-26T23:00:00.000Z');
  });

  test('is timezone-aware: same phrase, different absolute instant', () => {
    const ny = resolveEventDateTime('friday 7pm', NY, MON);
    const la = resolveEventDateTime('friday 7pm', LA, MON);
    assert.equal(ny.date, '2026-09-25');
    assert.equal(la.date, '2026-09-25');
    // 7pm EDT (UTC-4) = 23:00Z; 7pm PDT (UTC-7) = 02:00Z next day → different ts
    assert.equal(ny.iso, '2026-09-25T23:00:00.000Z');
    assert.equal(la.iso, '2026-09-26T02:00:00.000Z');
    assert.notEqual(ny.ts, la.ts);
  });

  test('returns null when no time can be parsed (caller asks / stays flexible)', () => {
    assert.equal(resolveEventDateTime('friday', NY, MON), null);
  });

  test('returns null when no date can be parsed', () => {
    assert.equal(resolveEventDateTime('at 7pm', NY, MON), null);
  });

  test('explicit ISO date is honored', () => {
    const r = resolveEventDateTime('2026-12-31 9pm', NY, MON);
    assert.equal(r.date, '2026-12-31');
  });
});

describe('parseTime', () => {
  for (const [input, HH, MM] of [['7pm', 19, 0], ['7:30pm', 19, 30], ['19:00', 19, 0], ['8 am', 8, 0], ['noon', 12, 0], ['evening', 19, 0]]) {
    test(`"${input}" → ${HH}:${MM}`, () => {
      assert.deepEqual(parseTime(input), { HH, MM });
    });
  }
});
