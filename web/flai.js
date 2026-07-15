/**
 * FLAI token module — burn metering, throttle stubs, earn-rate cap stub.
 *
 * Hard rules (TOKEN.md §0):
 *  - Never mint payout. Compute Lift, log it, pay NOTHING.
 *  - Never surface FLAI balance, streak, or score to users.
 *  - Never make FLAI transferable.
 *  - Never write to a chain.
 *
 * Everything in this module is STUB / permissive until launch calibration.
 */

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────

// provisional — adjust before launch
const BURN_RATES = {
  'burn:llm': 5,   // FLAI per LLM call
  'burn:sms': 1,   // FLAI per SMS
  'burn:places': 2, // FLAI per Places API call
};

const BASELINE_GRANT = 100;  // tokens granted to new users on creation
const EARN_RATE_CAP  = 500;  // stub only — not enforced yet

// ── DB reference (lazy to avoid circular deps) ────────────────────────────────

function _getDb() {
  return require('./db');
}

// ── burnForUser ───────────────────────────────────────────────────────────────

/**
 * Append a negative delta to the FLAI ledger for a burn event.
 * NEVER throws — all errors are caught and logged.
 * STUB: does not throttle even if balance goes negative.
 *
 * @param {string|null} userId  - user ID or null if unknown at call site
 * @param {string}      reason  - e.g. 'burn:llm', 'burn:sms'
 * @param {object}      opts    - { ref_id, metadata }
 */
async function burnForUser(userId, reason, opts = {}) {
  try {
    const rate = BURN_RATES[reason] || 1;
    const delta = -rate;

    const db = _getDb();
    db.appendFlaiLedger({
      user_id:  userId,
      delta,
      reason,
      ref_id:   opts.ref_id   || null,
      metadata: opts.metadata || {},
    });

    // Stub throttle check — log what would happen but do NOT throttle
    if (userId) {
      try {
        const balance = db.getFlaiBalance(userId);
        if (balance < 0) {
          console.log(`[flai] STUB: user=${userId} balance=${balance} would throttle at reason=${reason} — NOT throttling (stub)`);
        }
      } catch (balErr) {
        // balance check is best-effort
      }
    }
  } catch (err) {
    console.error(`[flai] burnForUser error (non-fatal): userId=${userId} reason=${reason}:`, err.message);
  }
}

// ── checkThrottle ─────────────────────────────────────────────────────────────

/**
 * STUB: always returns {throttled: false, level: 'full'}.
 * Logs what it would do when balance is low.
 *
 * @param {string} userId
 * @returns {{ throttled: boolean, level: string }}
 */
async function checkThrottle(userId) {
  try {
    const balance = _getDb().getFlaiBalance(userId);
    if (balance < 0) {
      console.log(`[flai] STUB checkThrottle: user=${userId} balance=${balance} — would throttle but returning full (stub)`);
    }
  } catch (_) { /* non-fatal */ }
  return { throttled: false, level: 'full' };
}

// ── capEarnRate ────────────────────────────────────────────────────────────────

/**
 * STUB: returns proposed unchanged.
 * Will enforce EARN_RATE_CAP before launch.
 *
 * @param {string} userId
 * @param {number} proposed
 * @returns {number}
 */
function capEarnRate(userId, proposed) {
  // STUB: no cap enforced yet — return as-is
  return proposed;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  BURN_RATES,
  BASELINE_GRANT,
  EARN_RATE_CAP,
  burnForUser,
  checkThrottle,
  capEarnRate,
};
