/**
 * event-recency.test.js — the agent must never present a past event as current.
 * Bug (2026-09-22): a July "80s bar" event, still status='open', surfaced in the
 * snapshot and the agent messaged "heading there tonight". eventRecency classifies
 * events so long-past ones are dropped and recently-past ones are flagged.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { eventRecency } = require('../../agent');

describe('eventRecency', () => {
  const NOW = new Date('2026-09-22T12:00:00Z').getTime();
  const agoSec   = (h) => Math.floor(NOW / 1000) - h * 3600;
  const aheadSec = (h) => Math.floor(NOW / 1000) + h * 3600;

  test('flexible / no-time events are never treated as past', () => {
    assert.equal(eventRecency(agoSec(1000), 1, NOW), 'flexible');
    assert.equal(eventRecency(null, 0, NOW), 'flexible');
  });

  test('a future event is upcoming', () => {
    assert.equal(eventRecency(aheadSec(5), 0, NOW), 'upcoming');
  });

  test('recently past (within ~48h) is "past" (kept, but flagged)', () => {
    assert.equal(eventRecency(agoSec(6), 0, NOW), 'past');
    assert.equal(eventRecency(agoSec(47), 0, NOW), 'past');
  });

  test('long past is "stale" (dropped from the snapshot)', () => {
    assert.equal(eventRecency(agoSec(72), 0, NOW), 'stale');
    assert.equal(eventRecency(agoSec(24 * 60), 0, NOW), 'stale', 'the ~2-month-old 80s-bar case');
  });
});
