'use strict';

/**
 * mcp-messages.js — Outbound agent-to-agent message builders + validator
 *
 * TWO protocol classes:
 *   1. Coordination — explicit scheduling (probe → availability → proposal → confirm)
 *   2. Ambient      — soft social signal ("live music interest tonight") — pull-based
 *
 * PRIVACY INVARIANTS (enforced structurally, not by policy):
 *   - No raw desire text ever appears in any outbound message
 *   - No venue names, exact addresses, or specific plans in ambient messages
 *   - No group membership, exclusion lists, or "who else is coming"
 *   - No free-text string fields — all strings are enums, IDs, dates, or times
 *   - Reject/cancel carry empty payloads — reasons stay private
 *   - Every outbound message is validated + stripped before send
 *
 * The LLM parses user desires into structured fields upstream.
 * This module uses those structured fields only — it never touches raw_text.
 */

const { v4: uuidv4 } = require('uuid');

// ─── Enums ────────────────────────────────────────────────────────────────────

const CATEGORIES    = ['social', 'active', 'dining', 'outdoor', 'chill', 'live_music', 'dancing', 'drinks', 'sports', 'culture'];
const ACTIVITY_TYPES = ['any', 'dining', 'outdoor', 'active', 'drinks', 'live_music', 'dancing', 'casual', 'sports', 'culture'];
const PERIODS       = ['morning', 'afternoon', 'evening', 'night'];
const DAYS          = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const CERTAINTY     = ['exploring', 'probable', 'definite'];
const ALL_ENUMS     = new Set([...CATEGORIES, ...ACTIVITY_TYPES, ...PERIODS, ...DAYS, ...CERTAINTY]);

// ─── Payload allowlists (the only fields permitted per message type) ───────────
// Anything not in this list is stripped before send — catches ...spread accidents.

const COORD_ALLOWLISTS = {
  probe:        ['from_user_id', 'category', 'activity_type', 'group_size', 'time_window'],
  interest:     ['interested', 'available_days'],
  availability: ['windows'],
  proposal:     ['slot', 'activity_sketch', 'requires_human_confirm'],
  confirm:      ['pending_human_approval', 'respond_by'],
  counter:      ['slot'],
  reject:       [],   // empty on purpose — no reason crosses the wire
  cancel:       []    // empty on purpose
};

const AMBIENT_ALLOWLISTS = {
  ambient_intent:  ['category', 'area', 'date', 'period', 'certainty', 'open_to_company'],
  ambient_cancel:  ['date', 'category']
  // NOT in ambient: venue names, group size, who's coming, who to avoid
};

// ─── Type helpers ─────────────────────────────────────────────────────────────

function isUserId(v)       { return typeof v === 'string' && /^[a-zA-Z0-9+\-_.]{5,64}$/.test(v); }
function isDateStr(v)      { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }
function isTimeStr(v)      { return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v); }
function isISOStr(v)       { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v); }
function isNeighborhood(v) { return typeof v === 'string' && /^[a-z0-9_-]{2,40}$/.test(v); }
function assert(cond, msg) { if (!cond) throw new Error(`mcp-messages: ${msg}`); }

// ─── Coordination Builders ────────────────────────────────────────────────────
// Used for explicit scheduling: 1-on-1 or small group.
// Round 1: probe + interest
// Round 2: availability exchange
// Round 3: proposal + confirm/counter/reject

/**
 * Round 1 (initiator → peer): "Are you open to [category] this week?"
 */
function buildProbe({ fromUserId, category, activityType = 'any', groupSizeMin = 1, groupSizeMax = 1, windowStart, windowEnd }) {
  assert(isUserId(fromUserId),                                       'invalid fromUserId');
  assert(CATEGORIES.includes(category),                              'invalid category');
  assert(ACTIVITY_TYPES.includes(activityType),                      'invalid activityType');
  assert(Number.isInteger(groupSizeMin) && groupSizeMin >= 1,        'groupSizeMin must be integer >= 1');
  assert(Number.isInteger(groupSizeMax) && groupSizeMax >= groupSizeMin, 'groupSizeMax must be >= groupSizeMin');
  assert(isDateStr(windowStart) && isDateStr(windowEnd),             'invalid window dates');

  return envelope('probe', {
    from_user_id:  fromUserId,
    category,
    activity_type: activityType,
    group_size:    { min: groupSizeMin, max: groupSizeMax },
    time_window:   { start: windowStart, end: windowEnd }
  });
}

/**
 * Round 1 (peer → initiator): "Yes/no, and here are my open days"
 */
function buildInterest({ interested, availableDays = [] }) {
  assert(typeof interested === 'boolean',                              'interested must be boolean');
  assert(Array.isArray(availableDays),                                'availableDays must be array');
  assert(availableDays.every(d => DAYS.includes(d)),                  'invalid day in availableDays');

  return envelope('interest', {
    interested,
    available_days: availableDays
  });
}

/**
 * Round 2: exchange specific time windows
 * Both sides use this — initiator sends candidates, peer responds with matches.
 */
function buildAvailability({ windows }) {
  assert(Array.isArray(windows) && windows.length > 0, 'windows must be a non-empty array');
  for (const w of windows) {
    assert(DAYS.includes(w.day),       `invalid day: ${w.day}`);
    assert(PERIODS.includes(w.period), `invalid period: ${w.period}`);
    assert(isTimeStr(w.earliest),      'earliest must be HH:MM');
    assert(isTimeStr(w.latest),        'latest must be HH:MM');
  }

  return envelope('availability', {
    windows: windows.map(w => ({
      day:      w.day,
      period:   w.period,
      earliest: w.earliest,
      latest:   w.latest
    }))
  });
}

/**
 * Round 3 (initiator → peer): specific slot proposal
 * activity_sketch is an enum — not a venue name, not a plan description.
 */
function buildProposal({ slotStart, durationMin, activitySketch, requiresHumanConfirm = true }) {
  assert(isISOStr(slotStart),                                    'invalid slotStart (must be ISO)');
  assert(Number.isInteger(durationMin) && durationMin > 0,       'durationMin must be positive integer');
  assert(ACTIVITY_TYPES.includes(activitySketch),                'activitySketch must be an enum value');
  assert(typeof requiresHumanConfirm === 'boolean',              'requiresHumanConfirm must be boolean');

  return envelope('proposal', {
    slot:                   { start: slotStart, duration_min: durationMin },
    activity_sketch:        activitySketch,
    requires_human_confirm: requiresHumanConfirm
  });
}

/**
 * Round 3 (peer → initiator): "Looks good, checking with my person"
 */
function buildConfirm({ pendingHumanApproval, respondBy }) {
  assert(typeof pendingHumanApproval === 'boolean', 'pendingHumanApproval must be boolean');
  assert(isISOStr(respondBy),                       'invalid respondBy (must be ISO)');

  return envelope('confirm', {
    pending_human_approval: pendingHumanApproval,
    respond_by:             respondBy
  });
}

/**
 * Round 3 (peer → initiator): "That slot doesn't work, how about this?"
 * Counter counts as round 3 — if initiator accepts, that's the end.
 */
function buildCounter({ slotStart, durationMin }) {
  assert(isISOStr(slotStart),                              'invalid slotStart (must be ISO)');
  assert(Number.isInteger(durationMin) && durationMin > 0, 'durationMin must be positive integer');

  return envelope('counter', {
    slot: { start: slotStart, duration_min: durationMin }
  });
}

/**
 * Reject — no reason. Reasons stay private.
 */
function buildReject() {
  return envelope('reject', {});
}

/**
 * Cancel an in-progress session (e.g. human said no after a pending_human_approval).
 */
function buildCancel() {
  return envelope('cancel', {});
}

// ─── Ambient Intent Builders ──────────────────────────────────────────────────
// For soft social signals — "I'm thinking about live music tonight."
//
// What is deliberately ABSENT from ambient messages:
//   ✗ Venue names or addresses
//   ✗ Who else is coming
//   ✗ Group size
//   ✗ Who the user doesn't want to run into
//   ✗ Certainty about specific venues
//
// Pull-based: contacts ask their own agent "what's happening tonight?"
// Their agent aggregates received signals + runs a separate venue lookup.
// Venue suggestions come from that lookup — not from this broadcast.
// This severs the link between "Sean mentioned Peppermill" and the response
// "popular live music spots: Peppermill, DeadRinger, Bottom of the Hill."

/**
 * Broadcast soft social intent to a set of peer agents.
 *
 * @param category      - what kind of activity (enum)
 * @param area          - neighborhood slug e.g. "mission", "williamsburg", or null
 * @param date          - YYYY-MM-DD
 * @param period        - morning | afternoon | evening | night
 * @param certainty     - exploring | probable | definite
 * @param openToCompany - true if the user would welcome running into friends
 */
function buildAmbientIntent({ category, area = null, date, period, certainty, openToCompany }) {
  assert(CATEGORIES.includes(category),                          'invalid category');
  assert(area === null || isNeighborhood(area),                  'area must be a short neighborhood slug or null');
  assert(isDateStr(date),                                        'invalid date');
  assert(PERIODS.includes(period),                               'invalid period');
  assert(CERTAINTY.includes(certainty),                          'invalid certainty');
  assert(typeof openToCompany === 'boolean',                     'openToCompany must be boolean');
  // Intentionally: no venue, no group_size, no companions, no exclusions

  return envelope('ambient_intent', {
    category,
    area,
    date,
    period,
    certainty,
    open_to_company: openToCompany
  });
}

/**
 * Cancel a previously broadcast ambient intent (plans changed).
 */
function buildAmbientCancel({ date, category }) {
  assert(isDateStr(date),              'invalid date');
  assert(CATEGORIES.includes(category), 'invalid category');

  return envelope('ambient_cancel', { date, category });
}

// ─── Send (requires an MCP transport instance) ────────────────────────────────

/**
 * Send a coordination message to one peer agent.
 * Adds session envelope fields and validates before send.
 */
function sendCoordMessage(transport, { sessionId, fromAgent, toAgent, round, expiresAt }, msg) {
  assert(typeof sessionId === 'string',  'missing sessionId');
  assert(typeof fromAgent === 'string',  'missing fromAgent');
  assert(typeof toAgent === 'string',    'missing toAgent');
  assert([1, 2, 3].includes(round),      'round must be 1, 2, or 3');
  assert(isISOStr(expiresAt),            'invalid expiresAt');

  validateOutbound(msg, COORD_ALLOWLISTS);

  transport.send(toAgent, {
    ...msg,
    session_id: sessionId,
    from_agent:  fromAgent,
    to_agent:    toAgent,
    round,
    expires_at:  expiresAt
  });
}

/**
 * Broadcast an ambient intent to multiple peer agents simultaneously.
 * Validates once, sends to each recipient.
 */
function sendAmbientMessage(transport, { fromAgent, toAgents, expiresAt }, msg) {
  assert(typeof fromAgent === 'string',                'missing fromAgent');
  assert(Array.isArray(toAgents) && toAgents.length,  'toAgents must be a non-empty array');
  assert(isISOStr(expiresAt),                          'invalid expiresAt');

  validateOutbound(msg, AMBIENT_ALLOWLISTS);

  for (const toAgent of toAgents) {
    transport.send(toAgent, {
      ...msg,
      from_agent: fromAgent,
      to_agent:   toAgent,
      expires_at: expiresAt
    });
  }
}

// ─── Outbound Validator (the last line of defense) ────────────────────────────

/**
 * Validates a message payload before it hits the wire:
 *   1. Checks message_type is known
 *   2. Strips any fields not in the allowlist (catches ...spread accidents)
 *   3. Scans all string values for free-text (rejects anything that isn't
 *      an enum, ID, date, time, or short neighborhood slug)
 *
 * Mutates msg.payload to the stripped version.
 * Throws on any violation — never silently allows a bad message through.
 */
function validateOutbound(msg, allowlists) {
  const allowed = allowlists[msg.message_type];
  if (allowed === undefined) throw new Error(`mcp-messages: unknown message_type "${msg.message_type}"`);

  // Strip to allowlist
  const stripped = {};
  for (const key of allowed) {
    if (key in msg.payload) stripped[key] = msg.payload[key];
  }

  // Scan for free-text strings
  assertNoFreeText(stripped);

  msg.payload = stripped;
}

/**
 * Recursively checks that no string value looks like user-generated free text.
 * Allowed strings: enum values, IDs, ISO dates/times, neighborhood slugs.
 * Throws with field path if anything suspicious is found.
 */
function assertNoFreeText(obj, path = '') {
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;

    if (v === null || typeof v === 'boolean' || typeof v === 'number') {
      continue; // safe types
    }

    if (typeof v === 'string') {
      const ok = ALL_ENUMS.has(v)
        || isUserId(v)
        || isDateStr(v)
        || isTimeStr(v)
        || isISOStr(v)
        || isNeighborhood(v);

      if (!ok) {
        throw new Error(
          `mcp-messages: potential free-text at "${p}" — coord messages cannot contain user-generated text. ` +
          `Value starts with: "${v.slice(0, 30)}"`
        );
      }
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) assertNoFreeText(item, `${p}[${i}]`);
        else assertNoFreeText({ _: item }, p); // reuse string check
      });
    } else if (typeof v === 'object') {
      assertNoFreeText(v, p);
    }
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function envelope(messageType, payload) {
  return {
    protocol:     'butterflai-coord/1.0',
    message_type: messageType,
    payload,
    nonce:        uuidv4()
    // session_id, from_agent, to_agent, expires_at added by sendCoordMessage / sendAmbientMessage
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Coordination builders
  buildProbe,
  buildInterest,
  buildAvailability,
  buildProposal,
  buildConfirm,
  buildCounter,
  buildReject,
  buildCancel,

  // Ambient builders
  buildAmbientIntent,
  buildAmbientCancel,

  // Send
  sendCoordMessage,
  sendAmbientMessage,

  // Exported for testing
  validateOutbound,
  assertNoFreeText,

  // Enums (for callers to reference without hardcoding strings)
  CATEGORIES,
  ACTIVITY_TYPES,
  PERIODS,
  DAYS,
  CERTAINTY
};
