/**
 * plansync.js — say it, store it.
 *
 * 2026-10-12: Sean's agent told him "Melanie's Birthday Weekend — Fri–Sat, Oct 23–24 at
 * Carson City Hot Springs" and "Liam's Birthday Party — Sunday, Oct 25", even "Done", but
 * never saved any of it: both plans stayed undated and off the calendar. Owner: "How can
 * we make sure events planned this way do [get included] in the future?"
 *
 * After a turn about a plan, a short model check compares what was just decided or stated
 * for it (dates, place, who's coming, what it is) with what the plan actually has stored.
 * Anything missing goes back to the agent to save before it replies (agent.js). The same
 * check runs over older discussions as a retro task (retro.js), offered to the user.
 */
'use strict';

const db = require('./db');
const { createAnthropicClient, DEFAULT_MODEL } = require('./anthropic-client');

let _client = null;
let _enabled = process.env.NODE_ENV !== 'test';
function _setClient(c) { _client = c; _enabled = !!c; }
function client() {
  if (!_enabled) return null;
  if (!_client) { try { _client = createAnthropicClient(); } catch (_) { _enabled = false; return null; } }
  return _client;
}

/** What the plan has stored, as plain lines for the model. */
function storedPlan(eventId) {
  const e = db._raw().prepare('SELECT * FROM social_events WHERE id = ?').get(eventId);
  if (!e) return null;
  let dates;
  try { const p = JSON.parse(e.proposed_dates || 'null'); if (p) dates = `proposed: ${p.map((x) => x.from === x.to ? x.from : `${x.from} to ${x.to}`).join(' or ')}`; } catch (_) {}
  if (!dates) dates = e.date_tbd ? 'none (date TBD)' : e.flexible_time ? 'open invite, no fixed time' : new Date(e.scheduled_at * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const people = db._raw().prepare(`SELECT COALESCE(c.nickname, c.name) AS name, ei.status FROM event_invitations ei
    JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ?`).all(eventId).map((r) => `${r.name} (${r.status})`);
  return {
    title: e.title,
    lines: [`title: ${e.title}`, `what: ${e.activity_type}`, `dates: ${dates}`, `place: ${e.venue_name || 'none'}`,
      `people invited: ${people.join(', ') || 'none'}`, `notes: ${e.notes || 'none'}`, `status: ${e.status}${e.tentative ? ', tentative' : ''}`],
  };
}

function parseMissing(text) {
  try {
    const j = JSON.parse(String(text || '').match(/\{[\s\S]*\}/)[0]);
    return (Array.isArray(j.missing) ? j.missing : []).filter((m) => m && m.detail).slice(0, 6).map((m) => String(m.detail).slice(0, 200));
  } catch (_) { return []; }
}

/**
 * Details decided or stated for the plan in `exchange` that aren't stored. Returns a list
 * of short strings ("dates: Oct 23–24", "place: Carson City Hot Springs"); [] if none or
 * no model available.
 */
async function missingDetails(eventId, exchange) {
  const c = client();
  const plan = storedPlan(eventId);
  if (!c || !plan || !String(exchange || '').trim()) return [];
  const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: 400, messages: [{ role: 'user', content:
    `Today is ${new Date().toISOString().slice(0, 10)}. A person and their planning assistant talked about this plan.\n\nWhat the plan has stored:\n${plan.lines.join('\n')}\n\n`
    + `Conversation:\n${String(exchange).slice(0, 4000)}\n\n`
    + 'List details that were DECIDED or stated as the plan (by the person, or by the assistant as the current plan) that the stored plan does NOT have or has differently: dates, place, who is coming, what it is, cancelled. '
    + 'Ignore questions, options still being discussed (unless stored as proposed dates), and details that belong to a different plan. '
    + 'The MOST RECENT decision wins: if a detail was changed later in the conversation (a place dropped, dates moved), only the latest counts — never list a superseded one.\n'
    + 'Reply with JSON only: {"missing":[{"detail":"dates: 2026-10-23 to 2026-10-24"},{"detail":"place: Carson City Hot Springs"}]} — or {"missing":[]}.' }] });
  return parseMissing((r.content || []).map((b) => b.text || '').join(''));
}

module.exports = { missingDetails, storedPlan, _setClient };
