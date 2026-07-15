/**
 * cadence.test.js — Unit tests for pure logic in cadence.js
 *
 * Tests isNudgeDue and buildNudgeText using mock cadence objects.
 * No DB, no network, no loops started.
 */

'use strict';

process.env.DB_PATH   = ':memory:';
process.env.NODE_ENV  = 'test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// We only import the pure exported functions — no side effects
const { isNudgeDue, buildNudgeText } = require('../../cadence');

const now = Math.floor(Date.now() / 1000);

describe('isNudgeDue', () => {
  test('never fulfilled + 100 days old (monthly) → true (overdue)', () => {
    const cadence = {
      frequency: 'monthly',          // 30 days
      last_fulfilled_at: null,
      last_nudge_sent_at: null,
      created_at: now - 200 * 86400, // 200 days ago
      activity_type: 'lunch',
    };
    // 200 days elapsed, frequency 30 days → very overdue
    assert.equal(isNudgeDue(cadence), true);
  });

  test('fulfilled yesterday (monthly) → false (not due yet)', () => {
    const cadence = {
      frequency: 'monthly',           // 30 days
      last_fulfilled_at: now - 1 * 86400, // 1 day ago
      last_nudge_sent_at: null,
      created_at: now - 60 * 86400,
      activity_type: 'lunch',
    };
    // Only 1 day elapsed, 30 days needed → not due
    assert.equal(isNudgeDue(cadence), false);
  });

  test('overdue BUT nudge sent 1 hour ago → false (cooldown)', () => {
    const cadence = {
      frequency: 'monthly',           // 30 days
      last_fulfilled_at: now - 100 * 86400,  // very overdue
      last_nudge_sent_at: now - 3600,         // 1 hour ago
      created_at: now - 200 * 86400,
      activity_type: 'lunch',
    };
    // Overdue, but cooldown (48h) not expired → false
    assert.equal(isNudgeDue(cadence), false);
  });

  test('overdue AND nudge sent 3 days ago → true (cooldown expired)', () => {
    const cadence = {
      frequency: 'monthly',           // 30 days
      last_fulfilled_at: now - 100 * 86400,   // very overdue
      last_nudge_sent_at: now - 3 * 86400,    // 3 days ago (> 48h cooldown)
      created_at: now - 200 * 86400,
      activity_type: 'lunch',
    };
    assert.equal(isNudgeDue(cadence), true);
  });
});

describe('buildNudgeText', () => {
  const overdueCadence = {
    frequency: 'monthly',
    last_fulfilled_at: now - 100 * 86400,  // very overdue
    last_nudge_sent_at: null,
    created_at: now - 200 * 86400,
    activity_type: 'lunch',
  };

  const upcomingCadence = {
    frequency: 'monthly',             // 30 days
    last_fulfilled_at: now - 5 * 86400,  // 5 days ago → 25 days left
    last_nudge_sent_at: null,
    created_at: now - 60 * 86400,
    activity_type: 'lunch',
  };

  test('contains the contact name', () => {
    const text = buildNudgeText(overdueCadence, 'Alice');
    assert.ok(text.includes('Alice'), `Expected contact name in nudge text, got: "${text}"`);
  });

  test('overdue cadence → mentions "it\'s been a while"', () => {
    const text = buildNudgeText(overdueCadence, 'Bob');
    assert.ok(
      text.toLowerCase().includes("it's been a while"),
      `Expected "it's been a while" in overdue nudge text, got: "${text}"`
    );
  });

  test('upcoming cadence → mentions "coming up"', () => {
    const text = buildNudgeText(upcomingCadence, 'Carol');
    assert.ok(
      text.toLowerCase().includes('coming up'),
      `Expected "coming up" in upcoming nudge text, got: "${text}"`
    );
  });

  test('upcoming cadence → also contains contact name', () => {
    const text = buildNudgeText(upcomingCadence, 'Dave');
    assert.ok(text.includes('Dave'), `Expected contact name "Dave" in upcoming text, got: "${text}"`);
  });
});
