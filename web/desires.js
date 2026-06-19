'use strict';

/**
 * desires.js — Parse free-text user desires into structured records
 *
 * Flow:
 *   1. User tells agent what they want this week (free text)
 *   2. Agent calls parse_desires tool → this module calls Claude with a strict JSON prompt
 *   3. Claude returns structured desire objects (NEVER raw text reaching coordination)
 *   4. We store: raw_text (private, stays here) + structured fields (safe for coordination)
 *   5. Agent receives summary and asks who to coordinate with (social desires only)
 *   6. User names candidates → agent calls start_coordination
 *
 * Privacy note:
 *   raw_text is stored in the desires table and NEVER passed to coordination.js.
 *   The LLM parses it into enum/typed fields here, once, and those are what travel.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { CATEGORIES, ACTIVITY_TYPES } = require('./mcp-messages');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.AGENT_MODEL || 'claude-3-5-haiku-20241022';

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a free-text desire statement into structured desire objects.
 * Calls Claude with a strict schema; returns raw JSON — never stores free text in structured fields.
 *
 * @param {string} rawText   - e.g. "work out twice, go out with a friend or two, chill night"
 * @param {string} windowStart - YYYY-MM-DD (defaults to today)
 * @param {string} windowEnd   - YYYY-MM-DD (defaults to 7 days from now)
 * @returns {DesireRecord[]}
 */
async function parseDesires(rawText, windowStart, windowEnd) {
  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
  const start = windowStart || today;
  const end   = windowEnd   || nextWeek;

  const prompt = `
You are a desire parser. The user has described what they want to do this week.
Extract each distinct desire and return a JSON array. Follow the schema exactly.

USER INPUT: "${rawText.replace(/"/g, "'")}"
TIME WINDOW: ${start} to ${end}

Return ONLY a JSON array. No explanation, no markdown, just the array.

Each item must have these fields:
{
  "type": "solo" | "social" | "protective",
  "category": one of [${CATEGORIES.join(', ')}],
  "activity_type": one of [${ACTIVITY_TYPES.join(', ')}],
  "social_size_min": integer (0 for solo/protective),
  "social_size_max": integer (0 for solo/protective),
  "frequency": integer (how many times in the window; default 1),
  "priority": "must" | "want" | "nice_to_have",
  "time_window_start": "${start}",
  "time_window_end": "${end}"
}

Classification rules:
- "solo": activity done alone (working out, reading, journaling)
- "social": requires at least one other person to coordinate with
- "protective": time the user wants to keep free / low-key (chill night, rest day)

Category mapping (pick the closest):
- Working out, gym, running, yoga → "active"
- Dinner, lunch, brunch, food → "dining"
- Live music, concert, show → "live_music"
- Dancing, club, nightlife → "dancing"
- Drinks, bar, happy hour → "drinks"
- Hiking, park, outdoors → "outdoor"
- General socialising → "social"
- Relaxing, chill, rest, quiet → "chill"
- Sports, game, match → "sports"
- Museum, gallery, film → "culture"

Priority: "must" if they say definitely/definitely/have to, "want" for normal desires, "nice_to_have" for vague/optional.

For "a friend or two": social_size_min=1, social_size_max=2.
For "with a couple friends": social_size_min=2, social_size_max=3.
For "one friend": social_size_min=1, social_size_max=1.
For solo/protective: social_size_min=0, social_size_max=0.

Do NOT include any user-generated text, names, venue names, or reasons in any field.
All fields must be one of the allowed enum values, integers, or the date strings above.
`.trim();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = response.content.find(b => b.type === 'text')?.text?.trim() || '[]';

  let parsed;
  try {
    // Strip markdown code fences if the model added them
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error('[desires] JSON parse failed:', err.message, '\nRaw:', raw.slice(0, 200));
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.error('[desires] Expected array, got:', typeof parsed);
    return [];
  }

  // Validate and sanitize each item — reject any with invalid enums or unexpected string fields
  return parsed.map(sanitizeDesire).filter(Boolean);
}

/**
 * Validate and sanitize a parsed desire object.
 * Rejects anything with invalid enum values or free-text string fields.
 * Returns null if invalid.
 */
function sanitizeDesire(item) {
  try {
    const type = item.type;
    if (!['solo', 'social', 'protective'].includes(type)) return null;

    const category = item.category;
    if (!CATEGORIES.includes(category)) return null;

    const activityType = item.activity_type;
    if (!ACTIVITY_TYPES.includes(activityType)) return null;

    const sizeMin = parseInt(item.social_size_min, 10);
    const sizeMax = parseInt(item.social_size_max, 10);
    if (isNaN(sizeMin) || isNaN(sizeMax) || sizeMin < 0 || sizeMax < sizeMin) return null;

    const frequency = parseInt(item.frequency, 10);
    if (isNaN(frequency) || frequency < 1) return null;

    const priority = item.priority;
    if (!['must', 'want', 'nice_to_have'].includes(priority)) return null;

    const windowStart = item.time_window_start;
    const windowEnd   = item.time_window_end;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(windowStart)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(windowEnd))   return null;

    // All fields are typed/enum — no free-text strings present
    return { type, category, activityType, sizeMin, sizeMax, frequency, priority, windowStart, windowEnd };
  } catch {
    return null;
  }
}

// ─── Storage ──────────────────────────────────────────────────────────────────

/**
 * Parse raw text and store all extracted desires for a user.
 * raw_text is stored privately; coordination layer only sees structured fields.
 *
 * @returns {{ desires: StoredDesire[], summary: string }}
 */
async function parseAndStore(userId, rawText, windowStart, windowEnd) {
  const parsed = await parseDesires(rawText, windowStart, windowEnd);

  if (!parsed.length) {
    return { desires: [], summary: "I couldn't make out any specific desires — could you say that again?" };
  }

  const stored = [];
  for (const d of parsed) {
    const id = uuidv4();
    db.createDesire({
      id,
      userId,
      rawText,            // private — stored here only, never read by coord layer
      category:     d.category,
      activityType: d.activityType,
      socialSizeMin: d.sizeMin,
      socialSizeMax: d.sizeMax,
      windowStart:  d.windowStart,
      windowEnd:    d.windowEnd,
      priority:     d.priority
    });
    stored.push({ id, ...d });
  }

  return { desires: stored, summary: buildSummary(stored) };
}

// ─── Summary builder ──────────────────────────────────────────────────────────

/**
 * Build a human-readable summary of parsed desires for the agent to present.
 * Separates desires by type so the agent knows which ones need coordination.
 */
function buildSummary(desires) {
  const solo       = desires.filter(d => d.type === 'solo');
  const social     = desires.filter(d => d.type === 'social');
  const protective = desires.filter(d => d.type === 'protective');

  const lines = ['Got it. Here\'s what I\'ve logged for the week:'];

  for (const d of solo) {
    const times = d.frequency > 1 ? ` ×${d.frequency}` : '';
    lines.push(`  ✓ ${_label(d.category)}${times} — I'll find slots on your calendar`);
  }
  for (const d of protective) {
    lines.push(`  ✓ ${_label(d.category)} night — I'll keep that free`);
  }
  for (const d of social) {
    const size = _sizeLabel(d.sizeMin, d.sizeMax);
    const times = d.frequency > 1 ? ` ×${d.frequency}` : '';
    lines.push(`  ✓ ${_label(d.category)} with ${size}${times} — needs coordination`);
  }

  if (social.length) {
    lines.push('');
    lines.push(social.length === 1
      ? 'Who should I try to coordinate the social one with?'
      : 'Who should I try to coordinate the social ones with?');
  }

  return lines.join('\n');
}

function _label(category) {
  return {
    social: 'social outing', active: 'workout', dining: 'meal out', outdoor: 'outdoor activity',
    live_music: 'live music', dancing: 'dancing', drinks: 'drinks', chill: 'chill time',
    sports: 'sports', culture: 'cultural outing'
  }[category] || category;
}

function _sizeLabel(min, max) {
  if (min === 0 && max === 0) return 'yourself';
  if (min === 1 && max === 1) return '1 friend';
  if (min === 1 && max === 2) return 'a friend or two';
  if (min === 2 && max === 3) return 'a couple of friends';
  if (min === max) return `${min} friend${min > 1 ? 's' : ''}`;
  return `${min}–${max} friends`;
}

// ─── Agent tool definition ────────────────────────────────────────────────────

/**
 * Tool definition to add to agent.js TOOL_DEFINITIONS.
 * The agent calls this when a user expresses weekly desires.
 */
const TOOL_DEFINITION = {
  name: 'parse_desires',
  description: [
    'Parse and store a user\'s desires for a time window (e.g. "this week").',
    'Call this when the user tells you what they want to do: "I want to work out twice, go out with a friend, have a chill night."',
    'Returns a structured summary of what was logged and asks who to coordinate social desires with.',
    'Do NOT call this for a single specific plan (e.g. "dinner with Marcus on Thursday") — use create_social_event for that.',
    'Call this for open-ended desire expressions covering multiple days or a full week.'
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      raw_text: {
        type: 'string',
        description: 'The user\'s exact desire statement. Passed to the parser — will be stored privately and never shared with other agents.'
      },
      window_start: {
        type: 'string',
        description: 'Start of the time window, YYYY-MM-DD. Defaults to today if omitted.'
      },
      window_end: {
        type: 'string',
        description: 'End of the time window, YYYY-MM-DD. Defaults to 7 days from today if omitted.'
      }
    },
    required: ['raw_text']
  }
};

/**
 * Tool handler — call this from agent.js executeTool switch.
 */
async function handleTool(input, userId) {
  const { raw_text, window_start, window_end } = input;
  const result = await parseAndStore(userId, raw_text, window_start, window_end);
  return {
    desires_stored: result.desires.length,
    social_count:   result.desires.filter(d => d.type === 'social').length,
    solo_count:     result.desires.filter(d => d.type === 'solo').length,
    protective_count: result.desires.filter(d => d.type === 'protective').length,
    desire_ids:     result.desires.map(d => d.id),
    summary:        result.summary  // agent presents this to the user
  };
}

// ─── Coordination query ───────────────────────────────────────────────────────

/**
 * Get pending social desires for a user — ready to start coordination.
 * Used by the agent loop or a cron job to decide when to probe peer agents.
 */
function getPendingSocialDesires(userId) {
  return db.getPendingSocialDesires(userId);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  parseDesires,
  parseAndStore,
  getPendingSocialDesires,
  TOOL_DEFINITION,
  handleTool,
  // Exported for testing
  sanitizeDesire,
  buildSummary
};
