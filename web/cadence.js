/**
 * ButterflAI cadence nudge engine
 *
 * Periodically scans all active cadences to find relationships that are overdue
 * for an activity, then surfaces a nudge to the user via SMS.
 *
 * The nudge is NOT a push to a contact — it's a prompt to the user:
 * "It's been a while with Kaylee — want me to set something up?"
 * The user replies yes/no; if yes, the agent loop in agent.js handles the rest.
 *
 * Frequency map (days between activities):
 *   weekly    →  7 days
 *   biweekly  → 14 days
 *   monthly   → 30 days
 *   quarterly → 90 days
 *
 * Nudge fires when:  now > last_fulfilled_at + frequency_days * NUDGE_THRESHOLD
 * NUDGE_THRESHOLD = 0.9 (nudge slightly before deadline, not after it)
 *
 * Nudge cooldown: once a nudge has been sent for a cadence, don't send another
 * for that cadence until the cadence is fulfilled OR the snooze window passes.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const sms = require('./sms');

const NUDGE_THRESHOLD = parseFloat(process.env.NUDGE_THRESHOLD || '0.9');
const NUDGE_INTERVAL_MS = parseInt(process.env.NUDGE_INTERVAL_MS || String(4 * 60 * 60 * 1000), 10); // 4h

const FREQUENCY_DAYS = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 90,
};

// ── Nudge state (persisted in DB via cadences table) ─────────────────────────
// We track last_nudge_sent_at on the cadence row to enforce cooldown.
// We add this column lazily if it doesn't exist.

function ensureNudgeColumn() {
  try {
    db._raw().exec('ALTER TABLE cadences ADD COLUMN last_nudge_sent_at INTEGER');
  } catch (_) { /* already exists */ }
}

// ── Core nudge logic ──────────────────────────────────────────────────────────

function secondsUntilDue(cadence) {
  const freqDays = FREQUENCY_DAYS[cadence.frequency] || 90;
  const freqSecs = freqDays * 86400;

  if (!cadence.last_fulfilled_at) {
    // Never done — treat as overdue from creation date
    const ageSecs = Math.floor(Date.now() / 1000) - cadence.created_at;
    return freqSecs - ageSecs;
  }

  const elapsed = Math.floor(Date.now() / 1000) - cadence.last_fulfilled_at;
  return freqSecs - elapsed;
}

function isNudgeDue(cadence) {
  const freqDays = FREQUENCY_DAYS[cadence.frequency] || 90;
  const freqSecs = freqDays * 86400;
  const nudgeWindowSecs = freqSecs * NUDGE_THRESHOLD;
  const secondsLeft = secondsUntilDue(cadence);

  // Due for a nudge if past the threshold
  if (secondsLeft > freqSecs * (1 - NUDGE_THRESHOLD)) return false;

  // Cooldown: don't re-nudge within 48h of the last nudge for this cadence
  if (cadence.last_nudge_sent_at) {
    const cooldownSecs = 48 * 3600;
    const sinceLastNudge = Math.floor(Date.now() / 1000) - cadence.last_nudge_sent_at;
    if (sinceLastNudge < cooldownSecs) return false;
  }

  return true;
}

function buildNudgeText(cadence, contactName) {
  const freqDays = FREQUENCY_DAYS[cadence.frequency] || 90;
  const secsLeft = secondsUntilDue(cadence);
  const daysOverdue = Math.round(-secsLeft / 86400);
  const freqLabel = cadence.frequency || 'regular';
  const activityLabel = cadence.activity_type || 'catch up';

  if (daysOverdue > 0) {
    return (
      `Hey — it's been a while with ${contactName}. ` +
      `You aimed for ${freqLabel} ${activityLabel}s and you're ${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} past due. ` +
      `Want me to set something up? Reply yes/no.`
    );
  } else {
    const daysUntil = Math.round(secsLeft / 86400);
    return (
      `Heads up — your ${freqLabel} ${activityLabel} with ${contactName} is coming up ` +
      `(${daysUntil} day${daysUntil !== 1 ? 's' : ''} away). ` +
      `Want me to start coordinating? Reply yes/no.`
    );
  }
}

// ── Scan all users ────────────────────────────────────────────────────────────

async function runNudgeScan() {
  const allUsers = db._raw()
    .prepare(`SELECT * FROM users WHERE onboarding_state = 'complete' AND phone IS NOT NULL`)
    .all();

  for (const user of allUsers) {
    await nudgeUser(user);
  }
}

async function nudgeUser(user) {
  const cadences = db.getCadencesByUser(user.id);

  for (const cadence of cadences) {
    if (!isNudgeDue(cadence)) continue;

    // Resolve contact name
    const rel = db._raw()
      .prepare('SELECT * FROM relationships WHERE id = ?')
      .get(cadence.relationship_id);
    if (!rel) continue;

    const contact = db.getContact(rel.contact_id);
    const contactName = contact?.name || 'your friend';

    const nudgeText = buildNudgeText(cadence, contactName);

    try {
      await sms.notifyUser(user.phone, nudgeText);

      // Record nudge timestamp
      db._raw()
        .prepare(`UPDATE cadences SET last_nudge_sent_at = ? WHERE id = ?`)
        .run(Math.floor(Date.now() / 1000), cadence.id);

      // Store pending action so the agent knows what "yes" refers to
      db.createPendingAction({
        id: uuidv4(),
        user_id: user.id,
        action_type: 'nudge_confirm',
        payload: {
          cadence_id: cadence.id,
          contact_id: rel.contact_id,
          contact_name: contactName,
          activity_type: cadence.activity_type,
          frequency: cadence.frequency,
        },
        ttl_secs: 48 * 3600,  // expires in 48h
      });

      console.log(`[cadence] nudged user=${user.id} cadence=${cadence.id} contact=${contactName}`);
    } catch (err) {
      console.error(`[cadence] nudge failed user=${user.id}:`, err.message);
    }
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function startNudgeLoop() {
  ensureNudgeColumn();
  console.log(`[cadence] nudge loop starting (interval=${NUDGE_INTERVAL_MS / 3600000}h)`);
  setInterval(runNudgeScan, NUDGE_INTERVAL_MS);
  runNudgeScan(); // immediate first run
}

module.exports = { startNudgeLoop, runNudgeScan, isNudgeDue, buildNudgeText };
