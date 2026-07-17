'use strict';

/**
 * agent-query-privacy.test.js — structural privacy wall for agent-to-agent replies.
 *
 * PRIVACY.md Invariant 2 + docs/REARCHITECTURE.md Phase 0: when this user's agent
 * answers ANOTHER user's agent (channel === 'agent_query'), it composes an outbound
 * message to that peer. Private and soft preferences MUST NOT be in the context that
 * composes that message. This is enforced structurally in buildPrefsSection() via the
 * coordinationOnly flag — not by a system-prompt rule the model might ignore.
 *
 * Run: DB_PATH=:memory: JWT_SECRET=test node --test tests/unit/agent-query-privacy.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';

const { buildPrefsSection } = require('../../agent');

// A fully-populated preference record — one field of every kind, including the
// free-text/soft fields that are the known leak vectors.
const FULL_PREFS = {
  food_allergies: ['peanuts'],
  dietary_restrictions: ['vegetarian'],
  cuisine_loves: ['thai'],
  cuisine_avoids: ['oysters'],
  activity_loves: ['hiking'],
  activity_avoids: ['clubbing'],
  vibe: ['dive bar'],
  budget_low: 20,
  budget_high: 60,
  neighborhood: 'the Mission',
  city: 'SF',
  availability_notes: 'free weeknights after 7, seeing a therapist Tuesday mornings',
  comm_style: 'brief',
  extra_notes: 'going through a breakup, be gentle',
};

// Everything that must never reach a peer-facing composition in coordinationOnly mode.
const PRIVATE_AND_SOFT_LEAKS = [
  'going through a breakup', // extra_notes
  'therapist',               // availability_notes free text
  'weeknights after 7',      // availability_notes
  'brief',                   // comm_style
  'thai', 'oysters',         // cuisine soft prefs
  'hiking', 'clubbing',      // activity soft prefs
  'dive bar',                // vibe
  'the Mission',             // neighborhood
  'Budget',                  // budget
];

describe('agent_query coordination-only prefs snapshot', () => {

  test('hard constraints (allergies, diet) ARE included', () => {
    const section = buildPrefsSection(FULL_PREFS, { coordinationOnly: true });
    assert.ok(section.includes('peanuts'), 'allergies must cross for safety');
    assert.ok(section.includes('vegetarian'), 'dietary restrictions must cross for coordination');
  });

  test('NO soft preference or free-text note leaks into coordination context', () => {
    const section = buildPrefsSection(FULL_PREFS, { coordinationOnly: true });
    for (const leak of PRIVATE_AND_SOFT_LEAKS) {
      assert.ok(
        !section.includes(leak),
        `coordination-only snapshot must NOT contain ${JSON.stringify(leak)} — leaked:\n${section}`
      );
    }
  });

  test('own-session snapshot (coordinationOnly=false) DOES include soft prefs', () => {
    const section = buildPrefsSection(FULL_PREFS, { coordinationOnly: false });
    assert.ok(section.includes('going through a breakup'), 'own session keeps full context');
    assert.ok(section.includes('brief'), 'own session keeps comm style');
    assert.ok(section.includes('peanuts'), 'own session still has hard constraints');
  });

  test('empty prefs never throws and leaks nothing in coordination mode', () => {
    const section = buildPrefsSection(null, { coordinationOnly: true });
    assert.ok(typeof section === 'string' && section.length > 0);
    assert.ok(!section.includes('breakup'));
  });
});
