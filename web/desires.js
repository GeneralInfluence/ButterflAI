'use strict';

/**
 * desires.js — Parse, store, manage, and delete user desires
 *
 * ── Time horizons ──────────────────────────────────────────────────────────
 *   one_off   — single instance (e.g. "watch this band tonight")
 *               Also triggers a preference update for the general pattern.
 *   recurring — repeats each period (e.g. "lunch once a week with a friend")
 *               Stored as a 'template' that spawns new one_off instances each window.
 *   template  — parent of recurring instances; never directly coordinated.
 *
 * ── Candidate strategies ───────────────────────────────────────────────────
 *   specific       — user named contacts ("Marcus or Priya")
 *   tier           — "any close friend" → probe Tier 1+ by recency/cadence
 *   interest_match — "someone who's into this" → match by activity preference
 *   any            — broadest net, any willing Tier 1+ contact
 *
 *   When strategy ≠ specific, the desire stays 'pending' and the agent loop
 *   selects and probes candidates autonomously — no follow-up SMS needed.
 *
 * ── Privacy ────────────────────────────────────────────────────────────────
 *   raw_text is zeroed (overwritten with '') immediately after parsing.
 *   Structured fields (enums/integers/dates) are what persist and travel.
 *   The coord_desires VIEW already excludes raw_text from coordination.js,
 *   but deletion is the stronger guarantee.
 *
 *   Users can hard-delete all their desires at any time. Deletion cancels
 *   in-flight coordination sessions, notifies peer agents, and returns a receipt.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const db  = require('./db');
const msg = require('./mcp-messages');
const { CATEGORIES, ACTIVITY_TYPES } = require('./mcp-messages');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.AGENT_MODEL || 'claude-3-5-haiku-20241022';

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse free-text desires into structured records.
 * Returns only typed/enum fields — no user-generated text in output.
 *
 * @param {string} rawText
 * @param {string} [windowStart] YYYY-MM-DD
 * @param {string} [windowEnd]   YYYY-MM-DD
 * @returns {ParsedDesire[]}
 */
async function parseDesires(rawText, windowStart, windowEnd) {
  const today    = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
  const start    = windowStart || today;
  const end      = windowEnd   || nextWeek;

  const prompt = `
You are a desire parser. The user has described what they want to do.
Extract each distinct desire and return a JSON array. Follow the schema exactly.

USER INPUT: "${rawText.replace(/"/g, "'")}"
DEFAULT TIME WINDOW: ${start} to ${end}

Return ONLY a JSON array. No explanation, no markdown, just the array.

Each item must have EXACTLY these fields:
{
  "type": "solo" | "social" | "protective",
  "horizon": "one_off" | "recurring",
  "recurrence": "none" | "weekly" | "biweekly" | "monthly",
  "category": one of [${CATEGORIES.join(', ')}],
  "activity_type": one of [${ACTIVITY_TYPES.join(', ')}],
  "social_size_min": integer,
  "social_size_max": integer,
  "frequency": integer (times per window; default 1),
  "priority": "must" | "want" | "nice_to_have",
  "candidate_strategy": "specific" | "tier" | "interest_match" | "any",
  "candidate_tier_min": integer (1 = close friends, 0 = anyone; only for non-specific strategies),
  "time_window_start": "YYYY-MM-DD",
  "time_window_end": "YYYY-MM-DD",
  "also_updates_preference": true | false
}

Rules:
- type: "solo"=alone, "social"=needs others, "protective"=keep time free
- horizon: "one_off" for a single instance, "recurring" if they say "every week", "every month", etc.
- recurrence: "none" unless horizon is recurring (then match the period they said)
- category: working out/gym/yoga → active; dinner/lunch/brunch → dining; live music/concert → live_music;
  dancing/club → dancing; drinks/bar → drinks; hiking/park → outdoor; general social → social;
  relaxing/chill/rest → chill; sports/game → sports; museum/gallery/film → culture
- candidate_strategy:
    "specific" — they named someone ("with Marcus", "with Priya or Sam")
    "tier"     — "close friends", "a friend", "some friends" (no names given)
    "interest_match" — "someone who's into this", "someone who likes X"
    "any"      — "I'm not picky", "anyone", "whoever's free"
- candidate_tier_min: 1 for "close friends", 0 for "anyone"
- social_size: for "a friend or two" → min=1 max=2; "a couple friends" → min=2 max=3; "a friend" → min=1 max=1; solo/protective → 0,0
- also_updates_preference: true if the desire reveals a general interest (e.g. "I enjoy live music" or "watch this band" → true for live_music preference)
- time_window: use the default window unless the user specified a specific date/event
  For specific events ("tonight", "this Friday"), set a tight window (same day or 1-2 days)
  For recurring desires, set window to cover the first instance only; more instances spawn automatically

CRITICAL: Do NOT include any user names, venue names, band names, or free-text strings in any field.
All string fields must be one of the allowed enum values or a YYYY-MM-DD date.
`.trim();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = response.content.find(b => b.type === 'text')?.text?.trim() || '[]';

  let parsed;
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error('[desires] JSON parse failed:', err.message, '\nRaw:', raw.slice(0, 200));
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.map(sanitizeDesire).filter(Boolean);
}

/**
 * Validate and sanitize one parsed desire.
 * Rejects anything with invalid enums, bad types, or unexpected free-text strings.
 * Returns null if invalid.
 */
function sanitizeDesire(item) {
  try {
    if (!['solo', 'social', 'protective'].includes(item.type)) return null;
    if (!['one_off', 'recurring'].includes(item.horizon)) return null;
    if (!['none', 'weekly', 'biweekly', 'monthly'].includes(item.recurrence)) return null;
    if (!CATEGORIES.includes(item.category)) return null;
    if (!ACTIVITY_TYPES.includes(item.activity_type)) return null;
    if (!['specific', 'tier', 'interest_match', 'any'].includes(item.candidate_strategy)) return null;
    if (!['must', 'want', 'nice_to_have'].includes(item.priority)) return null;

    const sizeMin = parseInt(item.social_size_min, 10);
    const sizeMax = parseInt(item.social_size_max, 10);
    if (isNaN(sizeMin) || isNaN(sizeMax) || sizeMin < 0 || sizeMax < sizeMin) return null;

    const frequency = parseInt(item.frequency, 10);
    if (isNaN(frequency) || frequency < 1) return null;

    const tierMin = parseInt(item.candidate_tier_min ?? 1, 10);
    if (isNaN(tierMin) || tierMin < 0) return null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.time_window_start)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.time_window_end))   return null;

    return {
      type:               item.type,
      horizon:            item.horizon,
      recurrence:         item.recurrence,
      category:           item.category,
      activityType:       item.activity_type,
      sizeMin,
      sizeMax,
      frequency,
      priority:           item.priority,
      candidateStrategy:  item.candidate_strategy,
      candidateTierMin:   tierMin,
      windowStart:        item.time_window_start,
      windowEnd:          item.time_window_end,
      alsoUpdatesPreference: !!item.also_updates_preference
    };
  } catch {
    return null;
  }
}

// ─── Storage ──────────────────────────────────────────────────────────────────

/**
 * Parse raw text, store all desires, and zero raw_text immediately after.
 * Returns a summary for the agent to present to the user.
 *
 * @param {string} userId
 * @param {string} rawText
 * @param {string} [windowStart]
 * @param {string} [windowEnd]
 * @param {string[]} [candidateIds] - specific contact IDs (when strategy is 'specific')
 * @returns {{ desires: StoredDesire[], preferenceUpdates: string[], summary: string }}
 */
async function parseAndStore(userId, rawText, windowStart, windowEnd, candidateIds = []) {
  const parsed = await parseDesires(rawText, windowStart, windowEnd);

  if (!parsed.length) {
    return {
      desires: [],
      preferenceUpdates: [],
      summary: "I couldn't make out any specific desires — could you rephrase that?"
    };
  }

  const stored = [];
  const preferenceUpdates = [];

  for (const d of parsed) {
    const id = uuidv4();

    // Horizon: recurring desires are stored as templates; one_off as instances
    const horizon = d.horizon;
    const isRecurring = horizon === 'recurring';

    db.createDesire({
      id,
      userId,
      rawText,                          // stored for a moment, then zeroed below
      category:           d.category,
      activityType:       d.activityType,
      socialSizeMin:      d.sizeMin,
      socialSizeMax:      d.sizeMax,
      windowStart:        d.windowStart,
      windowEnd:          d.windowEnd,
      priority:           d.priority,
      candidateStrategy:  d.candidateStrategy,
      candidateIds:       candidateIds.length ? JSON.stringify(candidateIds) : null,
      candidateTierMin:   d.candidateTierMin,
      recurrence:         d.recurrence,
      horizon:            isRecurring ? 'template' : 'one_off'
    });

    // Zero raw_text immediately — we have everything we need in structured fields
    db.zeroDesireRawText(id);

    stored.push({ id, ...d });

    // Track which categories reveal general preferences (for preference update advice)
    if (d.alsoUpdatesPreference) {
      preferenceUpdates.push(d.category);
    }
  }

  return {
    desires: stored,
    preferenceUpdates,
    summary: buildSummary(stored, candidateIds)
  };
}

// ─── Recurring desire instances ───────────────────────────────────────────────

/**
 * Spawn a new one_off instance from a recurring template for the given window.
 * Called by the agent loop each period.
 *
 * @param {string} templateId
 * @param {string} windowStart YYYY-MM-DD
 * @param {string} windowEnd   YYYY-MM-DD
 * @returns {string} new desire id
 */
function spawnRecurringInstance(templateId, windowStart, windowEnd) {
  const template = db.getCoordDesire(templateId);
  if (!template) throw new Error(`Template desire ${templateId} not found`);

  const id = uuidv4();
  db.createDesire({
    id,
    userId:           template.user_id,
    rawText:          '',               // instances have no raw_text
    category:         template.category,
    activityType:     template.activity_type,
    socialSizeMin:    template.social_size_min,
    socialSizeMax:    template.social_size_max,
    windowStart,
    windowEnd,
    priority:         template.priority,
    candidateStrategy: template.candidate_strategy,
    candidateIds:     template.candidate_ids,
    candidateTierMin: template.candidate_tier_min,
    recurrence:       'none',
    horizon:          'one_off',
    parentDesireId:   templateId
  });
  db.zeroDesireRawText(id); // already empty, but consistent

  return id;
}

/**
 * Get recurring templates due for a new instance.
 * A template is due when its last instance is within the current window
 * or no instances have been spawned yet.
 */
function getDueRecurringTemplates(userId) {
  return db.getDueRecurringTemplates(userId);
}

// ─── Candidate selection (vague strategies) ───────────────────────────────────

/**
 * Resolve candidates for a desire when strategy ≠ 'specific'.
 * Returns contact IDs to probe, ordered by:
 *   1. Cadence due (most overdue first)
 *   2. Tier (higher = closer)
 *   3. Last contact (longest ago first)
 *
 * @param {string} userId
 * @param {object} desire       - coord_desires row
 * @param {number} [maxProbe=5] - max candidates to probe in parallel
 * @returns {string[]} contact IDs
 */
function resolveCandidates(userId, desire, maxProbe = 5) {
  const strategy  = desire.candidate_strategy || 'tier';
  const tierMin   = desire.candidate_tier_min ?? 1;
  const contacts  = db.getContactsByUser(userId);

  if (strategy === 'specific') {
    try { return JSON.parse(desire.candidate_ids || '[]'); } catch { return []; }
  }

  // Filter by tier
  let candidates = contacts.filter(c => (c.tier || 0) >= tierMin);

  if (strategy === 'interest_match') {
    // Filter to contacts who have a matching activity preference stored
    // (requires contact_preferences.activity_loves to be set)
    // For now: fall back to tier — full match requires cross-referencing contact prefs
    // TODO: join with contact_preferences when interest data is richer
  }

  // Sort: most cadence-overdue first, then by tier desc, then by last_contact asc
  const cadences = db.getCadencesByUser(userId);
  const cadenceMap = new Map(cadences.map(c => [c.contact_id || c.relationship_id, c]));

  candidates.sort((a, b) => {
    const ca = cadenceMap.get(a.id);
    const cb = cadenceMap.get(b.id);
    const overdueA = ca?.next_target_at ? (Date.now() / 1000 - ca.next_target_at) : 0;
    const overdueB = cb?.next_target_at ? (Date.now() / 1000 - cb.next_target_at) : 0;
    if (overdueB !== overdueA) return overdueB - overdueA; // more overdue first
    if ((b.tier || 0) !== (a.tier || 0)) return (b.tier || 0) - (a.tier || 0); // higher tier first
    return 0;
  });

  return candidates.slice(0, maxProbe).map(c => c.id);
}

// ─── Deletion (hard delete with receipt) ──────────────────────────────────────

/**
 * Delete all desires for a user.
 *   - Cancels any in-flight coordination sessions (sends buildCancel to peer agents)
 *   - Hard-deletes all desire records
 *   - Writes a deletion receipt to desire_deletions
 *
 * @param {string} userId
 * @param {object} transport - MCP transport for sending cancel messages
 * @returns {{ deleted: number, sessionsCancelled: number, receiptId: string }}
 */
async function deleteAllDesires(userId, transport) {
  return _deleteDesires(userId, null, transport);
}

/**
 * Delete a single desire by ID.
 * Only deletes if the desire belongs to userId (ownership check).
 */
async function deleteDesire(userId, desireId, transport) {
  return _deleteDesires(userId, desireId, transport);
}

async function _deleteDesires(userId, desireId, transport) {
  // Get desires to delete
  const toDelete = desireId
    ? [db._raw().prepare('SELECT * FROM desires WHERE id = ? AND user_id = ?').get(desireId, userId)]
        .filter(Boolean)
    : db._raw().prepare('SELECT * FROM desires WHERE user_id = ?').all(userId);

  if (!toDelete.length) {
    return { deleted: 0, sessionsCancelled: 0, receiptId: null };
  }

  const desireIds = toDelete.map(d => d.id);
  let sessionsCancelled = 0;

  // Cancel any in-flight coordination sessions for these desires
  for (const did of desireIds) {
    const sessions = db._raw().prepare(
      "SELECT * FROM coordination_sessions WHERE desire_id = ? AND state NOT IN ('scheduled','dropped','cancelled')"
    ).all(did);

    for (const session of sessions) {
      const peers = db.getCoordPeers(session.id);
      const activePeers = peers.filter(p =>
        !['not_interested', 'rejected', 'cancelled'].includes(p.state)
      );

      if (transport) {
        const cancelMsg = msg.buildCancel();
        for (const peer of activePeers) {
          try {
            msg.sendCoordMessage(transport, {
              sessionId: session.id,
              fromAgent: process.env.AGENT_ID || 'butterflai-default',
              toAgent:   peer.peer_agent_id,
              round:     session.round || 1,
              expiresAt: session.expires_at
            }, cancelMsg);
          } catch (e) {
            console.error('[desires] cancel send failed:', e.message);
          }
        }
      }

      db._raw().prepare(
        "UPDATE coordination_sessions SET state = 'cancelled', updated_at = strftime('%s','now') WHERE id = ?"
      ).run(session.id);
      sessionsCancelled++;
    }
  }

  // Hard-delete the desire records
  const placeholders = desireIds.map(() => '?').join(',');
  db._raw().prepare(`DELETE FROM desires WHERE id IN (${placeholders})`).run(...desireIds);

  // Write deletion receipt
  const receiptId = uuidv4();
  db._raw().prepare(
    'INSERT INTO desire_deletions (id, user_id, desire_count, session_count) VALUES (?, ?, ?, ?)'
  ).run(receiptId, userId, desireIds.length, sessionsCancelled);

  return { deleted: desireIds.length, sessionsCancelled, receiptId };
}

// ─── Summary builder ──────────────────────────────────────────────────────────

function buildSummary(desires, candidateIds = []) {
  const solo       = desires.filter(d => d.type === 'solo');
  const social     = desires.filter(d => d.type === 'social');
  const protective = desires.filter(d => d.type === 'protective');

  const lines = ["Got it. Here's what I've logged:"];

  for (const d of solo) {
    const times = d.frequency > 1 ? ` ×${d.frequency}` : '';
    const freq  = d.horizon === 'recurring' ? ` (${d.recurrence})` : '';
    lines.push(`  ✓ ${_label(d.category)}${times}${freq} — I'll find slots on your calendar`);
  }
  for (const d of protective) {
    const freq = d.horizon === 'recurring' ? ` (${d.recurrence})` : '';
    lines.push(`  ✓ ${_label(d.category)} time blocked off${freq}`);
  }
  for (const d of social) {
    const size  = _sizeLabel(d.sizeMin, d.sizeMax);
    const times = d.frequency > 1 ? ` ×${d.frequency}` : '';
    const freq  = d.horizon === 'recurring' ? ` (${d.recurrence})` : '';
    const who   = _candidateHint(d.candidateStrategy, candidateIds);
    lines.push(`  ✓ ${_label(d.category)} with ${size}${times}${freq} — ${who}`);
  }

  // Advice on follow-up needed
  const needsNames = social.filter(d => d.candidateStrategy === 'specific' && !candidateIds.length);
  const willAutoProbe = social.filter(d => d.candidateStrategy !== 'specific');

  if (needsNames.length) {
    lines.push('');
    lines.push(needsNames.length === 1
      ? 'Who should I coordinate that one with?'
      : 'Who should I coordinate those with?');
  } else if (willAutoProbe.length) {
    lines.push('');
    lines.push("I'll reach out to some of your friends and let you know when something lines up.");
  }

  return lines.join('\n');
}

function _label(c) {
  return ({
    social: 'social outing', active: 'workout', dining: 'meal out',
    outdoor: 'outdoor activity', live_music: 'live music', dancing: 'dancing',
    drinks: 'drinks', chill: 'chill time', sports: 'sports', culture: 'cultural outing'
  })[c] || c;
}

function _sizeLabel(min, max) {
  if (min === 0 && max === 0) return 'yourself';
  if (min === 1 && max === 1) return '1 friend';
  if (min === 1 && max === 2) return 'a friend or two';
  if (min === 2 && max === 3) return 'a couple of friends';
  if (min === max) return `${min} friend${min > 1 ? 's' : ''}`;
  return `${min}–${max} friends`;
}

function _candidateHint(strategy, candidateIds) {
  if (strategy === 'specific' && candidateIds.length) return 'coordinating now';
  if (strategy === 'specific') return 'needs coordination — who?';
  if (strategy === 'tier') return "I'll reach out to close friends";
  if (strategy === 'interest_match') return "I'll find a friend who's into this";
  return "I'll find whoever's free";
}

// ─── Agent tool definitions ───────────────────────────────────────────────────

const TOOL_DEFINITION = {
  name: 'parse_desires',
  description: [
    'Parse and store desires for a time window.',
    'Call when the user expresses what they want to do: "work out twice, go out with a friend, chill night."',
    'Handles vague candidates ("any close friend"), recurring desires ("lunch every week"), and one-off events.',
    'raw_text is stored briefly for parsing then zeroed immediately — it never reaches coordination.',
    'Returns a summary + asks for clarification only when needed (e.g. specific person named but not in contacts).',
    'Do NOT call for a single specific plan already in motion — use create_social_event for that.'
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      raw_text: {
        type: 'string',
        description: "The user's desire statement. Stored briefly for parsing, then zeroed."
      },
      window_start: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
      window_end:   { type: 'string', description: 'YYYY-MM-DD. Defaults to 7 days from today.' },
      candidate_ids: {
        type: 'array', items: { type: 'string' },
        description: 'Contact IDs if the user named specific people. Omit for vague strategies.'
      }
    },
    required: ['raw_text']
  }
};

const DELETE_TOOL_DEFINITION = {
  name: 'delete_desires',
  description: [
    "Delete the user's stored desires. Hard-deletes records and cancels any in-flight coordination.",
    'Use when the user says "forget that", "cancel my plans", "delete my desires", or "erase everything".',
    'Returns a receipt. This is irreversible.'
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      desire_id: {
        type: 'string',
        description: 'Delete a single desire by ID. Omit to delete ALL desires.'
      },
      confirm: {
        type: 'boolean',
        description: 'Must be true to proceed. Ask the user to confirm before calling with confirm=true.'
      }
    },
    required: ['confirm']
  }
};

async function handleParseTool(input, userId) {
  const { raw_text, window_start, window_end, candidate_ids } = input;
  const result = await parseAndStore(userId, raw_text, window_start, window_end, candidate_ids || []);

  // If any desires reveal a general interest, flag it for the agent to also call update_preferences
  return {
    desires_stored:      result.desires.length,
    social_count:        result.desires.filter(d => d.type === 'social').length,
    solo_count:          result.desires.filter(d => d.type === 'solo').length,
    protective_count:    result.desires.filter(d => d.type === 'protective').length,
    recurring_count:     result.desires.filter(d => d.horizon === 'recurring').length,
    desire_ids:          result.desires.map(d => d.id),
    preference_updates:  result.preferenceUpdates, // agent should also call update_preferences with these
    needs_candidates:    result.desires.some(d => d.type === 'social' && d.candidateStrategy === 'specific' && !candidate_ids?.length),
    summary:             result.summary
  };
}

async function handleDeleteTool(input, userId, transport) {
  if (!input.confirm) {
    return { error: 'confirm must be true. Ask the user to confirm before deleting.' };
  }
  const result = await (input.desire_id
    ? deleteDesire(userId, input.desire_id, transport)
    : deleteAllDesires(userId, transport));

  return {
    deleted:           result.deleted,
    sessions_cancelled: result.sessionsCancelled,
    receipt_id:        result.receiptId,
    message: result.deleted
      ? `Done. Deleted ${result.deleted} desire${result.deleted > 1 ? 's' : ''}` +
        (result.sessionsCancelled ? ` and cancelled ${result.sessionsCancelled} coordination session${result.sessionsCancelled > 1 ? 's' : ''}.` : '.')
      : 'Nothing to delete.'
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  parseDesires,
  parseAndStore,
  spawnRecurringInstance,
  getDueRecurringTemplates,
  resolveCandidates,
  deleteAllDesires,
  deleteDesire,
  TOOL_DEFINITION,
  DELETE_TOOL_DEFINITION,
  handleParseTool,
  handleDeleteTool,
  // Testing
  sanitizeDesire,
  buildSummary
};
