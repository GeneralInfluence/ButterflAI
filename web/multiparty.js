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
const push = require('./push');
const avoid = require('./avoid');
const { ConsentRequired } = require('./sms');
const { createAnthropicClient, DEFAULT_MODEL } = require('./anthropic-client');

const _anthropic = createAnthropicClient();

/**
 * Use Claude to classify an RSVP reply as YES / NO / UNCLEAR.
 * Regex will always lose against natural human language ("absofuckinglutely",
 * "you know it", "lmao yes"). Claude handles all of it.
 */
// Friends answer invites casually. Idioms and rhetorical questions are real answers —
// treating them as UNCLEAR leaves a friend's yes unrecorded (eval: "do bears shit in
// the woods" came back UNCLEAR from Haiku with the one-line prompt).
const RSVP_SYSTEM_PROMPT = `You classify a friend's reply to an invitation. Reply with exactly one word: YES, NO, or UNCLEAR.

- YES: any acceptance, however casual — slang, profanity, emoji, or enthusiasm ("hell yeah", "count me in", "🙌").
- YES: a rhetorical question or idiom whose obvious answer is yes ("is the pope catholic?", "does a bear sleep in the woods?", "you even have to ask?").
- NO: any decline, however soft ("can't make it", "won't be able to", "rain check", "I'll pass").
- UNCLEAR: only when the reply genuinely doesn't commit either way ("maybe", "what time?", "who else is going?").`;

async function classifyRsvp(inviteText, replyText) {
  try {
    const result = await _anthropic.messages.create({
      model: process.env.AGENT_MODEL || DEFAULT_MODEL,
      max_tokens: 10,
      system: RSVP_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Invite: "${inviteText}"\nReply: "${replyText}"\n\nIs this a yes, no, or unclear?`,
      }],
    });
    const word = (result.content[0]?.text || '').trim().toUpperCase();
    if (word === 'YES') return 'yes';
    if (word === 'NO') return 'no';
    return 'unclear';
  } catch (err) {
    // Fallback to a simple keyword check if Claude call fails. Log why: a silent fallback
    // hid missing CI credentials behind "RSVP ... got unclear" eval failures for weeks.
    console.error(`[multiparty] classifyRsvp: Claude call failed (${err.status || err.name}: ${err.message}) — using keyword fallback`);
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
      event_type   TEXT NOT NULL DEFAULT 'private',
      flexible_time  INTEGER DEFAULT 0,   -- 1 = no fixed time ("come when you're ready"), migration 022
      host_attending INTEGER DEFAULT 1,   -- 0 = host bailed but event continues, migration 024
      tentative      INTEGER NOT NULL DEFAULT 0, -- 1 = details still being worked out, migration 035
      group_id       TEXT,                -- contact group this plan is for, migration 038
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS event_invitations (
      id           TEXT PRIMARY KEY,
      event_id     TEXT NOT NULL REFERENCES social_events(id),
      contact_id   TEXT NOT NULL,        -- contacts.id or users.id
      status       TEXT NOT NULL DEFAULT 'invited'
        CHECK (status IN ('invited','accepted','declined','no_response')),
      source       TEXT NOT NULL DEFAULT 'contact',
      notified_at  INTEGER,              -- when invite SMS was sent
      responded_at INTEGER,
      response_note TEXT,
      dismissed_at INTEGER,              -- set when user hides this invite (migration 021)
      needs_owner_decision INTEGER NOT NULL DEFAULT 0, -- invitee must decide before their agent responds (migration 030)
      defers_to    TEXT,                 -- JSON array of names the invitee defers to (migration 037)
      deferred_at  INTEGER,              -- when they deferred (migration 037)
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
function createEvent(hostUserId, { title, activity_type, venue_name, venue_address, scheduled_at, duration_mins, notes, event_type, flexible_time, tentative, group_id }) {
  // flexible_time=true → no fixed time ("come when you're ready"); use now as placeholder timestamp
  const isFlexible = !scheduled_at || flexible_time;
  const ts = isFlexible
    ? Math.floor(Date.now() / 1000)
    : typeof scheduled_at === 'string'
      ? Math.floor(new Date(scheduled_at).getTime() / 1000)
      : scheduled_at;

  const type = event_type === 'public' ? 'public' : 'private';

  // Deduplication: same host + same title within ±6 hours = idempotent, return existing id
  const WINDOW = 6 * 3600;
  const existing = db._raw().prepare(`
    SELECT id FROM social_events
    WHERE host_user_id = ?
      AND LOWER(title) = LOWER(?)
      AND status != 'cancelled'
      AND ABS(scheduled_at - ?) <= ?
    LIMIT 1
  `).get(hostUserId, title, ts, WINDOW);

  if (existing) {
    console.log(`[multiparty] createEvent: deduped — returning existing event ${existing.id}`);
    return existing.id;
  }

  const id = uuidv4();
  db._raw().prepare(`
    INSERT INTO social_events (id, host_user_id, title, activity_type, venue_name, venue_address, scheduled_at, duration_mins, notes, event_type, flexible_time, tentative, group_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, hostUserId, title, activity_type, venue_name || null, venue_address || null,
         ts, duration_mins || 120, notes || null, type, isFlexible ? 1 : 0, tentative ? 1 : 0, group_id || null);

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
/**
 * Queue the "invitee RSVP'd" notice for the host's agent. Shared by
 * confirm_coordination_invite and automatic avoid-list declines, so an automatic
 * decline is indistinguishable from a manual one on the host's side.
 */
function queueHostRsvpNotice({ title, scheduled_at, host_user_id }, inviteeUser, status) {
  const host = db.getUser(host_user_id);
  if (!host) return false;
  const emoji = status === 'accepted' ? '✅' : '❌';
  const ts = new Date(scheduled_at * 1000).toLocaleString('en-US', {
    timeZone: host.timezone || 'America/Los_Angeles',
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const contact = db.getContactByPhone(inviteeUser?.phone);
  const contactName = contact?.name || inviteeUser?.name;
  // Queue for host agent to process proactively
  db.storeInboundMessage({
    from_phone: host.phone,
    from_type: 'user',
    from_id: host.id,
    channel: 'agent',
    text: `[Agent-to-Agent RSVP] ${emoji} ${contactName} has ${status} the invite for "${title}" on ${ts}. Update the host and notify them now.`,
  });
  return true;
}

// Ask a user (via their own agent) to decide on an invite before anyone responds.
function promptOwnerDecision(user, text) {
  db.storeInboundMessage({
    from_phone: user.phone,
    from_type: 'user',
    from_id: user.id,
    channel: 'agent',
    text: `[Invite needs your decision] ${text} Ask the user whether to go. Do not RSVP or contact the host until they answer, and never tell anyone else why.`,
  });
}

function flagForOwnerDecision(invitationId) {
  db._raw().prepare('UPDATE event_invitations SET needs_owner_decision = 1 WHERE id = ?').run(invitationId);
}

/**
 * A newly added invitee may be on the avoid list of a ButterflAI user already
 * invited to this event. Group events with an avoided person always ask
 * (PRIVACY.md owner decision 2), including when the person is added later.
 */
function reviewExistingInvitees(event, newContact, newInvId, whenFor) {
  const others = db._raw().prepare(`
    SELECT ei.id, ei.status, ei.needs_owner_decision, c.phone
    FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
    WHERE ei.event_id = ? AND ei.id != ? AND ei.status IN ('invited','accepted')
  `).all(event.id, newInvId);
  for (const o of others) {
    if (avoid.phoneKey(o.phone) === avoid.phoneKey(newContact.phone)) continue;
    const u = db.getUserByPhone(o.phone);
    if (!u) continue;
    const entry = avoid.findByPhone(avoid.listAvoid(u.id, { context: 'group invite check' }), newContact.phone);
    if (!entry || o.needs_owner_decision) continue;
    flagForOwnerDecision(o.id);
    avoid.recordActivity(u.id, 'needs_decision', {
      eventId: event.id, avoidId: entry.id,
      text: `${entry.name} (on your avoid list) was added to "${event.title}" (${whenFor(u)}). Asked you before responding.`,
    });
    promptOwnerDecision(u, o.status === 'accepted'
      ? `Someone on the user's avoid list was just added to "${event.title}" (${whenFor(u)}), which they already accepted. Check whether they still want to go.`
      : `Someone on the user's avoid list is also invited to "${event.title}" (${whenFor(u)}).`);
  }
}

async function inviteContacts(eventId, contactIds, { quiet = false } = {}) {
  // Guard: refuse to send invites for events that have already passed
  const eventCheck = db._raw().prepare('SELECT scheduled_at, flexible_time FROM social_events WHERE id = ?').get(eventId);
  if (eventCheck && !eventCheck.flexible_time && eventCheck.scheduled_at && eventCheck.scheduled_at < Math.floor(Date.now() / 1000)) {
    return { sent: 0, skipped: contactIds.length, error: 'EVENT_ALREADY_PASSED', message: 'Event time has already passed — reschedule before sending invites.' };
  }

  const event = db._raw().prepare('SELECT * FROM social_events WHERE id = ?').get(eventId);
  if (!event) throw new Error('Event not found');

  const host = db.getUser(event.host_user_id);
  if (!host) throw new Error('Host not found');

  const hostTimezone = host.timezone || 'America/Los_Angeles';
  const whenFor = (u) => event.flexible_time
    ? 'open invite'
    : formatEventDate(event.scheduled_at, u?.timezone || hostTimezone);

  // The host's own avoid list is enforced here, in code (PRIVACY.md Invariant 9):
  // an avoided contact is never invited, whatever the model asked for.
  const hostAvoid = avoid.listAvoid(host.id, { context: 'invite filter' });

  let sent = 0;
  let skipped = 0;
  const avoided = [];
  const invitedIds = [];   // contacts left with a live invitation (quiet mode)

  for (const contactId of contactIds) {
    const contact = db.getContact(contactId);
    if (!contact || contact.invited_by_user_id !== event.host_user_id) { skipped++; continue; }
    if (!contact.phone) { skipped++; continue; }
    if (db.isOptedOut(contact.phone)) { skipped++; continue; }
    if (avoid.findByPhone(hostAvoid, contact.phone)) { skipped++; avoided.push(contact.nickname || contact.name); continue; }

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

    // Anyone already invited who avoids this new person gets asked (owner decision 2).
    reviewExistingInvitees(event, contact, invId, whenFor);

    // Web-first: if the invitee is a ButterflAI user, notify them IN-APP, not by SMS.
    // The invitation row above already surfaces in their invited-events view; we add a
    // best-effort push nudge. SMS is reserved for non-users (the only channel to them).
    const inviteeUser = db.getUserByPhone(contact.phone);
    if (inviteeUser) {
      // The invitee's avoid list acts here. "Act on, never say": the host only ever
      // sees an ordinary decline (same notice as a manual one), never a reason.
      const inviteeAvoid = avoid.listAvoid(inviteeUser.id, { context: 'incoming invite' });
      const hostEntry = avoid.findByPhone(inviteeAvoid, host.phone);
      const groupEntry = hostEntry ? null : db._raw().prepare(`
        SELECT c.phone FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
        WHERE ei.event_id = ? AND ei.id != ?
      `).all(eventId, invId).map((r) => avoid.findByPhone(inviteeAvoid, r.phone)).find(Boolean);

      if (hostEntry && hostEntry.on_invite === 'auto_decline') {
        db._raw().prepare(`UPDATE event_invitations SET status = 'declined', responded_at = strftime('%s','now') WHERE id = ?`).run(invId);
        queueHostRsvpNotice(event, inviteeUser, 'declined');
        avoid.recordActivity(inviteeUser.id, 'auto_declined', {
          eventId, avoidId: hostEntry.id,
          text: `Declined ${host.name}'s invite to "${event.title}" (${whenFor(inviteeUser)}) for you — ${hostEntry.name} is on your avoid list. Switch them to "ask me first" if you'd rather decide.`,
        });
        sent++;
        console.log(`[multiparty] invite event=${eventId} user=${inviteeUser.id} auto-declined (avoid list)`);
        continue;
      }
      if (hostEntry || groupEntry) {
        const entry = hostEntry || groupEntry;
        flagForOwnerDecision(invId);
        avoid.recordActivity(inviteeUser.id, 'needs_decision', {
          eventId, avoidId: entry.id,
          text: hostEntry
            ? `${host.name} invited you to "${event.title}" (${whenFor(inviteeUser)}). ${entry.name} is set to "ask me first", so your agent asked you.`
            : `${host.name} invited you to "${event.title}" (${whenFor(inviteeUser)}). ${entry.name} (on your avoid list) is also invited, so your agent asked you.`,
        });
        promptOwnerDecision(inviteeUser, hostEntry
          ? `${host.name} invited the user to "${event.title}" (${whenFor(inviteeUser)}).`
          : `${host.name} invited the user to "${event.title}" (${whenFor(inviteeUser)}). Someone on the user's avoid list is also invited.`);
      }

      // Quiet (groups.js sends one catch-up). Someone asked privately because of their
      // avoid list isn't in the catch-up — their own agent already asked them.
      if (quiet) { sent++; if (!(hostEntry || groupEntry)) invitedIds.push(contactId); continue; }
      const whenStr = event.flexible_time
        ? 'open invite — come whenever'
        : formatEventDate(event.scheduled_at, inviteeUser.timezone || hostTimezone);
      try {
        await push.notifyUser(db, inviteeUser.id, {
          title: event.tentative ? `${host.name} is planning something` : `${host.name} invited you`,
          body: `${event.activity_type} · ${whenStr}`,
          url: `/app/events?invite=${eventId}`,
        });
      } catch (err) {
        console.error(`[multiparty] push notify failed user=${inviteeUser.id}:`, err.message);
      }
      sent++;
      console.log(`[multiparty] invite in-app event=${eventId} user=${inviteeUser.id} (no SMS — ButterflAI user)`);
      continue;
    }

    if (quiet) { sent++; invitedIds.push(contactId); continue; }
    // Non-user contact → SMS. Use sendUnchecked because the invite message includes a
    // mandatory STOP opt-out — this IS the first-touch consent mechanism. sms.send()
    // would block on ConsentRequired for new contacts, preventing the invite going out.
    const dateStr = event.flexible_time ? 'whenever you\'re free' : formatEventDate(event.scheduled_at, hostTimezone);
    const venueStr = event.venue_name ? ` at ${event.venue_name}` : '';
    const message = buildInviteMessage(host.name, contact.name, event.activity_type, dateStr, venueStr, invId, !!event.flexible_time, !!event.tentative);

    try {
      await sms.sendUnchecked(contact.phone, message);
      sent++;
      console.log(`[multiparty] invite sent event=${eventId} contact=${contactId}`);
    } catch (err) {
      console.error(`[multiparty] invite failed contact=${contactId}:`, err.message);
      skipped++;
    }
  }

  const out = avoided.length ? { sent, skipped, avoided } : { sent, skipped };
  return quiet ? { ...out, invited: invitedIds } : out;
}

/**
 * Build the invite message.
 * Self-identify header is included (agent acting on behalf of host).
 * Contact is given a simple reply mechanism (YES/NO to a shortcode-style reply).
 */
function buildInviteMessage(hostName, contactName, activityType, dateStr, venueStr, invitationId, isFlexible = false, isTentative = false) {
  const baseUrl = process.env.BASE_URL || 'https://butterflai.social';
  const timing = isTentative
    ? `${hostName} is planning ${activityType}${venueStr} (tentatively ${dateStr} — details still being worked out). Interested?`
    : isFlexible
    ? `${hostName} is having ${activityType}${venueStr} — open invite, come over whenever works for you!`
    : `${hostName} is having ${activityType}${venueStr} on ${dateStr} and would love you to join — you in?`;
  // Deep link: /app/chat opens chat inside the PWA on Android (handle_links: preferred).
  // On iOS or non-installed, it opens the web app — either way, lands inside the app not the homepage.
  return (
    `Hi ${contactName}! This is ${hostName}'s ButterflAI.\n\n` +
    `${timing}\n\n` +
    `Open ButterflAI → ${baseUrl}/app/chat\n\n` +
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

  // Resolve the host's timezone once and render every event time in it. The contact was
  // originally invited in the host's tz, so all downstream strings — classifier context,
  // host SMS, host conversation history, and the contact's confirmation — must match it.
  // Without a tz, formatEventDate defaults to LA and shows the wrong day/time.
  const host   = db.getUser(invitation.host_user_id);
  const hostTz = host?.timezone || 'America/Los_Angeles';

  // Use Claude to classify the reply — regex can't handle natural language
  const classification = await classifyRsvp(
    `${invitation.activity_type} on ${formatEventDate(invitation.scheduled_at, hostTz)}`,
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
  if (host) {
    const emoji = isYes ? '✅' : '❌';
    const msg = isYes
      ? `${emoji} ${contact.name} is in for ${invitation.activity_type} on ${formatEventDate(invitation.scheduled_at, hostTz)}!`
      : `${emoji} ${contact.name} can't make it for ${invitation.activity_type} on ${formatEventDate(invitation.scheduled_at, hostTz)}.`;

    // Persist RSVP into host's conversation history so agent has full context
    db.appendConversation(host.id, 'assistant',
      `[System] RSVP received: ${contact.name} has ${status} the invite for ${invitation.activity_type} on ${formatEventDate(invitation.scheduled_at, hostTz)}.`
    );

    if (host.phone) {
      await sms.notifyUser(host.phone, msg).catch(() => {});
    }
  }

  return isYes
    ? `You're in! 🎉 See you on ${formatEventDate(invitation.scheduled_at, hostTz)}.`
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
  // Match by phone OR by the user's own user_id stored on the contact row
  // (contacts added via referral mutual-add have both phone + a matching users row)
  return db._raw().prepare(`
    SELECT
      se.*,
      ei.id     AS invitation_id,
      ei.status AS rsvp_status,
      u.name    AS host_name
    FROM event_invitations ei
    JOIN social_events se ON se.id = ei.event_id
    JOIN contacts c       ON c.id  = ei.contact_id
    JOIN users u          ON u.id  = se.host_user_id
    WHERE c.phone = ?
      AND se.status != 'cancelled'
      AND ei.dismissed_at IS NULL
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
    SELECT ei.*, c.phone, se.host_user_id, se.title, se.scheduled_at, se.activity_type, se.event_type, ei.source
    FROM event_invitations ei
    JOIN contacts c ON c.id = ei.contact_id
    JOIN social_events se ON se.id = ei.event_id
    WHERE ei.id = ?
  `).get(invitationId);

  if (!inv || inv.phone !== userPhone) return { ok: false, error: 'Not authorized' };

  db._raw().prepare(`
    UPDATE event_invitations SET status = ?, responded_at = strftime('%s','now') WHERE id = ?
  `).run(status, invitationId);

  // Notification rules:
  // - Private event: always notify organizer of accept OR decline
  // - Public event, contact-sourced invite: notify of accept AND decline
  // - Public event, public/stranger RSVP: notify on accept only (declines from strangers = noise)
  const isPublicStranger = inv.event_type === 'public' && inv.source === 'public';
  const shouldNotify = !isPublicStranger || status === 'accepted';

  if (shouldNotify) {
    try {
      const host = db.getUser(inv.host_user_id);
      if (host) {
        const verb = status === 'accepted' ? 'accepted' : 'declined';
        const contactRow = db._raw().prepare('SELECT name FROM contacts WHERE id = ?').get(inv.contact_id);
        const contactName = contactRow?.name || 'Someone';
        db.appendConversation(inv.host_user_id, 'system',
          `[System notification] ${contactName} ${verb} the invite to ${inv.title}.`
        );
      }
    } catch (_) {}
  }

  return { ok: true, status };
}

/**
 * Public RSVP — for strangers RSVPing a public event via the /event/:id page.
 * Creates a synthetic contact entry and invitation with source='public'.
 */
function publicRsvp(eventId, { name, phone, status }) {
  const event = db._raw().prepare(`SELECT * FROM social_events WHERE id = ? AND event_type = 'public' AND status = 'open'`).get(eventId);
  if (!event) return { ok: false, error: 'Event not found or not public' };

  // Find or create a synthetic contact on the organizer's side
  let contact = phone ? db._raw().prepare(`SELECT * FROM contacts WHERE invited_by_user_id = ? AND phone = ?`).get(event.host_user_id, phone) : null;
  if (!contact) {
    const cid = uuidv4();
    db._raw().prepare(`INSERT INTO contacts (id, invited_by_user_id, name, phone, tier) VALUES (?, ?, ?, ?, 0)`)
      .run(cid, event.host_user_id, name || 'Guest', phone || null);
    contact = { id: cid };
  }

  // Check for existing invitation
  let invite = db._raw().prepare(`SELECT id, status FROM event_invitations WHERE event_id = ? AND contact_id = ?`).get(eventId, contact.id);
  if (invite) {
    db._raw().prepare(`UPDATE event_invitations SET status = ?, source = 'public', responded_at = strftime('%s','now') WHERE id = ?`).run(status, invite.id);
  } else {
    const iid = uuidv4();
    db._raw().prepare(`INSERT INTO event_invitations (id, event_id, contact_id, status, source, notified_at) VALUES (?, ?, ?, ?, 'public', strftime('%s','now'))`)
      .run(iid, eventId, contact.id, status);
    invite = { id: iid };
  }

  // Notify organizer on accept, not on decline (public stranger)
  if (status === 'accepted') {
    try {
      db.appendConversation(event.host_user_id, 'system',
        `[System notification] ${name || 'A guest'} is attending ${event.title}.`
      );
    } catch (_) {}
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

/**
 * Dismiss an invitation — hide it from the events page permanently.
 * The user must own the contact on the invitation (verified by phone).
 */
function dismissInvitation(invitationId, userPhone) {
  const inv = db._raw().prepare(`
    SELECT ei.id FROM event_invitations ei
    JOIN contacts c ON c.id = ei.contact_id
    WHERE ei.id = ? AND c.phone = ?
  `).get(invitationId, userPhone);
  if (!inv) return { error: 'Invitation not found or not yours' };
  db._raw().prepare(
    `UPDATE event_invitations SET dismissed_at = strftime('%s','now') WHERE id = ?`
  ).run(invitationId);
  return { dismissed: true };
}

module.exports = {
  createEvent,
  inviteContacts,
  formatEventDate,
  queueHostRsvpNotice,
  handleRsvpReply,
  // Exposed for eval harness only
  _classifyRsvpPublic: (reply, inviteContext) => classifyRsvp(inviteContext, reply),
  _RSVP_SYSTEM_PROMPT: RSVP_SYSTEM_PROMPT,
  getEvent,
  getEventsByHost,
  getInvitedEvents,
  dismissInvitation,
  rsvpInvitation,
  publicRsvp,
  cancelEvent,
  getRsvpSummary,
  wasInvited,
};
