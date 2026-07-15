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
 */

'use strict';

function _getDb() {
  return require('./db');
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

  // Look up cadence for this event to get group_size baseline
  const activityRow = db._raw()
    .prepare('SELECT * FROM activities WHERE id = ?')
    .get(eventId);

  let expectedSize = 2; // default: one_on_one = 2 people
  if (activityRow?.cadence_id) {
    const cadence = db._raw()
      .prepare('SELECT group_size FROM cadences WHERE id = ?')
      .get(activityRow.cadence_id);
    if (cadence?.group_size === 'small_group') expectedSize = 4;
    else if (cadence?.group_size === 'large_group') expectedSize = 8;
  }

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
    // Try by cadence linkage
    const activity = db._raw()
      .prepare('SELECT cadence_id FROM activities WHERE id = ?')
      .get(eventId);
    if (activity?.cadence_id) {
      const cadenceProposals = db._raw()
        .prepare(`SELECT * FROM proposals WHERE cadence_id = ? ORDER BY proposed_at DESC LIMIT 5`)
        .all(activity.cadence_id);
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
 * estimateQuality — repeat attendance (same user, same cadence, attended=1 in past).
 * Returns null if <2 data points.
 *
 * @param {string} eventId
 * @param {string} userId
 * @returns {{ value: number|null, confidence: number, inputs: object }}
 */
function estimateQuality(eventId, userId) {
  const db = _getDb();
  const inputs = { eventId, userId };

  // Get cadence for this event
  const activity = db._raw()
    .prepare('SELECT cadence_id FROM activities WHERE id = ?')
    .get(eventId);

  if (!activity?.cadence_id) {
    return { value: null, confidence: 0, inputs: { ...inputs, reason: 'no_cadence' } };
  }

  // Count prior attended events for this user on this cadence
  const priorRow = db._raw()
    .prepare(`
      SELECT COUNT(*) as cnt
      FROM attendance_confirmations ac
      JOIN activities a ON ac.event_id = a.id
      WHERE ac.user_id = ?
        AND a.cadence_id = ?
        AND ac.attended = 1
        AND ac.event_id != ?
    `)
    .get(userId, activity.cadence_id, eventId);

  const priorCount = priorRow?.cnt || 0;

  if (priorCount < 2) {
    return { value: null, confidence: 0, inputs: { ...inputs, prior_attended: priorCount, reason: 'insufficient_data' } };
  }

  // Simple quality signal: normalize prior attendance to 0–1 (cap at 10)
  const value = Math.min(priorCount / 10, 1);
  return {
    value,
    confidence: 0.5 + Math.min(priorCount / 20, 0.4), // more data → higher confidence
    inputs: { ...inputs, prior_attended: priorCount, cadence_id: activity.cadence_id },
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

  // Resolve cadence for activation estimator
  const activity = db._raw()
    .prepare('SELECT cadence_id FROM activities WHERE id = ?')
    .get(eventId);
  const cadenceId = activity?.cadence_id || null;

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
  estimateActivation,
  estimateAssembly,
  estimateOrganizerLabor,
  estimateQuality,
  estimateDiscovery,
};
