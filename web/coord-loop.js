'use strict';

/**
 * coord-loop.js — Coordination loop
 *
 * Runs on a timer alongside the agent loop. Each tick:
 *   1. Find all pending social desires across all users
 *   2. Resolve candidates (specific contacts or vague strategy)
 *   3. Create a coordination session and start probing peer agents
 *   4. Check recurring desire templates due for a new instance this window
 *   5. Notify users when sessions reach ESCALATE_HUMAN
 *
 * This is the connector between desires.js and coordination.js.
 * The agent loop handles SMS ↔ human. This loop handles agent ↔ agent.
 *
 * Tick interval: default 5 minutes. Coordination is not time-critical
 * enough to warrant a tight loop — the 3-round negotiation plays out
 * over hours or days, not seconds.
 *
 * MCP transport stub:
 *   Real MCP transport is wired in when the MCP server is live.
 *   For now, transport is a logged stub so the state machine runs
 *   and sessions advance even without a live peer. Swap in
 *   startCoordLoop({ transport: mcpTransport }) at that point.
 */

const db          = require('./db');
const desires     = require('./desires');
const coord       = require('./coordination');
const sms         = require('./sms');
const { STATE }   = require('./coordination');

const COORD_INTERVAL_MS = parseInt(process.env.COORD_INTERVAL_MS || String(5 * 60 * 1000), 10);

// ─── Transport stub ───────────────────────────────────────────────────────────
// Replace with real MCP transport when available.
// Logs all outbound messages so the state machine can be tested without a live peer.

const stubTransport = {
  send(toAgentId, message) {
    console.log(`[coord] → agent ${toAgentId.slice(0, 12)}… | ${message.message_type} round=${message.round || '-'}`);
    // TODO: replace with real MCP send when transport is wired
  }
};

// ─── notifyUser ───────────────────────────────────────────────────────────────
// Called by coordination.js when a session needs human input or a plan is ready.

async function notifyUser(userId, text, meta = {}) {
  const user = db.getUser(userId);
  if (!user?.phone) {
    console.warn(`[coord] notifyUser: no phone for userId=${userId}`);
    return;
  }

  // Store as an inbound message so the agent loop processes it with full context
  // (the agent then sends the SMS and can handle the reply in the same turn)
  db.storeInboundMessage({
    from_phone:  user.phone,
    from_type:   'system',
    from_id:     userId,
    channel:     'coord_notify',
    text:        `[Coordination update — inform the user] ${text}` +
                 (meta.sessionId ? ` [session:${meta.sessionId}]` : '')
  });

  console.log(`[coord] queued notify for ${user.phone}: "${text.slice(0, 60)}"`);
}

// ─── Candidate resolution ─────────────────────────────────────────────────────

/**
 * Resolve peer agent IDs to probe for a desire.
 * For 'specific' strategy: look up agent_endpoint on each contact.
 * For all others: use resolveCandidates to rank contacts, then look up their agents.
 *
 * Returns an array of agent IDs. Empty if no candidates with known agent endpoints.
 */
function resolvePeerAgentIds(userId, desire) {
  let contactIds;

  if (desire.candidate_strategy === 'specific' && desire.candidate_ids) {
    try { contactIds = JSON.parse(desire.candidate_ids); } catch { contactIds = []; }
  } else {
    contactIds = desires.resolveCandidates(userId, desire, 5);
  }

  if (!contactIds.length) {
    console.log(`[coord] desire ${desire.id}: no candidates resolved`);
    return [];
  }

  // Map contact IDs → peer agent IDs via the contact's linked user's agent_endpoint
  const peerAgentIds = [];
  for (const contactId of contactIds) {
    const contact = db.getContact(contactId);
    if (!contact?.phone) continue;

    const contactUser = db.getUserByPhone(contact.phone);
    if (!contactUser?.agent_endpoint) continue;  // contact not on ButterflAI

    peerAgentIds.push(contactUser.agent_endpoint);
  }

  if (!peerAgentIds.length) {
    console.log(`[coord] desire ${desire.id}: contacts found but none have agent endpoints yet`);
  }

  return peerAgentIds;
}

// ─── Main tick ────────────────────────────────────────────────────────────────

async function tick(transport = stubTransport) {
  try {
    await tickDesires(transport);
    await tickRecurring();
    await tickEscalations();
    tickPurge();
  } catch (err) {
    console.error('[coord] tick error:', err.message);
  }
}

// Non-retention: hard-delete coordination data past its purge_after / expiry.
// A peer's availability must not linger after the event it was shared for.
function tickPurge() {
  try {
    const { peers, sessions, ambient } = db.purgeExpiredCoordination();
    if (peers || sessions || ambient) {
      console.log(`[coord] purged expired: sessions=${sessions} peers=${peers} ambient=${ambient}`);
    }
  } catch (err) {
    console.error('[coord] purge error:', err.message);
  }
}

/**
 * For each pending social desire: resolve candidates and start probing.
 * Skips desires that already have an active session.
 */
async function tickDesires(transport) {
  // Get all users with pending social desires
  // We need to iterate across all users — use the raw DB to get distinct user_ids
  const rows = db._raw().prepare(`
    SELECT DISTINCT user_id FROM coord_desires
    WHERE status = 'pending'
    AND category IN ('social','dining','outdoor','live_music','dancing','drinks','sports','culture','active')
    AND social_size_min > 0
  `).all();

  for (const { user_id } of rows) {
    const pendingDesires = db.getPendingSocialDesires(user_id);

    for (const desire of pendingDesires) {
      await processDesire(transport, desire);
    }
  }
}

async function processDesire(transport, desire) {
  // Skip if a session is already in-flight for this desire
  const existingSession = db._raw().prepare(`
    SELECT id FROM coordination_sessions
    WHERE desire_id = ? AND state NOT IN ('dropped','cancelled','scheduled')
  `).get(desire.id);

  if (existingSession) return;  // already being coordinated

  // Check if desire window has expired
  if (desire.time_window_end < new Date().toISOString().slice(0, 10)) {
    db.updateDesireStatus(desire.id, 'dropped');
    console.log(`[coord] desire ${desire.id} expired — marked dropped`);
    return;
  }

  // Resolve peer agents to probe
  const peerAgentIds = resolvePeerAgentIds(desire.user_id, desire);

  if (!peerAgentIds.length) {
    // No peers available yet — leave pending, try again next tick
    // If strategy is 'specific' and we expected specific contacts, notify user
    if (desire.candidate_strategy === 'specific') {
      await notifyUser(
        desire.user_id,
        `I'm trying to set up a ${desire.category} for you this week, but the people you mentioned aren't on ButterflAI yet. Want me to send them an invite, or suggest someone else?`,
        { desireId: desire.id, type: 'no_peer_agents' }
      );
      db.updateDesireStatus(desire.id, 'dropped');  // don't retry indefinitely
    }
    return;
  }

  // Create session and start probing
  try {
    const sessionId = coord.createSession(desire, peerAgentIds);
    await coord.startProbing(transport, sessionId);
    console.log(`[coord] started session ${sessionId} for desire ${desire.id} → ${peerAgentIds.length} peer(s)`);
  } catch (err) {
    console.error(`[coord] failed to start session for desire ${desire.id}:`, err.message);
  }
}

/**
 * Spawn new instances for recurring desire templates that are due this window.
 */
async function tickRecurring() {
  const users = db._raw().prepare('SELECT id FROM users').all();

  for (const { id: userId } of users) {
    let dueTemplates;
    try {
      dueTemplates = desires.getDueRecurringTemplates(userId);
    } catch {
      continue;  // coord_desires view may not exist yet if migration pending
    }

    for (const template of dueTemplates) {
      const today    = new Date().toISOString().slice(0, 10);
      const windowEnd = _addDays(today, _recurrenceDays(template.recurrence));

      try {
        const instanceId = desires.spawnRecurringInstance(template.id, today, windowEnd);
        console.log(`[coord] spawned recurring instance ${instanceId} from template ${template.id}`);
      } catch (err) {
        console.error(`[coord] failed to spawn instance for template ${template.id}:`, err.message);
      }
    }
  }
}

/**
 * Check for sessions that need human attention and haven't been notified recently.
 */
async function tickEscalations() {
  const stuckSessions = db._raw().prepare(`
    SELECT cs.*, cd.user_id, cd.category
    FROM coordination_sessions cs
    JOIN coord_desires cd ON cd.id = cs.desire_id
    WHERE cs.state = 'escalate_human'
    AND cs.updated_at < strftime('%s','now') - 3600  -- stuck for > 1 hour
  `).all();

  for (const session of stuckSessions) {
    const user = db.getUser(session.user_id || session.initiator_user_id);
    if (!user) continue;

    const reason = session.escalation_reason || 'coordination hit a snag';
    await notifyUser(
      session.initiator_user_id,
      `Heads up: I'm trying to arrange a ${session.category || 'plan'} for you but I hit a wall — ${_humanizeReason(reason)}. Want to weigh in or let it go?`,
      { sessionId: session.id, type: 'coord_escalate' }
    );

    // Bump updated_at so we don't spam them every 5 minutes
    db._raw().prepare(
      "UPDATE coordination_sessions SET updated_at = strftime('%s','now') WHERE id = ?"
    ).run(session.id);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

let _transport = stubTransport;
let _running   = false;

function startCoordLoop(options = {}) {
  if (options.transport) _transport = options.transport;

  console.log(`[coord] starting loop (interval=${COORD_INTERVAL_MS}ms)`);

  // Run immediately, then on interval
  _runTick();
  setInterval(_runTick, COORD_INTERVAL_MS);
}

function _runTick() {
  if (_running) return;
  _running = true;
  tick(_transport).finally(() => { _running = false; });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _addDays(dateStr, days) {
  // All-UTC arithmetic. Parsing as UTC midnight then advancing with LOCAL setDate()/
  // getDate() (and reading back via UTC toISOString()) lands a day early when the span
  // crosses a DST transition in a UTC-negative zone. setUTCDate keeps it DST- and
  // locale-independent.
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function _recurrenceDays(recurrence) {
  return { weekly: 7, biweekly: 14, monthly: 30 }[recurrence] || 7;
}

function _humanizeReason(reason) {
  return {
    no_interest:      'none of your friends were free or interested',
    no_match:         'schedules didn\'t overlap',
    counter_received: 'a friend suggested a different time',
    no_windows:       'your calendar looks packed',
    rounds_exhausted: 'we ran out of negotiation rounds'
  }[reason] || reason;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  startCoordLoop,
  tick,
  notifyUser,
  // Exported for testing
  processDesire,
  resolvePeerAgentIds
};
