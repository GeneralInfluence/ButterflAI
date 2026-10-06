/**
 * trace.js — record what the agent did, for test users only (Phase B feedback loop).
 *
 * Each agent turn for an opted-in test user is written to agent_trace as it happens:
 * the incoming message, every tool call (name, input, result, duration) and the reply
 * or error. Triage (/admin/feedback) shows the trace around each 👎, so a friend's
 * report can be understood without anyone pulling server logs.
 *
 * Guardrails (PRIVACY.md):
 *  - opt-in only: users.test_user = 1 (Settings → Help improve ButterflAI)
 *  - private-mode turns record only WHICH tools ran — no text, inputs or results
 *  - private data inside inputs/results is redacted (health notes, private notes,
 *    avoid-list names, store_private_data values, decrypted private prefs)
 *  - kept RETENTION_DAYS, then hard-deleted (purgeOld, run by coord-loop's purge tick)
 *  - recording never throws into the agent loop
 */

'use strict';

const db = require('./db');

const RETENTION_DAYS = 30;
const MAX_JSON = 4000;
const REDACTED = '[redacted]';

// Keys that hold private data wherever they appear.
const PRIVATE_KEYS = new Set([
  'health_safety_notes', 'sexual_health_notes', 'private_notes', 'exclusions', 'value',
]);

// Tool-specific redaction on top of PRIVATE_KEYS.
const REDACT_RESULT_TOOLS = new Set(['get_private_preferences']);
const AVOID_TOOLS = new Set(['manage_avoid_list']);

function isTraced(userId) {
  try { return !!db.getUser(userId)?.test_user; } catch (_) { return false; }
}

function scrub(obj, depth = 0) {
  if (obj == null || typeof obj !== 'object' || depth > 6) return obj;
  if (Array.isArray(obj)) return obj.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = PRIVATE_KEYS.has(k) && v != null ? REDACTED : scrub(v, depth + 1);
  }
  return out;
}

function redact(toolName, input, result) {
  let i = scrub(input);
  let r = REDACT_RESULT_TOOLS.has(toolName) ? REDACTED : scrub(result);
  if (AVOID_TOOLS.has(toolName) && r && typeof r === 'object') {
    // Who the user avoids is private: keep the outcome, drop the names.
    r = { ...r };
    if ('name' in r) r.name = REDACTED;
    if (Array.isArray(r.entries)) r.entries = `[${r.entries.length} entries redacted]`;
  }
  return { input: i, result: r };
}

function clip(v) {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  return s.length > MAX_JSON ? s.slice(0, MAX_JSON) + '…' : s;
}

function insert(row) {
  db._raw().prepare(`
    INSERT INTO agent_trace (user_id, turn_id, channel, kind, tool_name, input_json, result_json, text, duration_ms, model)
    VALUES (@user_id, @turn_id, @channel, @kind, @tool_name, @input_json, @result_json, @text, @duration_ms, @model)
  `).run({
    tool_name: null, input_json: null, result_json: null, text: null, duration_ms: null, model: null,
    ...row,
  });
}

/**
 * Start tracing one turn. Returns a recorder whose methods are no-ops when the user
 * isn't a test user, and which never throw.
 */
function startTurn({ userId, msg, model, isPrivate }) {
  const on = !!userId && isTraced(userId);
  const base = { user_id: userId, turn_id: msg?.id || null, channel: msg?.channel || null, model: model || null };
  const safe = (fn) => (...args) => { if (!on) return; try { fn(...args); } catch (err) { console.error('[trace] record failed:', err.message); } };

  return {
    enabled: on,
    message: safe((text) => insert({ ...base, kind: 'message', text: isPrivate ? null : String(text ?? '').slice(0, MAX_JSON) })),
    tool: safe((name, input, result, durationMs) => {
      if (isPrivate) return insert({ ...base, kind: 'tool', tool_name: name, duration_ms: durationMs, text: 'private mode — input and result not recorded' });
      const r = redact(name, input, result);
      insert({ ...base, kind: 'tool', tool_name: name, input_json: clip(r.input), result_json: clip(r.result), duration_ms: durationMs });
    }),
    reply: safe((text) => insert({ ...base, kind: 'reply', text: isPrivate ? null : String(text ?? '').slice(0, MAX_JSON) })),
    event: safe((kind, text) => insert({ ...base, kind, text: String(text ?? '').slice(0, MAX_JSON) })),
  };
}

/** Trace rows for one user in a time window, oldest first. */
function listForUser(userId, { since = 0, until = Math.floor(Date.now() / 1000) + 1, limit = 200 } = {}) {
  return db._raw().prepare(`
    SELECT * FROM agent_trace WHERE user_id = ? AND created_at >= ? AND created_at <= ?
    ORDER BY created_at, id LIMIT ?`).all(userId, since, until, limit);
}

/** Hard-delete trace rows older than RETENTION_DAYS. Returns rows deleted. */
function purgeOld(now = Math.floor(Date.now() / 1000)) {
  return db._raw().prepare('DELETE FROM agent_trace WHERE created_at < ?').run(now - RETENTION_DAYS * 86400).changes;
}

module.exports = { RETENTION_DAYS, isTraced, redact, startTurn, listForUser, purgeOld };
