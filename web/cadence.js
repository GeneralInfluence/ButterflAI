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
const lift = require('./lift');

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

      // Record proposal provenance (§2.2)
      try {
        db.createProposal({
          id: uuidv4(),
          user_id: user.id,
          cadence_id: cadence.id,
          origin: 'cadence_nudge',
          activity_type: cadence.activity_type,
          surfaced_slots: null,
        });
      } catch (proposalErr) {
        console.error(`[cadence] proposal record failed (non-fatal):`, proposalErr.message);
      }

      console.log(`[cadence] nudged user=${user.id} cadence=${cadence.id} contact=${contactName}`);
    } catch (err) {
      console.error(`[cadence] nudge failed user=${user.id}:`, err.message);
    }
  }
}

// ── Attendance gate (FLAI §2.1) ───────────────────────────────────────────────

/**
 * Run the attendance confirmation gate.
 * For each user, batch all pending events into ONE SMS.
 * Ask once only; never hard-block; skip = NULL (not failure).
 */
async function runAttendanceGate() {
  const allUsers = db._raw()
    .prepare(`SELECT * FROM users WHERE onboarding_state = 'complete' AND phone IS NOT NULL`)
    .all();

  for (const user of allUsers) {
    try {
      const pendingEvents = db.getPendingAttendanceConfirmations(user.id);
      if (!pendingEvents.length) continue;

      const now = Math.floor(Date.now() / 1000);
      const confirmations = [];

      for (const event of pendingEvents) {
        // Guard: never send a second confirmation for the same event
        const existing = db.getAttendanceConfirmation(event.id, user.id);
        if (existing) continue; // already asked

        const eventLabel = formatEventLabel(event, user.timezone);
        confirmations.push({
          id: uuidv4(),
          event_id: event.id,
          event_label: eventLabel,
        });
      }

      if (!confirmations.length) continue;

      // Build SMS message (batch all into one)
      let smsBody;
      if (confirmations.length === 1) {
        const c = confirmations[0];
        smsBody = `Did you make it to ${c.event_label}? (Y / N / skip)`;
      } else {
        const lines = confirmations.map((c, i) => `${i + 1}. ${c.event_label}`);
        smsBody = `Quick check-ins:\n${lines.join('\n')}\nReply 1Y 2N or skip`;
      }

      // Create attendance_confirmation rows first (ask_count=1)
      for (const c of confirmations) {
        db.createAttendanceConfirmation({
          id: c.id,
          event_id: c.event_id,
          user_id: user.id,
          asked_at: now,
          source: 'sms_gate',
        });
      }

      // Create pending_action so server.js can correlate the reply
      db.createPendingAction({
        id: uuidv4(),
        user_id: user.id,
        action_type: 'attendance_confirm',
        payload: { confirmations },
        ttl_secs: 7 * 24 * 3600, // 7 days
      });

      // Send SMS
      await sms.notifyUser(user.phone, smsBody);

      console.log(`[cadence] attendance gate sent user=${user.id} events=${confirmations.length}`);
    } catch (err) {
      console.error(`[cadence] attendance gate error user=${user.id}:`, err.message);
    }
  }
}

function formatEventLabel(event, timezone) {
  const type = event.activity_type || 'activity';
  if (event.scheduled_at) {
    const d = new Date(event.scheduled_at * 1000);
    // Render in the user's timezone, matching every sibling formatter (multiparty
    // formatEventDate, server formatEventDetails). Without timeZone, toLocaleDateString
    // uses the server's runtime zone and shows the wrong day-of-week/date.
    const day = d.toLocaleDateString('en-US', { timeZone: timezone || 'America/Los_Angeles', weekday: 'long', month: 'short', day: 'numeric' });
    return `${type} on ${day}`;
  }
  return type;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function startNudgeLoop() {
  ensureNudgeColumn();
  console.log(`[cadence] nudge loop starting (interval=${NUDGE_INTERVAL_MS / 3600000}h)`);
  setInterval(async () => {
    await runNudgeScan();
    await runAttendanceGate();
  }, NUDGE_INTERVAL_MS);
  // immediate first run
  runNudgeScan().then(() => runAttendanceGate()).catch(err => console.error('[cadence] initial run error:', err));
}

module.exports = { startNudgeLoop, runNudgeScan, runAttendanceGate, isNudgeDue, buildNudgeText, formatEventLabel };
