/**
 * Lift estimator — compute coordination value, log it, mint nothing.
 *
 * Computable now:
 *   activation       — lapse ratio vs user's own cadence baseline
 *   assembly         — confirmed attendees vs counterfactual
 *   organizer_labor  — rounds of negotiation derived from proposals + invitations
 *   quality          — repeat attendance (will be empty for months — correct)
 *
 * NOT computable (stub returning null):
 *   discovery        — needs K (redundancy divisor), blocked on MEMORY.md §5 Q2 [OPEN]
 *
 * inputs field is MANDATORY on every observation (TOKEN.md §11.4).
 *
 * eventId is a plan (social_events). 2026-10-13: these used to read the old `activities`
 * table, which nothing writes any more, so lift was never measured for real plans. A
 * plan's cadence is found through the people in it (cadenceFor).
 */

'use strict';

function _getDb() {
  return require('./db');
}

// The people in a plan other than this user, as phones (host + everyone who said yes).
function peopleIn(eventId, userId) {
  const db = _getDb();
  const e = db._raw().prepare('SELECT host_user_id FROM social_events WHERE id = ?').get(eventId);
  if (!e) return [];
  const me = db.getUser(userId)?.phone;
  const host = db.getUser(e.host_user_id)?.phone;
  const guests = db._raw().prepare(`SELECT c.phone FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
    WHERE ei.event_id = ? AND ei.status = 'accepted' AND c.phone IS NOT NULL`).all(eventId).map((r) => r.phone);
  return [...new Set([host, ...guests].filter((p) => p && p !== me))];
}

/** The user's most overdue active cadence with someone in this plan, or null. */
function cadenceFor(eventId, userId) {
  const db = _getDb();
  const phones = peopleIn(eventId, userId);
  if (!phones.length) return null;
  return db._raw().prepare(`SELECT cd.* FROM cadences cd JOIN relationships r ON r.id = cd.relationship_id
    JOIN contacts c ON c.id = r.contact_id
    WHERE r.user_id = ? AND cd.active = 1 AND c.phone IN (${phones.map(() => '?').join(',')})
    ORDER BY COALESCE(cd.last_fulfilled_at, cd.created_at) ASC LIMIT 1`).get(userId, ...phones) || null;
}

// ── Estimators ────────────────────────────────────────────────────────────────

/**
 * estimateActivation — lapse ratio vs user's own cadence baseline.
 * Value 0–1: 1 = large gap was closed (high activation), 0 = well within cadence.
 *
 * @param {string} eventId
 * @param {string} userId
 * @param {string} cadenceId
 * @returns {{ value: number|null, confidence: number, inputs: object }}
 */
function estimateActivation(eventId, userId, cadenceId) {
  const db = _getDb();
  const inputs = { eventId, userId, cadenceId };

  if (!cadenceId) {
    return { value: null, confidence: 0, inputs };
  }

  const cadence = db._raw()
    .prepare('SELECT * FROM cadences WHERE id = ?')
    .get(cadenceId);

  if (!cadence) {
    return { value: null, confidence: 0, inputs: { ...inputs, error: 'cadence_not_found' } };
  }

  const FREQUENCY_DAYS = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 90 };
  const freqDays = FREQUENCY_DAYS[cadence.frequency] || 30;
  const freqSecs = freqDays * 86400;

  const nowSecs = Math.floor(Date.now() / 1000);
  const lastFulfilled = cadence.last_fulfilled_at || cadence.created_at;
  const elapsed = nowSecs - lastFulfilled;

  // Ratio of elapsed time vs expected frequency
  // Clamped to [0, 1]: 0 = right on time, 1 = very overdue
  const lapseRatio = Math.min(elapsed / freqSecs, 2) / 2; // normalize: 2x overdue = 1.0
  const value = Math.min(Math.max(lapseRatio, 0), 1);

  return {
    value,
    confidence: 0.7,
    inputs: {
      ...inputs,
      last_fulfilled_at: lastFulfilled,
      frequency: cadence.frequency,
      elapsed_secs: elapsed,
      freq_secs: freqSecs,
      lapse_ratio: lapseRatio,
    },
  };
}

/**
 * estimateAssembly — confirmed attendees vs cadence group_size baseline.
 * Value 0–1: 1 = expected group showed up, 0 = nobody confirmed.
 *
 * @param {string} eventId
 * @param {string} userId
 * @returns {{ value: number|null, confidence: number, inputs: object }}
 */
function estimateAssembly(eventId, userId) {
  const db = _getDb();
  const inputs = { eventId, userId };

  // Count confirmed attendees for this event
  const confirmedRow = db._raw()
    .prepare(`SELECT COUNT(*) as cnt FROM attendance_confirmations WHERE event_id = ? AND attended = 1`)
    .get(eventId);
  const confirmed = confirmedRow?.cnt || 0;

  // Who was expected: everyone who said yes plus the host.
  const said = db._raw().prepare(`SELECT count(*) AS n FROM event_invitations WHERE event_id = ? AND status = 'accepted'`).get(eventId)?.n || 0;
  const expectedSize = Math.max(2, said + 1);

  if (confirmed === 0) {
    return { value: 0, confidence: 0.5, inputs: { ...inputs, confirmed, expected: expectedSize } };
  }

  const value = Math.min(confirmed / expectedSize, 1);
  return {
    value,
    confidence: 0.8,
    inputs: { ...inputs, confirmed, expected: expectedSize },
  };
}

/**
 * estimateOrganizerLabor — rounds of negotiation from proposals + surfaced slots.
 * Value 0–1 scaled by complexity.
 *
 * @param {string} eventId
 * @param {string} userId
 * @returns {{ value: number|null, confidence: number, inputs: object }}
 */
function estimateOrganizerLabor(eventId, userId) {
  const db = _getDb();
  const inputs = { eventId, userId };

  // Look up proposals linked to this event
  const proposals = db._raw()
    .prepare(`SELECT * FROM proposals WHERE event_id = ?`)
    .all(eventId);

  if (!proposals.length) {
    // Try by cadence linkage (a nudge that led to this plan)
    const cadence = cadenceFor(eventId, userId);
    if (cadence) {
      const cadenceProposals = db._raw()
        .prepare(`SELECT * FROM proposals WHERE cadence_id = ? ORDER BY proposed_at DESC LIMIT 5`)
        .all(cadence.id);
      proposals.push(...cadenceProposals);
    }
  }

  // Count total surfaced slots as a proxy for rounds
  let totalSlots = 0;
  for (const p of proposals) {
    try {
      const slots = p.surfaced_slots ? JSON.parse(p.surfaced_slots) : [];
      totalSlots += Array.isArray(slots) ? slots.length : 0;
    } catch (_) { /* parse error — skip */ }
  }

  const rounds = proposals.length;
  // Complexity scale: 1 round = 0.3, 2 rounds = 0.6, 3+ = 0.9
  const value = Math.min(rounds * 0.3 + totalSlots * 0.05, 1);

  return {
    value,
    confidence: 0.6,
    inputs: { ...inputs, proposal_count: rounds, total_slots: totalSlots },
  };
}

/**
 * estimateQuality — repeat attendance: earlier plans this user made it to with someone
 * from this plan. Returns null if <2 data points.
 *
 * @param {string} eventId
 * @param {string} userId
 * @returns {{ value: number|null, confidence: number, inputs: object }}
 */
function estimateQuality(eventId, userId) {
  const db = _getDb();
  const inputs = { eventId, userId };
  const phones = peopleIn(eventId, userId);
  if (!phones.length) return { value: null, confidence: 0, inputs: { ...inputs, reason: 'no_people' } };

  const priorCount = db._raw().prepare(`
      SELECT COUNT(DISTINCT ac.event_id) AS cnt FROM attendance_confirmations ac
      JOIN social_events se ON se.id = ac.event_id
      WHERE ac.user_id = ? AND ac.attended = 1 AND ac.event_id != ?
        AND (se.host_user_id IN (SELECT id FROM users WHERE phone IN (${phones.map(() => '?').join(',')}))
          OR EXISTS (SELECT 1 FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
            WHERE ei.event_id = se.id AND ei.status = 'accepted' AND c.phone IN (${phones.map(() => '?').join(',')})))`)
    .get(userId, eventId, ...phones, ...phones)?.cnt || 0;

  if (priorCount < 2) {
    return { value: null, confidence: 0, inputs: { ...inputs, prior_attended: priorCount, reason: 'insufficient_data' } };
  }

  // Simple quality signal: normalize prior attendance to 0–1 (cap at 10)
  const value = Math.min(priorCount / 10, 1);
  return {
    value,
    confidence: 0.5 + Math.min(priorCount / 20, 0.4), // more data → higher confidence
    inputs: { ...inputs, prior_attended: priorCount, people: phones.length },
  };
}

/**
 * estimateDiscovery — STUB: blocked on MEMORY.md §5 Q2 [OPEN].
 * Needs cross-user redundancy divisor K.
 *
 * @param {string} eventId
 * @param {string} userId
 * @returns {{ value: null, confidence: number, inputs: object }}
 */
function estimateDiscovery(eventId, userId) {
  // TODO: blocked on MEMORY.md §5 Q2 [OPEN] — needs cross-user redundancy divisor K
  console.log(`[lift] estimateDiscovery STUB: blocked on MEMORY.md §5 Q2 [OPEN] — needs cross-user redundancy divisor K`);
  return { value: null, confidence: 0, inputs: { eventId, userId, stub: true } };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * computeAndLogLift — orchestrate all estimators, log each to lift_observations.
 * Returns array of {estimator, value, confidence}.
 *
 * @param {string} eventId
 * @param {string} userId
 * @returns {Promise<Array<{estimator: string, value: number|null, confidence: number}>>}
 */
async function computeAndLogLift(eventId, userId) {
  const db = _getDb();
  const results = [];

  // Resolve cadence for activation estimator (through the people in the plan)
  const cadenceId = cadenceFor(eventId, userId)?.id || null;

  const estimators = [
    { name: 'activation',      fn: () => estimateActivation(eventId, userId, cadenceId) },
    { name: 'assembly',        fn: () => estimateAssembly(eventId, userId) },
    { name: 'organizer_labor', fn: () => estimateOrganizerLabor(eventId, userId) },
    { name: 'quality',         fn: () => estimateQuality(eventId, userId) },
    { name: 'discovery',       fn: () => estimateDiscovery(eventId, userId) },
  ];

  for (const { name, fn } of estimators) {
    try {
      const { value, confidence, inputs } = fn();

      // inputs field is MANDATORY on every observation (TOKEN.md §11.4)
      db.appendLiftObservation({
        event_id:   eventId,
        user_id:    userId,
        estimator:  name,
        value:      value,
        confidence: confidence,
        inputs:     inputs || {},
      });

      results.push({ estimator: name, value, confidence });
    } catch (err) {
      console.error(`[lift] estimator=${name} error:`, err.message);
      results.push({ estimator: name, value: null, confidence: 0 });
    }
  }

  return results;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  computeAndLogLift,
  cadenceFor,
  estimateActivation,
  estimateAssembly,
  estimateOrganizerLabor,
  estimateQuality,
  estimateDiscovery,
};
