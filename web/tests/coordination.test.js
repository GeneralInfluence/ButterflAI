'use strict';

/**
 * coordination.test.js — Unit tests for the coordination system
 *
 * Covers:
 *   1. mcp-messages: builders, validator, free-text blocking
 *   2. desires: sanitizeDesire, social size rules, enum enforcement
 *   3. coordination: computeWindowIntersection / intersectTwoWindowSets
 *   4. mcp-transport: sign/verify, expired message rejection
 *   5. coord-loop: processDesire skips expired windows, skips in-flight sessions
 *
 * DB: uses :memory: SQLite (via db.js with DB_PATH=:memory:)
 * No external services required.
 */

process.env.DB_PATH         = ':memory:';
process.env.NODE_ENV        = 'test';
process.env.MCP_SHARED_SECRET = 'test-secret-1234';
process.env.AGENT_MODEL     = 'claude-3-5-haiku-20241022';
// Prevent actual Anthropic/Twilio calls during test
delete process.env.ANTHROPIC_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ─── 1. mcp-messages ─────────────────────────────────────────────────────────

describe('mcp-messages', () => {
  const m = require('../mcp-messages');

  test('buildProbe: accepts valid inputs', () => {
    const msg = m.buildProbe({
      fromUserId:   'user-abc-xyz-123',
      category:     'live_music',
      activityType: 'any',
      groupSizeMin: 1,
      groupSizeMax: 3,
      windowStart:  '2026-06-19',
      windowEnd:    '2026-06-26'
    });
    assert.equal(msg.message_type, 'probe');
    assert.equal(msg.payload.category, 'live_music');
    assert.equal(msg.payload.group_size.min, 1);
    assert.equal(msg.payload.group_size.max, 3);
  });

  test('buildProbe: rejects user ID shorter than 5 chars', () => {
    assert.throws(() => m.buildProbe({
      fromUserId: 'u1', category: 'social', activityType: 'any',
      groupSizeMin: 1, groupSizeMax: 2, windowStart: '2026-06-19', windowEnd: '2026-06-26'
    }), /invalid fromUserId/);
  });

  test('buildProbe: rejects free-text in category', () => {
    assert.throws(() => m.buildProbe({
      fromUserId: 'user-abc-xyz', category: 'peppermill tonight', activityType: 'any',
      groupSizeMin: 1, groupSizeMax: 2, windowStart: '2026-06-19', windowEnd: '2026-06-26'
    }));
  });

  test('buildProbe: rejects invalid activityType', () => {
    assert.throws(() => m.buildProbe({
      fromUserId: 'user-abc-xyz', category: 'social', activityType: 'fancy_dinner',
      groupSizeMin: 1, groupSizeMax: 2, windowStart: '2026-06-19', windowEnd: '2026-06-26'
    }));
  });

  test('buildReject: produces empty payload', () => {
    const r = m.buildReject();
    assert.deepEqual(r.payload, {});
    assert.equal(r.message_type, 'reject');
  });

  test('buildCancel: produces empty payload', () => {
    const c = m.buildCancel();
    assert.deepEqual(c.payload, {});
    assert.equal(c.message_type, 'cancel');
  });

  test('buildCounter: accepts valid ISO start + duration', () => {
    const c = m.buildCounter({ slotStart: '2026-06-20T19:00:00Z', durationMin: 120 });
    assert.equal(c.message_type, 'counter');
    // payload nests duration_min under slot
    assert.equal(c.payload.slot.duration_min, 120);
    assert.equal(c.payload.slot.start, '2026-06-20T19:00:00Z');
  });

  test('buildAmbientIntent: excludes venue, who, group_size fields', () => {
    const a = m.buildAmbientIntent({
      category: 'live_music', area: 'mission',
      date: '2026-06-19', period: 'evening',
      certainty: 'exploring', openToCompany: true
    });
    assert.equal(a.message_type, 'ambient_intent');
    assert(!('venue' in a.payload));
    assert(!('who' in a.payload));
    assert(!('group_size' in a.payload));
    assert(!('names' in a.payload));
  });

  test('validateOutbound: strips unknown fields', () => {
    const msg = {
      protocol: 'butterflai-coord/1.0', message_type: 'probe',
      payload: {
        from_user_id: 'user-abc-xyz', category: 'social', activity_type: 'any',
        group_size: { min: 1, max: 2 }, time_window: { start: '2026-06-19', end: '2026-06-26' },
        INJECTED_SECRET: 'private info'
      },
      nonce: 'abc'
    };
    m.validateOutbound(msg, { probe: ['from_user_id', 'category', 'activity_type', 'group_size', 'time_window'] });
    assert(!('INJECTED_SECRET' in msg.payload), 'injected field should be stripped');
  });

  test('assertNoFreeText: blocks free-text via exported function', () => {
    // assertNoFreeText is exported for direct testing.
    // It throws when a string value is not in the enum set and not a valid ID/date/time.
    assert.throws(
      () => m.assertNoFreeText({ venue: 'The Peppermill bar in the mission district' }),
      /potential free-text/
    );
  });

  test('assertNoFreeText: allows valid enum values', () => {
    // These are all valid enum values — should not throw
    assert.doesNotThrow(() => m.assertNoFreeText({
      category: 'live_music',
      period: 'evening',
      certainty: 'exploring',
      date: '2026-06-19'
    }));
  });
});

// ─── 2. desires sanitizer ─────────────────────────────────────────────────────

describe('desires.sanitizeDesire', () => {
  const { sanitizeDesire } = require('../desires');

  const base = {
    type: 'social', horizon: 'one_off', recurrence: 'none',
    category: 'dining', activity_type: 'dining',
    social_size_min: 1, social_size_max: 2,
    frequency: 1, priority: 'want',
    candidate_strategy: 'tier', candidate_tier_min: 1,
    time_window_start: '2026-06-19', time_window_end: '2026-06-26'
  };

  test('valid social desire passes', () => {
    assert.ok(sanitizeDesire(base));
  });

  test('social desire with size 0,0 is rejected', () => {
    assert.equal(sanitizeDesire({ ...base, social_size_min: 0, social_size_max: 0 }), null);
  });

  test('social desire with size 1,0 (min > max) is rejected', () => {
    assert.equal(sanitizeDesire({ ...base, social_size_min: 2, social_size_max: 1 }), null);
  });

  test('solo desire with size 0,0 is allowed', () => {
    assert.ok(sanitizeDesire({
      ...base, type: 'solo', category: 'active', activity_type: 'active',
      social_size_min: 0, social_size_max: 0, candidate_strategy: 'any'
    }));
  });

  test('venue name in category is rejected', () => {
    assert.equal(sanitizeDesire({ ...base, category: 'peppermill bar' }), null);
  });

  test('person name in type is rejected', () => {
    assert.equal(sanitizeDesire({ ...base, type: 'with jaimison' }), null);
  });

  test('invalid horizon is rejected', () => {
    assert.equal(sanitizeDesire({ ...base, horizon: 'someday' }), null);
  });

  test('invalid recurrence is rejected', () => {
    assert.equal(sanitizeDesire({ ...base, recurrence: 'daily' }), null);
  });

  test('invalid candidate_strategy is rejected', () => {
    assert.equal(sanitizeDesire({ ...base, candidate_strategy: 'random' }), null);
  });

  test('bad date format is rejected', () => {
    assert.equal(sanitizeDesire({ ...base, time_window_start: 'next friday' }), null);
  });

  test('recurring weekly passes', () => {
    assert.ok(sanitizeDesire({ ...base, horizon: 'recurring', recurrence: 'weekly' }));
  });

  test('also_updates_preference flag passes through', () => {
    assert.ok(sanitizeDesire({ ...base, also_updates_preference: true }));
  });

  test('live_music category is valid', () => {
    assert.ok(sanitizeDesire({ ...base, category: 'live_music', activity_type: 'live_music' }));
  });
});

// ─── 3. window intersection ───────────────────────────────────────────────────

describe('coordination.computeWindowIntersection', () => {
  const { computeWindowIntersection, intersectTwoWindowSets } = require('../coordination');

  const fridayEvening = [{ day: 'fri', period: 'evening', earliest: '19:00', latest: '23:00' }];
  const fridayEveningEarly = [{ day: 'fri', period: 'evening', earliest: '18:00', latest: '21:00' }];
  const saturdayAfternoon = [{ day: 'sat', period: 'afternoon', earliest: '13:00', latest: '17:00' }];
  const weekStart = '2026-06-19'; // a Friday

  test('two overlapping windows produce intersection', () => {
    const result = computeWindowIntersection([fridayEvening, fridayEveningEarly], weekStart);
    assert.equal(result.length, 1);
    assert.equal(result[0].day, 'fri');
    assert.equal(result[0].earliest, '19:00');  // later of the two earliests
    assert.equal(result[0].latest,   '21:00');  // earlier of the two latests
    assert.equal(result[0].durationMin, 120);   // 19:00–21:00 = 2h
  });

  test('non-overlapping days produce empty result', () => {
    const result = computeWindowIntersection([fridayEvening, saturdayAfternoon], weekStart);
    assert.equal(result.length, 0);
  });

  test('touching windows (end === start) produce empty result', () => {
    const a = [{ day: 'fri', period: 'evening', earliest: '18:00', latest: '19:00' }];
    const b = [{ day: 'fri', period: 'evening', earliest: '19:00', latest: '21:00' }];
    const result = computeWindowIntersection([a, b], weekStart);
    assert.equal(result.length, 0);
  });

  test('single window set returns unchanged', () => {
    const result = computeWindowIntersection([fridayEvening], weekStart);
    assert.deepEqual(result, fridayEvening);
  });

  test('empty window set returns empty', () => {
    const result = computeWindowIntersection([], weekStart);
    assert.equal(result.length, 0);
  });

  test('three-way intersection: takes narrowest overlap', () => {
    const a = [{ day: 'fri', period: 'evening', earliest: '18:00', latest: '23:00' }];
    const b = [{ day: 'fri', period: 'evening', earliest: '19:00', latest: '22:00' }];
    const c = [{ day: 'fri', period: 'evening', earliest: '20:00', latest: '21:00' }];
    const result = computeWindowIntersection([a, b, c], weekStart);
    assert.equal(result.length, 1);
    assert.equal(result[0].earliest, '20:00');
    assert.equal(result[0].latest,   '21:00');
    assert.equal(result[0].durationMin, 60);
  });

  test('isoStart is populated correctly for a Friday window', () => {
    const result = computeWindowIntersection([fridayEvening, fridayEveningEarly], weekStart);
    // weekStart is 2026-06-19 (a Friday). fridayEvening → same day.
    assert.match(result[0].isoStart, /2026-06-19T19:00:00/);
  });

  test('intersectTwoWindowSets: matching day+period is required', () => {
    const result = intersectTwoWindowSets(fridayEvening, saturdayAfternoon, weekStart);
    assert.equal(result.length, 0);
  });
});

// ─── 4. mcp-transport: sign/verify ───────────────────────────────────────────

describe('mcp-transport', () => {
  const transport = require('../mcp-transport');

  test('sign produces hex string', () => {
    const sig = transport.sign('{"hello":"world"}');
    assert.match(sig, /^[a-f0-9]{64}$/);
  });

  test('verifySignature accepts valid sig', () => {
    const body = JSON.stringify({ test: 1 });
    const sig  = transport.sign(body);
    assert.ok(transport.verifySignature(body, sig));
  });

  test('verifySignature rejects tampered body', () => {
    const body    = JSON.stringify({ test: 1 });
    const sig     = transport.sign(body);
    const tampered = JSON.stringify({ test: 2 });
    assert.equal(transport.verifySignature(tampered, sig), false);
  });

  test('verifySignature rejects wrong-length hex', () => {
    assert.equal(transport.verifySignature('{"x":1}', 'deadbeef'), false);
  });

  test('send rejects invalid URL', async () => {
    await assert.rejects(
      () => transport.send('not-a-url', { message_type: 'probe' }),
      /invalid agent endpoint/
    );
  });
});

// ─── 5. coord-loop: processDesire guards ─────────────────────────────────────

describe('coord-loop.processDesire', () => {
  // We test processDesire in isolation using a mock transport and minimal DB state.
  // This verifies the guard conditions without needing a live coordination session.

  const { processDesire } = require('../coord-loop');
  const db = require('../db');

  // Create a test user
  const testUserId = 'test-user-coordloop';
  const testPhone  = '+15550009999';

  // Ensure user exists
  try {
    db._raw().prepare(
      `INSERT OR IGNORE INTO users (id, phone, name, onboarded) VALUES (?, ?, 'Test', 1)`
    ).run(testUserId, testPhone);
  } catch { /* ignore */ }

  const capturedSends = [];
  const mockTransport = {
    send(to, msg) { capturedSends.push({ to, type: msg.message_type }); }
  };

  test('expired desire is marked dropped, no session created', async () => {
    const desireId = 'desire-expired-' + Date.now();
    db._raw().prepare(`
      INSERT INTO desires (id, user_id, category, activity_type,
        social_size_min, social_size_max, priority, status,
        candidate_strategy, horizon, recurrence,
        time_window_start, time_window_end, raw_text, raw_text_zeroed)
      VALUES (?, ?, 'social', 'any', 1, 3, 'want', 'pending',
              'any', 'one_off', 'none',
              '2026-01-01', '2026-01-07', '', 1)
    `).run(desireId, testUserId);

    // Fetch the desire as the coord_desires VIEW would (without raw_text)
    const desire = db._raw().prepare(
      'SELECT * FROM coord_desires WHERE id = ?'
    ).get(desireId);

    await processDesire(mockTransport, desire);

    const updated = db._raw().prepare('SELECT status FROM desires WHERE id = ?').get(desireId);
    assert.equal(updated.status, 'dropped', 'expired desire should be marked dropped');
    assert.equal(capturedSends.length, 0, 'no messages should be sent for expired desire');
  });

  test('in-flight session prevents duplicate probing', async () => {
    const desireId  = 'desire-inflight-' + Date.now();
    const sessionId = 'session-inflight-' + Date.now();

    db._raw().prepare(`
      INSERT INTO desires (id, user_id, category, activity_type,
        social_size_min, social_size_max, priority, status,
        candidate_strategy, horizon, recurrence,
        time_window_start, time_window_end, raw_text, raw_text_zeroed)
      VALUES (?, ?, 'social', 'any', 1, 3, 'want', 'pending',
              'any', 'one_off', 'none',
              date('now'), date('now', '+7 days'), '', 1)
    `).run(desireId, testUserId);

    // Plant an in-flight session for this desire (using actual schema columns)
    db._raw().prepare(`
      INSERT INTO coordination_sessions (id, desire_id, initiator_user_id, state,
        round, expires_at, created_at, updated_at, purge_after)
      VALUES (?, ?, ?, 'probing', 1, date('now','+14 days'), strftime('%s','now'), strftime('%s','now'), date('now','+14 days'))
    `).run(sessionId, desireId, testUserId);

    const sendsBefore = capturedSends.length;
    const desire = db._raw().prepare('SELECT * FROM coord_desires WHERE id = ?').get(desireId);
    await processDesire(mockTransport, desire);

    assert.equal(capturedSends.length, sendsBefore, 'should not probe again when session is in-flight');
  });
});
