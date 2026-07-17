'use strict';

/**
 * coordination.js — State machine for agent-to-agent desire coordination
 *
 * Handles two roles:
 *   Initiator — the agent whose user expressed a desire and started a session
 *   Responder — a peer agent receiving a probe on behalf of their user
 *
 * Three-round negotiation:
 *   Round 1: probe → interest (day-level availability)
 *   Round 2: availability windows exchange
 *   Round 3: proposal → confirm / counter / reject
 *
 * Multi-party: probes all peer agents in parallel, computes the intersection
 * of available windows, then sends proposals only to peers in that intersection.
 *
 * All outbound messages are built via mcp-messages.js — never constructed inline.
 * This module never reads desire.raw_text.
 *
 * Dependencies injected (not imported):
 *   transport   — { send(toAgentId, msg) }
 *   getWindows  — async (userId, windowStart, windowEnd) → [{day,period,earliest,latest}]
 *   notifyUser  — async (userId, text) → void  (SMS escalation)
 */

const { v4: uuidv4 } = require('uuid');
const msg = require('./mcp-messages');
const db  = require('./db');

// Session TTL: sessions expire at the end of the coordination window.
// Purge: event_date + 7 days (hard delete, not soft).
const SESSION_TTL_DAYS  = 14;
const PURGE_AFTER_DAYS  = 7;  // after the event

// ─── Session States ───────────────────────────────────────────────────────────

const STATE = {
  PENDING:          'pending',
  PROBING:          'probing',
  AVAILABILITY:     'availability',
  PROPOSED:         'proposed',
  PENDING_HUMAN_OK: 'pending_human_ok',
  SCHEDULED:        'scheduled',
  ESCALATE_HUMAN:   'escalate_human',
  DROPPED:          'dropped',
  CANCELLED:        'cancelled'
};

// ─── Peer States ──────────────────────────────────────────────────────────────

const PEER = {
  PROBING:           'probing',
  INTERESTED:        'interested',
  NOT_INTERESTED:    'not_interested',
  WINDOWS_SENT:      'windows_sent',
  WINDOWS_RECEIVED:  'windows_received',
  PROPOSED:          'proposed',
  CONFIRMED:         'confirmed',
  COUNTER:           'counter',
  REJECTED:          'rejected',
  CANCELLED:         'cancelled'
};

// ─── Initiator: Create + Start ─────────────────────────────────────────────────

/**
 * Create a new coordination session for a desire.
 * Call this when a pending social desire needs coordination.
 *
 * @param {object} desire        - row from coord_desires view
 * @param {string[]} peerAgentIds - MCP agent IDs to probe (parallel)
 * @returns {string} sessionId
 */
function createSession(desire, peerAgentIds) {
  if (!peerAgentIds.length) throw new Error('coordination: need at least one peer agent');

  const sessionId = uuidv4();
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 86400 * 1000).toISOString();
  const purgeAfter = new Date(
    new Date(desire.time_window_end).getTime() + PURGE_AFTER_DAYS * 86400 * 1000
  ).toISOString();

  db.createCoordSession({
    id: sessionId,
    desireId: desire.id,
    initiatorUserId: desire.user_id,
    role: 'initiator',
    expiresAt,
    purgeAfter
  });

  for (const peerAgentId of peerAgentIds) {
    db.createCoordPeer({ id: uuidv4(), sessionId, peerAgentId });
  }

  db.updateDesireStatus(desire.id, 'negotiating');
  return sessionId;
}

/**
 * Send probes to all peers. Advances session to PROBING.
 * Call immediately after createSession.
 */
async function startProbing(transport, sessionId) {
  const session = db.getCoordSession(sessionId);
  const desire  = db.getCoordDesire(session.desire_id);
  const peers   = db.getCoordPeers(sessionId);

  const probe = msg.buildProbe({
    fromUserId:    session.initiator_user_id,
    category:      desire.category,
    activityType:  desire.activity_type,
    groupSizeMin:  desire.social_size_min,
    groupSizeMax:  desire.social_size_max,
    windowStart:   desire.time_window_start,
    windowEnd:     desire.time_window_end
  });

  const expiresAt = session.expires_at;

  for (const peer of peers) {
    msg.sendCoordMessage(transport, {
      sessionId,
      fromAgent: _myAgentId(),
      toAgent:   peer.peer_agent_id,
      round:     1,
      expiresAt
    }, probe);
    db.updateCoordPeer(peer.id, { state: PEER.PROBING, rounds_used: 1, last_msg_at: _now() });
  }

  db.updateCoordSession(sessionId, { state: STATE.PROBING, round: 1 });
}

// ─── Initiator: Handle Inbound Responses ──────────────────────────────────────

/**
 * Peer responded to our probe with interest or no-interest.
 * When all peers have responded, send our availability windows to interested peers.
 */
async function onInterest(transport, sessionId, peerAgentId, payload, { getWindows }) {
  const session = db.getCoordSession(sessionId);
  const peer    = db.getCoordPeer(sessionId, peerAgentId);
  if (!peer) return;

  if (!payload.interested) {
    db.updateCoordPeer(peer.id, { state: PEER.NOT_INTERESTED });
  } else {
    db.updateCoordPeer(peer.id, {
      state:          PEER.INTERESTED,
      available_days: payload.available_days || []
    });
  }

  const peers = db.getCoordPeers(sessionId);

  // Wait until all peers have responded to round 1
  const allResponded = peers.every(p => [PEER.INTERESTED, PEER.NOT_INTERESTED].includes(p.state));
  if (!allResponded) return;

  const interested = peers.filter(p => p.state === PEER.INTERESTED);
  if (!interested.length) {
    return _escalate(sessionId, 'no_interest', 'None of the peers were interested this window.');
  }

  // Fetch our own available windows and send to each interested peer
  const desire  = db.getCoordDesire(session.desire_id);
  const myWindows = await getWindows(session.initiator_user_id, desire.time_window_start, desire.time_window_end);

  if (!myWindows.length) {
    return _escalate(sessionId, 'no_windows', 'You have no open windows this period.');
  }

  const availability = msg.buildAvailability({ windows: myWindows });

  for (const p of interested) {
    msg.sendCoordMessage(transport, {
      sessionId,
      fromAgent: _myAgentId(),
      toAgent:   p.peer_agent_id,
      round:     2,
      expiresAt: session.expires_at
    }, availability);
    db.updateCoordPeer(p.id, { state: PEER.WINDOWS_SENT, rounds_used: 2 });
  }

  db.updateCoordSession(sessionId, { state: STATE.AVAILABILITY, round: 2 });
}

/**
 * Peer sent their matching windows back.
 * When all interested peers have responded, find the intersection and send proposals.
 */
async function onAvailability(transport, sessionId, peerAgentId, payload) {
  const session = db.getCoordSession(sessionId);
  const peer    = db.getCoordPeer(sessionId, peerAgentId);
  if (!peer) return;

  db.updateCoordPeer(peer.id, {
    state:           PEER.WINDOWS_RECEIVED,
    offered_windows: payload.windows || []
  });

  const peers     = db.getCoordPeers(sessionId);
  const interested = peers.filter(p => [PEER.WINDOWS_SENT, PEER.WINDOWS_RECEIVED].includes(p.state));
  const allWindowed = interested.every(p => p.state === PEER.WINDOWS_RECEIVED);
  if (!allWindowed) return;

  // Compute intersection of windows across all interested peers
  const windowSets = interested.map(p => JSON.parse(p.offered_windows || '[]'));
  const desire     = db.getCoordDesire(session.desire_id);
  const intersection = computeWindowIntersection(windowSets, desire.time_window_start);

  if (!intersection.length) {
    return _escalate(sessionId, 'no_match',
      `Interested peers (${interested.map(p => p.peer_agent_id).join(', ')}) have no overlapping windows.`
    );
  }

  // Pick the best slot: earliest window in the intersection
  const best = intersection[0];

  for (const p of interested) {
    const proposal = msg.buildProposal({
      slotStart:            best.isoStart,
      durationMin:          best.durationMin,
      activitySketch:       desire.activity_type === 'any' ? desire.category : desire.activity_type,
      requiresHumanConfirm: true
    });
    msg.sendCoordMessage(transport, {
      sessionId,
      fromAgent: _myAgentId(),
      toAgent:   p.peer_agent_id,
      round:     3,
      expiresAt: session.expires_at
    }, proposal);

    db.updateCoordPeer(p.id, {
      state:              PEER.PROPOSED,
      proposed_slot_start: best.isoStart,
      proposed_slot_dur:   best.durationMin,
      rounds_used:         3
    });
  }

  db.updateCoordSession(sessionId, { state: STATE.PROPOSED, round: 3 });
}

/**
 * Peer confirmed our proposal (pending their human's approval).
 * When all proposed peers confirm → PENDING_HUMAN_OK → notify our user.
 */
async function onConfirm(transport, sessionId, peerAgentId, payload, { notifyUser }) {
  const peer = db.getCoordPeer(sessionId, peerAgentId);
  if (!peer) return;

  db.updateCoordPeer(peer.id, { state: PEER.CONFIRMED });

  const session = db.getCoordSession(sessionId);
  const proposed = db.getCoordPeers(sessionId).filter(p => p.state === PEER.PROPOSED || p.state === PEER.CONFIRMED);
  const allConfirmed = proposed.every(p => p.state === PEER.CONFIRMED);
  if (!allConfirmed) return;

  // All peers confirmed — ask our own user
  db.updateCoordSession(sessionId, { state: STATE.PENDING_HUMAN_OK });

  const desire = db.getCoordDesire(session.desire_id);
  const slotStart = peer.proposed_slot_start;
  const friendCount = proposed.length;

  await notifyUser(
    session.initiator_user_id,
    `Plan ready: ${desire.category} on ${_friendlySlot(slotStart)} with ${friendCount} friend${friendCount > 1 ? 's' : ''}. ` +
    `Reply YES to confirm or NO to cancel.`,
    { sessionId, type: 'coord_confirm' }
  );
}

/**
 * Peer countered with a different slot.
 * Accept if it fits our windows, otherwise escalate.
 */
async function onCounter(transport, sessionId, peerAgentId, payload, { getWindows, notifyUser }) {
  const session = db.getCoordSession(sessionId);
  const peer    = db.getCoordPeer(sessionId, peerAgentId);
  if (!peer) return;

  db.updateCoordPeer(peer.id, {
    state:              PEER.COUNTER,
    proposed_slot_start: payload.slot.start
  });

  // Rounds exhausted after a counter — escalate to human
  return _escalate(sessionId, 'counter_received',
    `A friend countered with ${_friendlySlot(payload.slot.start)}. Do you want to accept, or try a different time?`,
    notifyUser, session.initiator_user_id,
    { counterSlot: payload.slot, fromPeer: peerAgentId }
  );
}

/**
 * Peer rejected our proposal. If others are still in play, continue.
 * If all proposed peers rejected → drop session.
 */
async function onReject(transport, sessionId, peerAgentId, { notifyUser }) {
  const peer = db.getCoordPeer(sessionId, peerAgentId);
  if (!peer) return;

  db.updateCoordPeer(peer.id, { state: PEER.REJECTED });

  const peers    = db.getCoordPeers(sessionId);
  const active   = peers.filter(p => ![PEER.REJECTED, PEER.NOT_INTERESTED, PEER.CANCELLED].includes(p.state));

  if (!active.length) {
    db.updateCoordSession(sessionId, { state: STATE.DROPPED });
    db.updateDesireStatus(db.getCoordSession(sessionId).desire_id, 'dropped');
  }
  // If some peers are still pending confirm, wait for them
}

// ─── Human Approval ───────────────────────────────────────────────────────────

/**
 * User said YES to the proposed plan.
 * Send final confirms to all peers and mark scheduled.
 */
async function humanApproved(transport, sessionId) {
  const session  = db.getCoordSession(sessionId);
  const peers    = db.getCoordPeers(sessionId).filter(p => p.state === PEER.CONFIRMED);
  const expiresAt = session.expires_at;
  const respondBy = new Date(Date.now() + 3600 * 1000).toISOString(); // 1h grace

  for (const peer of peers) {
    const confirm = msg.buildConfirm({ pendingHumanApproval: false, respondBy });
    msg.sendCoordMessage(transport, {
      sessionId,
      fromAgent: _myAgentId(),
      toAgent:   peer.peer_agent_id,
      round:     3,
      expiresAt
    }, confirm);
  }

  db.updateCoordSession(sessionId, {
    state:               STATE.SCHEDULED,
    agreed_slot_start:   peers[0]?.proposed_slot_start,
    agreed_slot_duration: peers[0]?.proposed_slot_dur
  });
  db.updateDesireStatus(session.desire_id, 'scheduled');
}

/**
 * User said NO. Cancel all peers and drop the session.
 */
async function humanRejected(transport, sessionId) {
  const session = db.getCoordSession(sessionId);
  const peers   = db.getCoordPeers(sessionId).filter(p =>
    [PEER.CONFIRMED, PEER.PROPOSED].includes(p.state)
  );

  const cancel = msg.buildCancel();
  for (const peer of peers) {
    msg.sendCoordMessage(transport, {
      sessionId,
      fromAgent: _myAgentId(),
      toAgent:   peer.peer_agent_id,
      round:     3,
      expiresAt: session.expires_at
    }, cancel);
    db.updateCoordPeer(peer.id, { state: PEER.CANCELLED });
  }

  db.updateCoordSession(sessionId, { state: STATE.CANCELLED });
  db.updateDesireStatus(session.desire_id, 'dropped');
}

// ─── Responder: Handle Inbound from Initiator ─────────────────────────────────

/**
 * Route an inbound coordination message to the right handler.
 * Call this from the MCP message receiver.
 *
 * @param {object} inbound         - full parsed MCP message
 * @param {object} deps            - { getWindows, notifyUser, checkConsent }
 */
async function handleInbound(transport, inbound, deps) {
  const { message_type, session_id, payload, from_agent, round } = inbound;

  // Validate session hasn't expired
  if (inbound.expires_at && new Date(inbound.expires_at) < new Date()) return;

  switch (message_type) {
    case 'probe':        return handleProbeInbound(transport, inbound, deps);
    case 'availability': return handleAvailabilityInbound(transport, inbound, deps);
    case 'proposal':     return handleProposalInbound(transport, inbound, deps);
    case 'confirm':      return handleConfirmInbound(transport, inbound, deps);
    case 'cancel':       return handleCancelInbound(transport, inbound);
    // 'interest' and 'counter' are initiator-side — handled by onInterest / onCounter above
    default:
      console.warn('[coord] unknown inbound message_type:', message_type);
  }
}

/**
 * Received a probe. Check consent, respond with interest + available days.
 */
async function handleProbeInbound(transport, inbound, { getWindows, notifyUser, checkConsent }) {
  const { session_id, payload, from_agent } = inbound;

  // Find which local user this is for (the to_agent maps to us; the from_user_id in payload
  // tells us who's asking — check they're an allowed contact)
  const localUserId = await _resolveLocalUser(inbound.to_agent);
  if (!localUserId) return;

  const consentOk = await checkConsent(localUserId, payload.from_user_id);
  if (!consentOk) {
    // Silently drop — don't inform the initiator they were blocked
    return;
  }

  // Create a responder-side session to track state
  const desireId   = uuidv4(); // synthetic — responder tracks via session, not a real desire
  const sessionId  = session_id; // reuse the initiator's session_id as the shared key
  const expiresAt  = inbound.expires_at || new Date(Date.now() + SESSION_TTL_DAYS * 86400 * 1000).toISOString();
  const purgeAfter = new Date(
    new Date(payload.time_window.end).getTime() + PURGE_AFTER_DAYS * 86400 * 1000
  ).toISOString();

  // Avoid duplicate sessions if probe is retried
  let responderSession = db.getCoordSession(sessionId);
  if (!responderSession) {
    db.createCoordSession({
      id: sessionId,
      desireId,
      initiatorUserId: localUserId,
      role: 'responder',
      expiresAt,
      purgeAfter
    });
    db.createCoordPeer({ id: uuidv4(), sessionId, peerAgentId: from_agent, peerUserId: payload.from_user_id });
  }

  // Get our user's available days for this window
  const myWindows = await getWindows(localUserId, payload.time_window.start, payload.time_window.end);
  const availDays = [...new Set(myWindows.map(w => w.day))];
  const interested = availDays.length > 0;

  const interest = msg.buildInterest({ interested, availableDays: availDays });
  msg.sendCoordMessage(transport, {
    sessionId,
    fromAgent: _myAgentId(),
    toAgent:   from_agent,
    round:     1,
    expiresAt
  }, interest);

  db.updateCoordSession(sessionId, { state: interested ? STATE.PROBING : STATE.DROPPED, round: 1 });

  const peer = db.getCoordPeer(sessionId, from_agent);
  db.updateCoordPeer(peer.id, { state: interested ? PEER.INTERESTED : PEER.NOT_INTERESTED });
}

/**
 * Received the initiator's availability windows.
 * Compute matches against our own windows and respond.
 */
async function handleAvailabilityInbound(transport, inbound, { getWindows }) {
  const { session_id, payload, from_agent } = inbound;
  const session    = db.getCoordSession(session_id);
  if (!session) return;

  const localUserId = session.initiator_user_id;

  // Get our windows (we already know the time_window from the probe — look it up)
  // We'll use a generous window: the session expires_at as the end
  const myWindows = await getWindows(localUserId, _today(), session.expires_at.slice(0, 10));

  // Find our windows that overlap with theirs
  const matched = intersectTwoWindowSets(payload.windows, myWindows);

  const peer = db.getCoordPeer(session_id, from_agent);
  db.updateCoordPeer(peer.id, { state: PEER.WINDOWS_RECEIVED, offered_windows: payload.windows, matched_windows: matched });

  // Send back our matched windows (empty array = no match)
  const avail = msg.buildAvailability({ windows: matched.length ? matched : myWindows });
  msg.sendCoordMessage(transport, {
    sessionId:  session_id,
    fromAgent:  _myAgentId(),
    toAgent:    from_agent,
    round:      2,
    expiresAt:  session.expires_at
  }, avail);

  db.updateCoordSession(session_id, { state: STATE.AVAILABILITY, round: 2 });
  db.updateCoordPeer(peer.id, { state: PEER.WINDOWS_SENT, rounds_used: 2 });
}

/**
 * Received a proposal from the initiator.
 * Notify our user and send a pending-approval confirm back.
 */
async function handleProposalInbound(transport, inbound, { notifyUser }) {
  const { session_id, payload, from_agent } = inbound;
  const session = db.getCoordSession(session_id);
  if (!session) return;

  const peer = db.getCoordPeer(session_id, from_agent);

  db.updateCoordPeer(peer.id, {
    state:               PEER.PROPOSED,
    proposed_slot_start: payload.slot.start,
    proposed_slot_dur:   payload.slot.duration_min,
    rounds_used:         3
  });

  // Notify the local user
  await notifyUser(
    session.initiator_user_id,
    `A friend's agent is proposing ${payload.activity_sketch} on ${_friendlySlot(payload.slot.start)}. ` +
    `Reply YES to say you're interested, NO to pass.`,
    { sessionId: session_id, type: 'coord_inbound_proposal' }
  );

  // Send a soft confirm back: "checking with my person"
  const respondBy = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const confirm = msg.buildConfirm({ pendingHumanApproval: true, respondBy });
  msg.sendCoordMessage(transport, {
    sessionId:  session_id,
    fromAgent:  _myAgentId(),
    toAgent:    from_agent,
    round:      3,
    expiresAt:  session.expires_at
  }, confirm);

  db.updateCoordSession(session_id, { state: STATE.PENDING_HUMAN_OK, round: 3 });
}

/**
 * Received final confirm from the initiator (human approved on their end).
 * Notify our user: it's on.
 */
async function handleConfirmInbound(transport, inbound, { notifyUser }) {
  const { session_id, payload } = inbound;
  const session = db.getCoordSession(session_id);
  if (!session) return;

  if (!payload.pending_human_approval) {
    // Full confirm — event is real
    db.updateCoordSession(session_id, { state: STATE.SCHEDULED });
    const peer = db.getCoordPeers(session_id)[0];
    await notifyUser(
      session.initiator_user_id,
      `It's on! ${_friendlySlot(peer?.proposed_slot_start || '')} is confirmed.`,
      { sessionId: session_id, type: 'coord_scheduled' }
    );
  }
}

/**
 * Received a cancel (human said no on the initiator side).
 */
async function handleCancelInbound(transport, inbound) {
  const { session_id } = inbound;
  const session = db.getCoordSession(session_id);
  if (!session) return;
  db.updateCoordSession(session_id, { state: STATE.CANCELLED });
}

// ─── Ambient Intent ───────────────────────────────────────────────────────────

/**
 * Broadcast a soft social signal to all eligible peer agents.
 * Call when a user expresses vague intent ("might go to live music tonight").
 *
 * @param {object} intent  - parsed from LLM: { category, area, date, period, certainty, openToCompany }
 * @param {string[]} peerAgentIds - agents to notify (Tier 1+ contacts with agent endpoints)
 */
function broadcastAmbientIntent(transport, intent, fromAgentId, peerAgentIds) {
  const expiresAt = new Date(`${intent.date}T23:59:59`).toISOString();
  const ambientMsg = msg.buildAmbientIntent(intent);
  msg.sendAmbientMessage(transport, { fromAgent: fromAgentId, toAgents: peerAgentIds, expiresAt }, ambientMsg);
}

/**
 * Handle an inbound ambient_intent from a peer agent.
 * Store it so local users can query "what's happening tonight?"
 */
function handleAmbientIntentInbound(inbound) {
  const { from_agent, payload, expires_at } = inbound;
  db.upsertAmbientSignal({
    id:           `${from_agent}_${payload.date}_${payload.category}`,
    fromAgentId:  from_agent,
    category:     payload.category,
    area:         payload.area,
    date:         payload.date,
    period:       payload.period,
    certainty:    payload.certainty,
    openToCompany: !!payload.open_to_company,
    expiresAt:    expires_at
  });
}

/**
 * Answer "what's happening tonight?" for a user.
 * Returns aggregated ambient signals — NOT specific venues (those come from a venue lookup).
 *
 * @returns {{ category, area, period, certainty, openToCompany, count }[] }
 */
function getAmbientSummary(date) {
  const signals = db.getAmbientSignalsForDate(date);

  // Aggregate: group by category + area + period
  const groups = {};
  for (const s of signals) {
    const key = `${s.category}|${s.area || 'anywhere'}|${s.period}`;
    if (!groups[key]) {
      groups[key] = { category: s.category, area: s.area, period: s.period,
                      certainty: s.certainty, openToCompany: false, count: 0 };
    }
    groups[key].count++;
    if (s.open_to_company) groups[key].openToCompany = true;
    // Upgrade certainty if we have a higher signal
    if (_certaintyRank(s.certainty) > _certaintyRank(groups[key].certainty)) {
      groups[key].certainty = s.certainty;
    }
  }

  return Object.values(groups).sort((a, b) => b.count - a.count);
  // Callers then do a venue lookup (venues.js) for the top categories — not us
}

// ─── Window Intersection Logic ────────────────────────────────────────────────

/**
 * Find windows that work for ALL peer window sets simultaneously.
 *
 * @param {Array<Array>} windowSets - one array of windows per peer
 * @param {string} windowStart      - YYYY-MM-DD lower bound
 * @returns {Array} sorted by date/time, earliest first
 */
function computeWindowIntersection(windowSets, windowStart) {
  if (!windowSets.length) return [];
  if (windowSets.length === 1) return windowSets[0];

  const reference = windowSets[0];
  return reference
    .filter(w => windowSets.every(ws => ws.some(pw => pw.day === w.day && pw.period === w.period)))
    .map(w => {
      // Tighten to the latest earliest and the earliest latest across all peers
      const slots = windowSets.map(ws => ws.find(pw => pw.day === w.day && pw.period === w.period));
      const earliest = slots.map(s => s.earliest).sort().reverse()[0]; // latest of the earliests
      const latest   = slots.map(s => s.latest).sort()[0];             // earliest of the latests
      if (earliest >= latest) return null; // no overlap
      return {
        ...w,
        earliest,
        latest,
        isoStart:    _dayToIso(w.day, earliest, windowStart),
        durationMin: _minutesBetween(earliest, latest)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.isoStart.localeCompare(b.isoStart));
}

/**
 * Simpler two-way intersection (used on the responder side).
 */
function intersectTwoWindowSets(theirs, mine) {
  return computeWindowIntersection([theirs, mine], _today());
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _myAgentId() {
  return process.env.AGENT_ID || 'butterflai-default';
}

function _now() {
  return Math.floor(Date.now() / 1000);
}

function _today() {
  return new Date().toISOString().slice(0, 10);
}

async function _escalate(sessionId, reason, humanMsg, notifyUser, userId, extra = {}) {
  db.updateCoordSession(sessionId, { state: STATE.ESCALATE_HUMAN, escalation_reason: reason });
  if (notifyUser && userId) {
    await notifyUser(userId, humanMsg, { sessionId, type: 'coord_escalate', ...extra });
  }
}

async function _resolveLocalUser(agentId) {
  // Map our own agent ID to the user it represents
  // In production this comes from the agent registry; for now read from env
  return process.env.AGENT_USER_ID || null;
}

function _friendlySlot(isoStart) {
  if (!isoStart) return 'TBD';
  try {
    return new Date(isoStart).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    });
  } catch { return isoStart; }
}

function _dayToIso(day, time, windowStart) {
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  // Parse and compute entirely in UTC. Mixing a UTC-parsed date (new Date('YYYY-MM-DD')
  // is UTC midnight) with a LOCAL getDay() shifted the weekday by one under any non-UTC
  // runtime, moving the resolved slot to the wrong calendar day. getUTCDay() keeps the
  // weekday consistent with the UTC-based toISOString() output — tz-independent.
  const base  = new Date(`${windowStart}T00:00:00Z`);
  const targetDay = days.indexOf(day);
  const diff = (targetDay - base.getUTCDay() + 7) % 7;
  const date  = new Date(base.getTime() + diff * 86400 * 1000);
  return `${date.toISOString().slice(0, 10)}T${time}:00`;
}

function _minutesBetween(t1, t2) {
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  return (h2 * 60 + m2) - (h1 * 60 + m1);
}

function _certaintyRank(c) {
  return { exploring: 1, probable: 2, definite: 3 }[c] || 0;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Initiator
  createSession,
  startProbing,
  onInterest,
  onAvailability,
  onConfirm,
  onCounter,
  onReject,
  humanApproved,
  humanRejected,

  // Responder
  handleInbound,

  // Ambient
  broadcastAmbientIntent,
  handleAmbientIntentInbound,
  getAmbientSummary,

  // Utilities (exported for testing)
  computeWindowIntersection,
  intersectTwoWindowSets,

  // Constants
  STATE,
  PEER
};
