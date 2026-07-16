/**
 * ButterflAI multi-party coordination (§5.6 IMPLEMENTATION.md)
 *
 * Model: host sets a plan → chosen friends get a soft RSVP invite.
 * NOT a hard scheduling negotiation. Plan happens regardless of how many join.
 *
 * PULL-NOT-PUSH DISCLOSURE (the safety primitive):
 *   - The host's plan is NOT pushed beyond the chosen invitees.
 *   - A friend learns plan details only by asking their own agent (pull).
 *   - Gating rule: only surfaces details to someone the host explicitly chose.
 *   - A pull from someone NOT on the invite list returns nothing about the host's plan.
 *
 * NOT built here (deferred):
 *   - Hard multi-way scheduling (find a time that works for all 6) — different, harder
 *   - Ambient "fun is being had" signal — must be anonymised, opt-in, pull-based
 *   - Agent-to-agent MCP coordination — blocked on Open Q1 (non-retention enforcement)
 *
 * v1 uses direct SMS to contacts' phones (Tier 1 model).
 * Tier 2 (agent-to-agent) stubs are included but not live.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const sms = require('./sms');
const { ConsentRequired } = require('./sms');
const Anthropic = require('@anthropic-ai/sdk');

const _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Use Claude to classify an RSVP reply as YES / NO / UNCLEAR.
 * Regex will always lose against natural human language ("absofuckinglutely",
 * "you know it", "lmao yes"). Claude handles all of it.
 */
async function classifyRsvp(inviteText, replyText) {
  try {
    const result = await _anthropic.messages.create({
      model: process.env.AGENT_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system: 'You classify RSVP replies. Reply with exactly one word: YES, NO, or UNCLEAR.',
      messages: [{
        role: 'user',
        content: `Invite: "${inviteText}"\nReply: "${replyText}"\n\nIs this a yes, no, or unclear?`,
      }],
    });
    const word = (result.content[0]?.text || '').trim().toUpperCase();
    if (word === 'YES') return 'yes';
    if (word === 'NO') return 'no';
    return 'unclear';
  } catch (_) {
    // Fallback to a simple keyword check if Claude call fails
    const lower = replyText.toLowerCase();
    if (/\b(yes|yeah|yep|sure|in|absolutely|definitely|totally|down)\b/.test(lower)) return 'yes';
    if (/\b(no|nope|can't|busy|pass)\b/.test(lower)) return 'no';
    return 'unclear';
  }
}

// ── Table setup ───────────────────────────────────────────────────────────────

function ensureEventTables() {
  db._raw().exec(`
    CREATE TABLE IF NOT EXISTS social_events (
      id           TEXT PRIMARY KEY,
      host_user_id TEXT NOT NULL REFERENCES users(id),
      title        TEXT NOT NULL,        -- e.g. "Dinner at Carbone"
      activity_type TEXT NOT NULL,
      venue_name   TEXT,
      venue_address TEXT,
      scheduled_at INTEGER NOT NULL,     -- unix timestamp
      duration_mins INTEGER DEFAULT 120,
      notes        TEXT,
      status       TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','cancelled','completed')),
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS event_invitations (
      id           TEXT PRIMARY KEY,
      event_id     TEXT NOT NULL REFERENCES social_events(id),
      contact_id   TEXT NOT NULL,        -- contacts.id or users.id
      status       TEXT NOT NULL DEFAULT 'invited'
        CHECK (status IN ('invited','accepted','declined','no_response')),
      notified_at  INTEGER,              -- when invite SMS was sent
      responded_at INTEGER,
      response_note TEXT,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_event_invites_event   ON event_invitations(event_id);
    CREATE INDEX IF NOT EXISTS idx_event_invites_contact ON event_invitations(contact_id);
  `);
}

// ── Create an event ───────────────────────────────────────────────────────────

/**
 * Create a social event for a host.
 *
 * @param {string} hostUserId
 * @param {object} opts
 *   title, activity_type, venue_name, venue_address,
 *   scheduled_at (ISO string or unix ts), duration_mins, notes
 * @returns {string} eventId
 */
function createEvent(hostUserId, { title, activity_type, venue_name, venue_address, scheduled_at, duration_mins, notes }) {
  const id = uuidv4();
  const ts = typeof scheduled_at === 'string'
    ? Math.floor(new Date(scheduled_at).getTime() / 1000)
    : scheduled_at;

  db._raw().prepare(`
    INSERT INTO social_events (id, host_user_id, title, activity_type, venue_name, venue_address, scheduled_at, duration_mins, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, hostUserId, title, activity_type, venue_name || null, venue_address || null,
         ts, duration_mins || 120, notes || null);

  return id;
}

// ── Invite chosen friends ─────────────────────────────────────────────────────

/**
 * Send invitations to a specific list of contacts for an event.
 * Host has EXPLICITLY chosen these contacts — Gate 2 of the two-gate rule.
 *
 * Anti-spam enforced:
 *  - One invite per contact per event
 *  - STOP/opted-out contacts are silently skipped
 *
 * @param {string} eventId
 * @param {string[]} contactIds  - must all belong to the host
 * @returns {{ sent: number, skipped: number }}
 */
async function inviteContacts(eventId, contactIds) {
  // Guard: refuse to send invites for events that have already passed
  const eventCheck = db._raw().prepare('SELECT scheduled_at FROM social_events WHERE id = ?').get(eventId);
  if (eventCheck && eventCheck.scheduled_at < Math.floor(Date.now() / 1000)) {
    return { sent: 0, skipped: contactIds.length, error: 'EVENT_ALREADY_PASSED', message: 'Event time has already passed — reschedule before sending invites.' };
  }

  const event = db._raw().prepare('SELECT * FROM social_events WHERE id = ?').get(eventId);
  if (!event) throw new Error('Event not found');

  const host = db.getUser(event.host_user_id);
  if (!host) throw new Error('Host not found');

  const hostTimezone = host.timezone || 'America/Los_Angeles';

  let sent = 0;
  let skipped = 0;

  for (const contactId of contactIds) {
    const contact = db.getContact(contactId);
    if (!contact || contact.invited_by_user_id !== event.host_user_id) { skipped++; continue; }
    if (!contact.phone) { skipped++; continue; }
    if (db.isOptedOut(contact.phone)) { skipped++; continue; }

    // Idempotent: don't send twice to same contact for same event
    const existing = db._raw()
      .prepare('SELECT 1 FROM event_invitations WHERE event_id = ? AND contact_id = ?')
      .get(eventId, contactId);
    if (existing) { skipped++; continue; }

    // Create invitation record
    const invId = uuidv4();
    db._raw().prepare(`
      INSERT INTO event_invitations (id, event_id, contact_id, status, notified_at)
      VALUES (?, ?, ?, 'invited', strftime('%s','now'))
    `).run(invId, eventId, contactId);

    // Send invite SMS.
    // Use sendUnchecked because the invite message includes a mandatory STOP
    // opt-out instruction — this IS the first-touch consent mechanism.
    // sms.send() would block on ConsentRequired for new contacts, preventing
    // the invite from ever going out.
    const dateStr = formatEventDate(event.scheduled_at, hostTimezone);
    const venueStr = event.venue_name ? ` at ${event.venue_name}` : '';
    const message = buildInviteMessage(host.name, contact.name, event.activity_type, dateStr, venueStr, invId);

    try {
      await sms.sendUnchecked(contact.phone, message);
      sent++;
      console.log(`[multiparty] invite sent event=${eventId} contact=${contactId}`);
    } catch (err) {
      console.error(`[multiparty] invite failed contact=${contactId}:`, err.message);
      skipped++;
    }
  }

  return { sent, skipped };
}

/**
 * Build the invite message.
 * Self-identify header is included (agent acting on behalf of host).
 * Contact is given a simple reply mechanism (YES/NO to a shortcode-style reply).
 */
function buildInviteMessage(hostName, contactName, activityType, dateStr, venueStr, invitationId) {
  const baseUrl = process.env.BASE_URL || 'https://butterflai.social';
  return (
    `Hi ${contactName}! This is ${hostName}'s ButterflAI.\n\n` +
    `${hostName} is having ${activityType}${venueStr} on ${dateStr} and would love you to join — you in?\n\n` +
    `Want your own ButterflAI? → ${baseUrl}\n\n` +
    `Reply STOP to opt out.`
  );
}

// ── Handle RSVP replies ───────────────────────────────────────────────────────

/**
 * Process an RSVP reply from a contact (yes/no).
 * Called from the SMS handler when a contact (not a user) texts in.
 *
 * @param {string} contactPhone
 * @param {string} body
 * @returns {string|null} reply text, or null if not an RSVP
 */
async function handleRsvpReply(contactPhone, body) {
  const contact = db.getContactByPhone(contactPhone);
  if (!contact) return null;

  // Find any open invitation for this contact
  const invitation = db._raw().prepare(`
    SELECT ei.*, se.title, se.host_user_id, se.scheduled_at, se.activity_type
    FROM event_invitations ei
    JOIN social_events se ON se.id = ei.event_id
    WHERE ei.contact_id = ? AND ei.status = 'invited' AND se.status = 'open'
    ORDER BY ei.created_at DESC LIMIT 1
  `).get(contact.id);

  if (!invitation) return null;

  // Use Claude to classify the reply — regex can't handle natural language
  const classification = await classifyRsvp(
    `${invitation.activity_type} on ${formatEventDate(invitation.scheduled_at)}`,
    body
  );

  const isYes = classification === 'yes';
  const isNo  = classification === 'no';

  if (!isYes && !isNo) {
    // Genuinely ambiguous — ask a direct yes/no, don't route to planning agent
    return `Just to confirm — are you in? (Reply yes or no)`;
  }

  if (!isYes && !isNo) return null;

  const status = isYes ? 'accepted' : 'declined';
  db._raw().prepare(`
    UPDATE event_invitations SET status = ?, responded_at = strftime('%s','now') WHERE id = ?
  `).run(status, invitation.id);

  // Notify the host and write to their conversation history so the agent
  // knows about this RSVP on the next turn (RSVP happens out-of-band).
  const host = db.getUser(invitation.host_user_id);
  if (host) {
    const emoji = isYes ? '✅' : '❌';
    const msg = isYes
      ? `${emoji} ${contact.name} is in for ${invitation.activity_type} on ${formatEventDate(invitation.scheduled_at)}!`
      : `${emoji} ${contact.name} can't make it for ${invitation.activity_type} on ${formatEventDate(invitation.scheduled_at)}.`;

    // Persist RSVP into host's conversation history so agent has full context
    db.appendConversation(host.id, 'assistant',
      `[System] RSVP received: ${contact.name} has ${status} the invite for ${invitation.activity_type} on ${formatEventDate(invitation.scheduled_at)}.`
    );

    if (host.phone) {
      await sms.notifyUser(host.phone, msg).catch(() => {});
    }
  }

  return isYes
    ? `You're in! 🎉 See you on ${formatEventDate(invitation.scheduled_at)}.`
    : `No worries! Hope to catch you another time.`;
}

// ── Event status / management ─────────────────────────────────────────────────

function getEvent(eventId) {
  const event = db._raw().prepare('SELECT * FROM social_events WHERE id = ?').get(eventId);
  if (!event) return null;
  const invitations = db._raw()
    .prepare('SELECT * FROM event_invitations WHERE event_id = ?')
    .all(eventId);
  return { ...event, invitations };
}

function getEventsByHost(userId) {
  return db._raw()
    .prepare(`SELECT * FROM social_events WHERE host_user_id = ? ORDER BY scheduled_at DESC`)
    .all(userId);
}

/**
 * Get events the user was invited to (as a contact, by phone number).
 * Returns events with the invitation id and current RSVP status attached.
 */
function getInvitedEvents(userPhone) {
  return db._raw().prepare(`
    SELECT
      se.*,
      ei.id   AS invitation_id,
      ei.status AS rsvp_status,
      u.name  AS host_name
    FROM event_invitations ei
    JOIN social_events se ON se.id = ei.event_id
    JOIN contacts c       ON c.id  = ei.contact_id
    JOIN users u          ON u.id  = se.host_user_id
    WHERE c.phone = ?
      AND se.status != 'cancelled'
    ORDER BY se.scheduled_at ASC
  `).all(userPhone);
}

/**
 * Accept or decline an event invitation directly (web app RSVP).
 * @param {string} invitationId
 * @param {string} userPhone  — must match the contact on the invitation
 * @param {'accepted'|'declined'} status
 */
function rsvpInvitation(invitationId, userPhone, status) {
  // Verify ownership: the contact on this invitation must have userPhone
  const inv = db._raw().prepare(`
    SELECT ei.*, c.phone, se.host_user_id, se.title, se.scheduled_at, se.activity_type
    FROM event_invitations ei
    JOIN contacts c ON c.id = ei.contact_id
    JOIN social_events se ON se.id = ei.event_id
    WHERE ei.id = ?
  `).get(invitationId);

  if (!inv || inv.phone !== userPhone) return { ok: false, error: 'Not authorized' };

  db._raw().prepare(`
    UPDATE event_invitations SET status = ?, responded_at = strftime('%s','now') WHERE id = ?
  `).run(status, invitationId);

  // Notify the host via their conversation history (agent picks it up on next turn)
  const host = db.getUser(inv.host_user_id);
  if (host) {
    const verb = status === 'accepted' ? 'accepted' : 'declined';
    const contactName = db._raw().prepare('SELECT name FROM contacts WHERE id = (SELECT contact_id FROM event_invitations WHERE id = ?)').get(invitationId)?.name || 'Someone';
    db.appendConversation(inv.host_user_id, 'system',
      `[System notification] ${contactName} ${verb} the invite to ${inv.title}.`
    );
  }

  return { ok: true, status };
}

function cancelEvent(eventId, hostUserId) {
  db._raw().prepare(`
    UPDATE social_events SET status = 'cancelled' WHERE id = ? AND host_user_id = ?
  `).run(eventId, hostUserId);
}

function getRsvpSummary(eventId) {
  const rows = db._raw().prepare(`
    SELECT status, COUNT(*) as count FROM event_invitations WHERE event_id = ? GROUP BY status
  `).all(eventId);
  return Object.fromEntries(rows.map(r => [r.status, r.count]));
}

// ── Pull-not-push gate ────────────────────────────────────────────────────────

/**
 * Check whether a contact (by phone) was explicitly invited to a specific event.
 * Used to gate disclosure: a contact may only learn about an event if they were chosen.
 *
 * @param {string} contactPhone
 * @param {string} eventId
 * @returns {boolean}
 */
function wasInvited(contactPhone, eventId) {
  const contact = db.getContactByPhone(contactPhone);
  if (!contact) return false;
  return !!db._raw().prepare(`
    SELECT 1 FROM event_invitations WHERE event_id = ? AND contact_id = ?
  `).get(eventId, contact.id);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatEventDate(ts, timezone = 'America/Los_Angeles') {
  const d = new Date(ts * 1000);
  return d.toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

ensureEventTables();

module.exports = {
  createEvent,
  inviteContacts,
  handleRsvpReply,
  // Exposed for eval harness only
  _classifyRsvpPublic: (reply, inviteContext) => classifyRsvp(inviteContext, reply),
  getEvent,
  getEventsByHost,
  getInvitedEvents,
  rsvpInvitation,
  cancelEvent,
  getRsvpSummary,
  wasInvited,
};
