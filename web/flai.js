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

const BASELINE_GRANT  = 100;  // tokens granted to new users on creation
const EARN_RATE_CAP   = 500;  // stub only — not enforced yet
const REFERRAL_GRANT  = 50;   // FLAI credited to referrer when referred user completes onboarding

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

// ── grantReferral ─────────────────────────────────────────────────────────────

/**
 * Credit referrer when a referred user completes onboarding.
 * SMS copy is capability language only — never mentions FLAI by name or amount.
 * @param {string} referrerUserId
 * @param {string} referredUserId
 */
async function grantReferral(referrerUserId, referredUserId) {
  try {
    const db = _getDb();

    // 1. Credit referrer's ledger
    db.appendFlaiLedger({
      user_id:  referrerUserId,
      delta:    REFERRAL_GRANT,
      reason:   'referral_grant',
      ref_id:   referredUserId,
      metadata: {},
    });

    // 2. Mark referral as rewarded
    const referral = db._raw()
      .prepare('SELECT * FROM referrals WHERE referrer_user_id = ? AND referred_user_id = ?')
      .get(referrerUserId, referredUserId);
    if (referral) db.rewardReferral(referral.id);

    // 3. Notify referrer via SMS — capability language ONLY, no FLAI mention
    const referrer = db.getUser(referrerUserId);
    const referred = db.getUser(referredUserId);
    if (referrer?.phone) {
      const sms = require('./sms');
      const name = referred?.name || 'Your friend';
      await sms.notifyUser(
        referrer.phone,
        `${name} just joined ButterflAI. 🦋 Your agent has more room to work this month — thanks for spreading the word!`,
      ).catch(err => console.error('[referral] SMS notify failed:', err.message));
    }
  } catch (err) {
    console.error('[referral] grantReferral error (non-fatal):', err.message);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  BURN_RATES,
  BASELINE_GRANT,
  EARN_RATE_CAP,
  REFERRAL_GRANT,
  burnForUser,
  checkThrottle,
  capEarnRate,
  grantReferral,
};
