'use strict';

/**
 * coord-purge.test.js — non-retention enforcement.
 *
 * docs/REARCHITECTURE.md Phase 0: purge_after was computed and stored but nothing
 * ever deleted on it, so a peer's shared availability lingered forever. This verifies
 * db.purgeExpiredCoordination() hard-deletes sessions past purge_after (and their peer
 * rows) and expired ambient signals, while leaving still-valid data untouched.
 *
 * Run: DB_PATH=:memory: JWT_SECRET=test node --test tests/unit/coord-purge.test.js
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert');

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';

const db = require('../../db');

const PAST   = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

let result;
before(() => {
  // Expired session + peer (purge_after in the past)
  db.createCoordSession({ id: 'sess-old', desireId: 'd-old', initiatorUserId: 'u1', expiresAt: PAST, purgeAfter: PAST });
  db.createCoordPeer({ id: 'peer-old', sessionId: 'sess-old', peerAgentId: 'agentB', peerUserId: 'u2' });

  // Still-valid session + peer (purge_after in the future)
  db.createCoordSession({ id: 'sess-new', desireId: 'd-new', initiatorUserId: 'u1', expiresAt: FUTURE, purgeAfter: FUTURE });
  db.createCoordPeer({ id: 'peer-new', sessionId: 'sess-new', peerAgentId: 'agentC', peerUserId: 'u3' });

  // Expired + fresh ambient signals
  db.upsertAmbientSignal({ id: 'amb-old', fromAgentId: 'agentB', category: 'social', area: null, date: '2020-01-01', period: 'evening', certainty: 'maybe', openToCompany: 1, expiresAt: PAST });
  db.upsertAmbientSignal({ id: 'amb-new', fromAgentId: 'agentC', category: 'social', area: null, date: '2999-01-01', period: 'evening', certainty: 'maybe', openToCompany: 1, expiresAt: FUTURE });

  result = db.purgeExpiredCoordination();
});

const raw = () => db._raw();
const sessionExists = id => !!raw().prepare('SELECT 1 FROM coordination_sessions WHERE id = ?').get(id);
const peerExists    = id => !!raw().prepare('SELECT 1 FROM coord_session_peers WHERE id = ?').get(id);
const ambientExists = id => !!raw().prepare('SELECT 1 FROM ambient_signals WHERE id = ?').get(id);

describe('purgeExpiredCoordination', () => {

  test('deletes the expired session and its peer row', () => {
    assert.strictEqual(sessionExists('sess-old'), false, 'expired session must be gone');
    assert.strictEqual(peerExists('peer-old'), false, "expired session's peer availability must be gone");
  });

  test('keeps the still-valid session and its peer row', () => {
    assert.strictEqual(sessionExists('sess-new'), true, 'unexpired session must survive');
    assert.strictEqual(peerExists('peer-new'), true, 'unexpired peer must survive');
  });

  test('deletes expired ambient signals, keeps fresh ones', () => {
    assert.strictEqual(ambientExists('amb-old'), false);
    assert.strictEqual(ambientExists('amb-new'), true);
  });

  test('returns accurate deletion counts', () => {
    assert.strictEqual(result.sessions, 1);
    assert.strictEqual(result.peers, 1);
    assert.strictEqual(result.ambient, 1);
  });
});
