/**
 * ButterflAI web server
 *
 * Routes:
 *  POST /sms                          — Twilio inbound SMS webhook (primary human channel)
 *  POST /webhook/telegram/:secret     — Telegram bot webhook (retained for future use)
 *  GET  /invite/:token                — Invite landing page
 *  GET  /api/invite/:token            — Invite metadata (called by invite.html)
 *  POST /api/invite/:token/optout     — Web-based opt-out
 *  POST /api/invite/:token/contact    — Tier 1 contact sign-up (SMS-first)
 *  POST /api/invite/:token/signup     — Tier 2 full account sign-up
 *  GET  /api/contact/:token/data      — Contact views their own data (§7)
 *  POST /api/contact/:token/edit      — Contact edits their own data (§7)
 *  POST /api/agent/invite/create      — Internal: generate invite link
 *  GET  /api/user/:userId/audit       — User reviews their access audit trail
 */

'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const sms = require('./sms');
const { ConsentRequired, RecipientOptedOut } = require('./sms');
const { handleOnboarding } = require('./onboarding');
const { startAgentLoop } = require('./agent');
const { startNudgeLoop } = require('./cadence');
const calendar = require('./calendar');
const contactsImport = require('./contacts-import');
const venues = require('./venues');
const multiparty = require('./multiparty');

// Telegram bot — optional, retained for future use
let telegramBot = null;
try {
  if (process.env.TELEGRAM_BOT_TOKEN) {
    telegramBot = require('./bot').bot;
  }
} catch (_) { /* Telegram optional */ }

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

// ── SMS webhook (primary human channel) ─────────────────────────────────────

// Empty TwiML — we send replies via REST API (outbound-api) to avoid A2P 10DLC
// TwiML outbound-reply suppression on long codes.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// Twilio Messaging Service webhook — using /inbound path (Twilio marks /sms as
// unhealthy after a 500 and stops calling it; fresh path has no failure history)
app.post(['/sms', '/inbound'], sms.validateTwilioRequest, async (req, res) => {
  const body   = (req.body.Body  || '').trim();
  const from   = (req.body.From  || '').trim();   // E.164 caller phone

  console.log(`[SMS] inbound from=${from} body="${body.slice(0, 40)}"`);

  // Always ack Twilio immediately with empty TwiML.
  // Replies are sent via sms.send() / sms.sendUnchecked() (outbound-api)
  // which reliably delivers on A2P 10DLC long codes.
  res.type('text/xml').send(EMPTY_TWIML);

  // ─── Async reply handling (after HTTP response sent) ─────────────────────

  try {
    // 1. STOP — highest priority
    if (/^stop$/i.test(body) || /^stop\b/i.test(body)) {
      db.recordOptOut(from, 'stop_reply');
      await sms.sendUnchecked(from,
        `You've been opted out and won't receive any more messages from ButterflAI. ` +
        `Text START to re-subscribe at any time.`);
      return;
    }

    // 2. START — re-subscribe
    if (/^start$/i.test(body)) {
      const existingUser = db.getUserByPhone(from);
      db.removeOptOut(from);
      if (existingUser && existingUser.onboarding_state === 'complete') {
        db.writeConsent(from, 'SELF_START');
        await sms.sendUnchecked(from, `Welcome back! You're re-subscribed to ButterflAI. Text me anytime. 🦋`);
        return;
      }
      // New user or mid-onboarding: fall through to onboarding
    }

    // 3. Opt-out gate
    if (db.isOptedOut(from)) {
      return; // silently drop
    }

    // 4a. RSVP reply check — runs for ANYONE with a pending event invitation.
    // Also handles logistics replies: if this phone was recently coordinated with
    // as a contact (invited to an event within 48h), route their reply to the HOST's
    // agent rather than their own — even if they're a registered ButterflAI user.
    const existingContact = db.getContactByPhone(from);
    if (existingContact) {
      // Try pending RSVP first
      const rsvpReply = await multiparty.handleRsvpReply(from, body).catch(() => null);
      if (rsvpReply) {
        await sms.sendUnchecked(from, rsvpReply);
        return;
      }

      // Check for recent coordination context (invited within 48h, any status)
      const recentInvitation = db._raw().prepare(`
        SELECT ei.*, se.host_user_id, se.title, se.activity_type, se.scheduled_at
        FROM event_invitations ei
        JOIN social_events se ON se.id = ei.event_id
        WHERE ei.contact_id = ? AND ei.notified_at > strftime('%s','now') - 172800
        ORDER BY ei.notified_at DESC LIMIT 1
      `).get(existingContact.id);

      // If they have recent coordination context but are also a user,
      // fall through to their own agent — it now has the coordination context injected
      // via the pending_coordination state snapshot. Their agent will call
      // confirm_coordination_invite and notify the host agent directly.

      // Pure contact with no coordination context — store and ACK
      if (!db.getUserByPhone(from)) {
        db.storeInboundMessage({
          from_phone: from, from_type: 'contact', from_id: existingContact.id, channel: 'sms', text: body,
        });
        await sms.sendUnchecked(from, `Got it! I'll pass that along. 👍`);
        return;
      }
    }

    // 4. Route: onboarding vs. established user
    const user = db.getUserByPhone(from);
    const isOnboarding = !user || user.onboarding_state !== 'complete';
    let reply;

    if (isOnboarding) {
      reply = await handleOnboarding(from, body, db);
    } else {
      const pending = db.getPendingAction(user.id);
      if (pending) {
        reply = await handlePendingAction(user, body, pending);
      } else {
        db.storeInboundMessage({
          from_phone: from,
          from_type: 'user',
          from_id: user.id,
          channel: 'sms',
          text: body,
        });
        // No ACK reply — agent will respond directly. Sending "Got it! 🦋"
        // before every agent response is noisy and confusing.
        reply = null;
      }
    }

    if (reply) {
      // Use sendUnchecked for all inbound-triggered replies — the act of texting
      // us is itself consent for a response. sms.send() consent gate is for
      // proactive outbound only.
      await sms.sendUnchecked(from, reply);
    }

  } catch (err) {
    console.error('[SMS] handler error:', err.message || err);
    try {
      await sms.sendUnchecked(from, `Something went wrong on my end — I'll be back shortly. Sorry!`);
    } catch (sendErr) {
      console.error('[SMS] sendUnchecked fallback failed:', sendErr.message || sendErr);
    }
  }
});

// Also handle inbound SMS from contacts (could arrive on same number)
// The routing above covers contacts if they text in — they'll fall through to
// the established-user path or onboarding. For now, contacts who text in
// are queued as inbound_messages with from_type='contact'.

// ── Telegram webhook (legacy / optional) ─────────────────────────────────────

app.post(
  `/webhook/telegram/${process.env.WEBHOOK_SECRET || 'butterflai-secret'}`,
  (req, res) => {
    if (telegramBot) telegramBot.processUpdate(req.body);
    res.sendStatus(200);
  }
);

// ── Invite landing page ───────────────────────────────────────────────────────

app.get('/invite/:token', (req, res) => {
  const invite = db.getInvite(req.params.token);
  if (!invite) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  if (invite.status !== 'pending') return res.sendFile(path.join(__dirname, 'public', 'already-resolved.html'));
  res.sendFile(path.join(__dirname, 'public', 'invite.html'));
});

app.get('/api/invite/:token', (req, res) => {
  const invite = db.getInvite(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  const inviter = db.getUser(invite.created_by_user_id);
  res.json({
    token: invite.token,
    inviterName: inviter?.name || 'Someone',
    contactName: invite.contact_name,
    status: invite.status,
  });
});

// ── Opt-out (web) ─────────────────────────────────────────────────────────────

app.post('/api/invite/:token/optout', async (req, res) => {
  const invite = db.getInvite(req.params.token);
  if (!invite || invite.status !== 'pending') {
    return res.status(400).json({ error: 'Invalid or already resolved invite' });
  }

  const name = req.body.name || invite.contact_name || 'Someone';
  const phone = req.body.phone || null;

  const contactId = uuidv4();
  db.createContact({ id: contactId, invited_by_user_id: invite.created_by_user_id, name, phone, tier: 0,
                     opted_out_at: Math.floor(Date.now() / 1000) });
  db.resolveInvite(invite.token, 'opted_out', contactId);

  if (phone) db.recordOptOut(phone, 'web');

  // Notify inviter via SMS
  const inviter = db.getUser(invite.created_by_user_id);
  if (inviter?.phone) {
    await sms.notifyUser(inviter.phone,
      `👋 ${name} saw your ButterflAI invite and opted out. They won't be contacted again.`
    ).catch(() => {});
  }

  res.json({ ok: true });
});

// ── Tier 1: Contact mode opt-in ───────────────────────────────────────────────

app.post('/api/invite/:token/contact', async (req, res) => {
  const invite = db.getInvite(req.params.token);
  if (!invite || invite.status !== 'pending') {
    return res.status(400).json({ error: 'Invalid or already resolved invite' });
  }

  const { name, phone, availability, neighborhoods, dietary } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone number required' });
  }

  // Check opt-out status before creating anything
  if (db.isOptedOut(phone)) {
    return res.status(400).json({ error: 'This number has opted out' });
  }

  const contactId = uuidv4();
  db.createContact({
    id: contactId,
    invited_by_user_id: invite.created_by_user_id,
    name,
    phone,
    tier: 1,
  });
  db.setContactPreferences({
    contact_id: contactId,
    availability_notes: availability || null,
    neighborhoods: neighborhoods || null,
    dietary: dietary || null,
    comm_preference: 'sms',
  });
  // Record INVITE_PAGE consent: contact personally opted in via the invite page
  db.writeConsent(phone, 'INVITE_PAGE');
  db.resolveInvite(invite.token, 'accepted_contact', contactId);

  // Notify inviter
  const inviter = db.getUser(invite.created_by_user_id);
  if (inviter?.phone) {
    await sms.notifyUser(inviter.phone,
      `✅ ${name} accepted your ButterflAI invite! I can now coordinate plans with them.`
    ).catch(() => {});
  }

  res.json({ ok: true, tier: 1, contactId });
});

// ── Tier 2: Full ButterflAI signup ────────────────────────────────────────────

app.post('/api/invite/:token/signup', async (req, res) => {
  const invite = db.getInvite(req.params.token);
  if (!invite || invite.status !== 'pending') {
    return res.status(400).json({ error: 'Invalid or already resolved invite' });
  }

  const { name, phone, availability, neighborhoods, dietary } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone number required' });
  }

  if (db.isOptedOut(phone)) {
    return res.status(400).json({ error: 'This number has opted out' });
  }

  // Create full user account (onboarding_state: complete — they'll receive agent messages)
  const userId = uuidv4();
  db.createUser({ id: userId, name, phone, onboarding_state: 'complete' });

  db.setContactPreferences({
    contact_id: userId,
    availability_notes: availability || null,
    neighborhoods: neighborhoods || null,
    dietary: dietary || null,
    comm_preference: 'sms',
  });

  // Create a contact record linking back to the inviter
  const contactId = uuidv4();
  db.createContact({
    id: contactId,
    invited_by_user_id: invite.created_by_user_id,
    name,
    phone,
    tier: 2,
  });

  // Record INVITE_PAGE consent: new full user opted in via the invite page
  db.writeConsent(phone, 'INVITE_PAGE');
  db.resolveInvite(invite.token, 'accepted_full', contactId);

  // Notify inviter
  const inviter = db.getUser(invite.created_by_user_id);
  if (inviter?.phone) {
    await sms.notifyUser(inviter.phone,
      `🦋 ${name} signed up for their own ButterflAI! Our agents can now coordinate automatically.`
    ).catch(() => {});
  }

  // Welcome the new user via SMS
  await sms.notifyUser(phone,
    `Welcome to ButterflAI, ${name}! 🦋\n\n` +
    `I'm your social agent — I'll keep you connected with people you care about without the scheduling chaos.\n\n` +
    `You'll hear from me when a friend wants to make plans. Reply STOP anytime to opt out.`
  ).catch(() => {});

  res.json({ ok: true, tier: 2, userId });
});

// ── Contact self-service portal (§7) — HTML entry point ──────────────────────

app.get('/contact/:token', (req, res) => {
  const invite = db.getInvite(req.params.token);
  if (!invite || !invite.contact_id) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  // Redirect to portal with token as query param so the client JS can read it
  res.redirect(`/contact-portal.html?token=${encodeURIComponent(req.params.token)}`);
});

// ── Contact self-service portal (§7) — API ───────────────────────────────────
// Contacts can view + edit the data stored about them, and opt out — without
// going through the user. Reached via a link in the invite SMS.

app.get('/api/contact/:token/data', (req, res) => {
  const invite = db.getInvite(req.params.token);
  if (!invite || !invite.contact_id) return res.status(404).json({ error: 'Not found' });

  const contact = db.getContact(invite.contact_id);
  if (!contact) return res.status(404).json({ error: 'Not found' });

  const prefs = db.getContactPreferences(contact.id) || {};

  res.json({
    name: contact.name,
    phone: contact.phone,
    tier: contact.tier,
    availability_notes: prefs.availability_notes,
    neighborhoods: prefs.neighborhoods ? JSON.parse(prefs.neighborhoods) : [],
    dietary: prefs.dietary ? JSON.parse(prefs.dietary) : [],
    comm_preference: prefs.comm_preference || 'sms',
  });
});

app.post('/api/contact/:token/edit', async (req, res) => {
  const invite = db.getInvite(req.params.token);
  if (!invite || !invite.contact_id) return res.status(404).json({ error: 'Not found' });

  const contact = db.getContact(invite.contact_id);
  if (!contact) return res.status(404).json({ error: 'Not found' });

  const { name, availability, neighborhoods, dietary, comm_preference, action } = req.body;

  // Erase / downgrade
  if (action === 'erase') {
    db.optOutContact(contact.id);
    if (contact.phone) db.recordOptOut(contact.phone, 'web');
    // Notify the user that the contact erased their data (§7 edit-conflict rule: contact wins)
    const inviter = db.getUser(invite.created_by_user_id);
    if (inviter?.phone) {
      await sms.notifyUser(inviter.phone,
        `ℹ️ ${contact.name} removed their data from ButterflAI and has opted out. I've updated my records.`
      ).catch(() => {});
    }
    return res.json({ ok: true, action: 'erased' });
  }

  // Edit — contact's version wins, user is notified of any changes (§7 LOCKED rule)
  const updatedFields = {};
  if (name && name !== contact.name) updatedFields.name = name;

  if (Object.keys(updatedFields).length) {
    db.updateContact(contact.id, updatedFields);
  }

  db.setContactPreferences({
    contact_id: contact.id,
    availability_notes: availability ?? null,
    neighborhoods: neighborhoods ?? null,
    dietary: dietary ?? null,
    comm_preference: comm_preference || 'sms',
  });

  // Notify user of any contact-side edits
  const inviter = db.getUser(invite.created_by_user_id);
  if (inviter?.phone && Object.keys(updatedFields).length) {
    await sms.notifyUser(inviter.phone,
      `ℹ️ ${contact.name} updated their info in ButterflAI. I've applied their changes.`
    ).catch(() => {});
  }

  res.json({ ok: true });
});

// ── Public web opt-in (/join page) ───────────────────────────────────────────
// Standalone opt-in endpoint — no invite token required.
// Consent source: INVITE_PAGE (same as the invite-page flow, distinct from SELF_START).

app.post('/api/join', async (req, res) => {
  const { name, phone } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  if (!phone || !phone.trim()) {
    return res.status(400).json({ error: 'Mobile number is required.' });
  }

  const normalizedPhone = phone.trim();

  // Reject if previously opted out
  if (db.isOptedOut(normalizedPhone)) {
    return res.status(400).json({
      error: 'This number has previously opted out. Text START to +12202721479 to re-subscribe.',
    });
  }

  // Write consent record — source INVITE_PAGE (web-based opt-in)
  db.writeConsent(normalizedPhone, 'INVITE_PAGE');

  // Create user account (or update if already exists)
  const existingUser = db.getUserByPhone(normalizedPhone);
  if (!existingUser) {
    const { v4: uuidv4 } = require('uuid');
    db.createUser({
      id: uuidv4(),
      name: name.trim(),
      phone: normalizedPhone,
      onboarding_state: 'complete',
    });
  }

  // Send welcome SMS
  await sms.notifyUser(normalizedPhone,
    `Welcome to ButterflAI, ${name.trim()}! 🦋\n\n` +
    `I'm your personal social agent — I'll help you stay meaningfully connected ` +
    `with the people who matter.\n\n` +
    `Text me anytime. Reply STOP to opt out, HELP for help.`
  ).catch(err => console.error('[join] welcome SMS failed:', err.message));

  res.json({ ok: true });
});

// ── Internal agent API ────────────────────────────────────────────────────────

app.post('/api/agent/invite/create', (req, res) => {
  const { userId, contactName } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const user = db.getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const token = uuidv4().replace(/-/g, '');
  db.createInvite({ token, created_by_user_id: userId, contact_name: contactName || null });

  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  res.json({ token, url: `${baseUrl}/invite/${token}` });
});

// ── User access audit (§2.4) ──────────────────────────────────────────────────

app.get('/api/user/:userId/audit', (req, res) => {
  // TODO: auth — verify request comes from the user themselves (session token)
  const rows = db.getAccessAuditForUser(req.params.userId);
  res.json({ audit: rows });
});

// ── Pending action handler ────────────────────────────────────────────────────

async function handlePendingAction(user, body, pending) {
  const payload = JSON.parse(pending.payload || '{}');
  const lower = body.toLowerCase().trim();
  const isYes = /^y(es|ep|eah)?[.!]?$/i.test(lower) || lower === 'sure' || lower === 'ok' || lower === 'yep';
  const isNo  = /^n(o|ope)?[.!]?$/i.test(lower) || lower === 'nah' || lower === 'not now' || lower === 'skip';

  if (pending.action_type === 'nudge_confirm') {
    db.deletePendingAction(pending.id);

    if (isYes) {
      // Queue a rich message for the agent loop — it has full tool access
      db.storeInboundMessage({
        from_phone: user.phone,
        from_type: 'user',
        from_id: user.id,
        channel: 'sms',
        text: `Please set up a ${payload.frequency} ${payload.activity_type || 'hangout'} with ${payload.contact_name}. Cadence ID: ${payload.cadence_id}. Check my calendar for free slots, then reach out to them.`,
      });
      return `On it — I'll check your calendar and reach out to ${payload.contact_name}. 🦋`;
    }

    if (isNo) {
      return `No problem, I'll remind you again later. 👍`;
    }

    // Ambiguous — re-queue as generic message so agent can figure it out
    db.storeInboundMessage({
      from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'sms', text: body,
    });
    return `Got it — I'll look into that. 🦋`;
  }

  if (pending.action_type === 'approve_message') {
    db.deletePendingAction(pending.id);

    if (isYes) {
      // Send the approved draft — three outcomes handled explicitly.
      const contact = db.getContact(payload.contact_id);
      const contactName = payload.contact_name || contact?.name || 'that contact';

      if (!contact?.phone) {
        return `Couldn't send — ${contactName} has no phone number on file.`;
      }

      try {
        await sms.send(contact.phone, payload.draft_text);
        return `Sent to ${contactName}. ✅`;
      } catch (err) {
        if (err instanceof RecipientOptedOut) {
          return `${contactName} has opted out of ButterflAI, so I can't text them. ` +
                 `You can still reach out from your own phone.`;
        }
        if (err instanceof ConsentRequired) {
          // Contact hasn't opted in — hand the draft back for user to send themselves.
          const encodedBody = encodeURIComponent(payload.draft_text);
          const smsLink = `sms:${contact.phone}?body=${encodedBody}`;
          return `${contactName} hasn't opted in to ButterflAI yet, so I can't send from ` +
                 `our number. Send it yourself: ${smsLink}`;
        }
        throw err;
      }
    }

    if (isNo) {
      return `No problem, I won't send it. Want me to revise the message?`;
    }

    // Treat as edited version of the message
    const editContact = db.getContact(payload.contact_id);
    const editName = payload.contact_name || editContact?.name || 'that contact';
    if (!editContact?.phone) {
      return `Got it — but I couldn't find a number for ${editName}.`;
    }
    try {
      await sms.send(editContact.phone, body);
      return `Sent your version to ${editName}. ✅`;
    } catch (err) {
      if (err instanceof RecipientOptedOut) {
        return `${editName} has opted out — I can't text them from our number.`;
      }
      if (err instanceof ConsentRequired) {
        const encodedBody = encodeURIComponent(body);
        return `${editName} hasn't opted in yet. Send it yourself: sms:${editContact.phone}?body=${encodedBody}`;
      }
      throw err;
    }
  }

  if (pending.action_type === 'confirm_booking') {
    db.deletePendingAction(pending.id);

    if (isYes) {
      db.storeInboundMessage({
        from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'sms',
        text: `Confirm the booking: ${JSON.stringify(payload)}`,
      });
      return `Booking it now! 🎉`;
    }

    if (isNo) {
      return `Ok, I'll suggest other options. What would you prefer?`;
    }

    db.storeInboundMessage({
      from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'sms', text: body,
    });
    return `Got it. 🦋`;
  }

  // Unknown action type — fall through to generic
  db.deletePendingAction(pending.id);
  db.storeInboundMessage({
    from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'sms', text: body,
  });
  return `Got it! 🦋`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTwiml() {
  const messages = [];
  return {
    push: (text) => messages.push(text),
    toString: () => {
      const body = messages.map(m => `<Message>${escapeXml(m)}</Message>`).join('');
      return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
    },
  };
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Start ─────────────────────────────────────────────────────────────────────

// ── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  // Verify DB is reachable
  try {
    db._raw().prepare('SELECT 1').get();
    res.json({ ok: true, ts: Date.now() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Venue API ─────────────────────────────────────────────────────────────────

app.get('/api/venues/favorites/:userId', (req, res) => {
  res.json({ favorites: venues.getFavorites(req.params.userId) });
});

app.post('/api/venues/favorites', (req, res) => {
  const { userId, ...venue } = req.body;
  if (!userId || !venue.name) return res.status(400).json({ error: 'userId and name required' });
  const id = venues.addFavorite(userId, venue);
  res.json({ ok: true, id });
});

app.delete('/api/venues/favorites/:userId/:venueId', (req, res) => {
  venues.removeFavorite(req.params.userId, req.params.venueId);
  res.json({ ok: true });
});

// ── Events API ────────────────────────────────────────────────────────────────

app.post('/api/events', async (req, res) => {
  const { userId, contactIds, ...eventData } = req.body;
  if (!userId || !eventData.title) return res.status(400).json({ error: 'userId and title required' });
  try {
    const eventId = multiparty.createEvent(userId, eventData);
    let inviteResult = { sent: 0, skipped: 0 };
    if (contactIds?.length) {
      inviteResult = await multiparty.inviteContacts(eventId, contactIds);
    }
    res.json({ ok: true, eventId, ...inviteResult });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/events/:userId', (req, res) => {
  res.json({ events: multiparty.getEventsByHost(req.params.userId) });
});

app.get('/api/events/:userId/:eventId', (req, res) => {
  const event = multiparty.getEvent(req.params.eventId);
  if (!event || event.host_user_id !== req.params.userId) return res.status(404).json({ error: 'Not found' });
  res.json({ event, rsvp: multiparty.getRsvpSummary(req.params.eventId) });
});

// ── Google OAuth callbacks ────────────────────────────────────────────────────

// Initiate Google Calendar OAuth for a user (linked from SMS: "Connect your calendar: <url>")
app.get('/auth/google/calendar', (req, res) => {
  const { userId } = req.query;
  if (!userId || !db.getUser(userId)) return res.status(400).send('Invalid userId');
  const url = calendar.getAuthUrl(userId);
  res.redirect(url);
});

// Apple Calendar connect — user submits Apple ID + app-specific password
app.get('/auth/apple/calendar', (req, res) => {
  const { userId } = req.query;
  if (!userId || !db.getUser(userId)) return res.status(400).send('Invalid userId');
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect Apple Calendar — ButterflAI</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🦋</text></svg>">
  <style>
    body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem;box-sizing:border-box}
    .card{background:#1a1a2e;border-radius:16px;padding:2rem;max-width:440px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.4)}
    h2{margin:0 0 .5rem;font-size:1.4rem}
    p{color:#aaa;font-size:.9rem;line-height:1.5;margin:.5rem 0 1.5rem}
    a{color:#7c6fcd}
    label{display:block;font-size:.85rem;color:#aaa;margin-bottom:.25rem}
    input{width:100%;padding:.75rem;border-radius:8px;border:1px solid #333;background:#0f0f0f;color:#fff;font-size:1rem;box-sizing:border-box;margin-bottom:1rem}
    button{width:100%;padding:.85rem;border-radius:8px;border:none;background:linear-gradient(135deg,#7c6fcd,#a855f7);color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
    .note{font-size:.8rem;color:#666;margin-top:1rem;text-align:center}
  </style>
</head><body>
  <div class="card">
    <div style="font-size:2.5rem;margin-bottom:1rem">🦋🍎</div>
    <h2>Connect Apple Calendar</h2>
    <p>ButterflAI needs an <strong>app-specific password</strong> (not your regular Apple ID password).<br>
    Generate one at <a href="https://appleid.apple.com" target="_blank">appleid.apple.com</a> → Sign-In and Security → App-Specific Passwords.</p>
    <form method="POST" action="/auth/apple/calendar">
      <input type="hidden" name="userId" value="${userId}">
      <label>Apple ID (email)</label>
      <input type="email" name="appleId" placeholder="you@icloud.com" required autocomplete="username">
      <label>App-Specific Password</label>
      <input type="password" name="appPassword" placeholder="xxxx-xxxx-xxxx-xxxx" required autocomplete="current-password">
      <button type="submit">Connect Calendar 🗓️</button>
    </form>
    <p class="note">Your password is encrypted and never stored in plain text.</p>
  </div>
</body></html>`);
});

app.post('/auth/apple/calendar', async (req, res) => {
  const { userId, appleId, appPassword } = req.body;
  if (!userId || !appleId || !appPassword) return res.status(400).send('Missing fields');
  const user = db.getUser(userId);
  if (!user) return res.status(400).send('Invalid userId');

  try {
    await calendar.saveAppleCredentials(userId, { appleId, appPassword });

    // Try to get timezone from iCloud
    const tz = await calendar.getCalendarTimezone(userId).catch(() => null);
    if (tz) db.updateUser(userId, { timezone: tz });

    db.appendConversation(userId, 'assistant',
      `[System] Apple Calendar connected${tz ? ` (timezone: ${tz})` : ''}. You can now check availability and create events on the user's iCloud Calendar.`
    );

    if (user.phone) {
      await sms.notifyUser(user.phone, `📅 Your Apple Calendar is connected! I can now check your availability and add events.`).catch(() => {});
    }

    res.send(`<!DOCTYPE html><html lang="en"><head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Calendar Connected — ButterflAI</title>
      <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🦋</text></svg>">
      <style>body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
      .card{background:#1a1a2e;border-radius:16px;padding:2rem;max-width:400px;text-align:center}</style>
    </head><body>
      <div class="card">
        <div style="font-size:3rem">🦋✅</div>
        <h2>Apple Calendar Connected!</h2>
        <p style="color:#aaa">ButterflAI can now check your availability and add events to your iCloud Calendar.</p>
      </div>
    </body></html>`);
  } catch (err) {
    console.error('[apple-calendar] connect error:', err.message);
    res.status(500).send('Failed to connect — check your Apple ID and app-specific password.');
  }
});

// Initiate Google Contacts OAuth
app.get('/auth/google/contacts', (req, res) => {
  const { userId } = req.query;
  if (!userId || !db.getUser(userId)) return res.status(400).send('Invalid userId');
  const url = contactsImport.getGoogleContactsAuthUrl(userId);
  res.redirect(url);
});

// Shared OAuth callback (handles both calendar and contacts based on state prefix)
app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.warn('[oauth] user denied:', error);
    return res.send('Authorization cancelled. You can close this window.');
  }

  try {
    if (state?.startsWith('contacts:')) {
      // Google Contacts
      const userId = state.replace('contacts:', '');
      const user = db.getUser(userId);
      if (!user) return res.status(400).send('Unknown user');

      // Exchange code for tokens inline using the Google client
      const { google: goog } = require('googleapis');
      const client = new goog.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI || `${process.env.BASE_URL}/auth/google/callback`
      );
      const { tokens } = await client.getToken(code);
      const result = await contactsImport.importFromGoogle(userId, tokens);

      // Notify user via SMS
      if (user.phone) {
        await sms.notifyUser(user.phone,
          `📱 Imported ${result.imported} contact${result.imported !== 1 ? 's' : ''} from Google. ` +
          `Reply "show contacts" to see who you could invite.`
        ).catch(() => {});
      }
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Contacts Imported — ButterflAI</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🦋</text></svg>">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #faf9f7;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: white;
      border-radius: 24px;
      padding: 44px 32px;
      max-width: 380px;
      width: 100%;
      text-align: center;
      box-shadow: 0 4px 32px rgba(124,58,237,0.10);
    }
    .check {
      width: 72px; height: 72px;
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 20px;
      font-size: 32px;
    }
    h1 { font-size: 26px; font-weight: 800; color: #1a1a1a; margin-bottom: 8px; }
    .count { color: #7c3aed; }
    .sub {
      font-size: 15px; color: #666; line-height: 1.6; margin-bottom: 28px;
    }
    .pill {
      display: inline-block;
      background: #f5f3ff;
      color: #7c3aed;
      font-size: 13px;
      font-weight: 600;
      padding: 6px 14px;
      border-radius: 999px;
      margin-bottom: 28px;
    }
    .hint {
      font-size: 13px; color: #aaa; line-height: 1.6;
    }
    .brand {
      margin-top: 32px;
      font-size: 20px;
      font-weight: 800;
      color: #7c3aed;
      letter-spacing: -0.5px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1><span class="count">${result.imported.toLocaleString()}</span> contacts imported</h1>
    <p class="sub">Your address book is synced. Text me a name and I'll know exactly who you mean.</p>
    <div class="pill">🦋 You'll get a text shortly</div>
    <p class="hint">You can close this window and go back to your conversation.</p>
    <div class="brand">ButterflAI</div>
  </div>
</body>
</html>`);

    } else {
      // Google Calendar (state = userId)
      const userId = state;
      const user = db.getUser(userId);
      if (!user) return res.status(400).send('Unknown user');

      await calendar.handleOAuthCallback(code, userId);

      // Pull timezone from the primary calendar and persist it
      const calTz = await calendar.getCalendarTimezone(userId).catch(() => null);
      if (calTz) {
        db.updateUser(userId, { timezone: calTz });
        console.log(`[calendar] timezone set for user ${userId}: ${calTz}`);
      }

      // Write to conversation history so the agent knows on the next turn
      db.appendConversation(userId, 'assistant',
        `[System] Google Calendar successfully connected. Timezone detected: ${calTz || 'unknown'}. You can now check availability, find free slots, or create calendar events.`
      );

      if (user.phone) {
        await sms.notifyUser(user.phone,
          `📅 Your Google Calendar is connected! I can now check your real availability when coordinating plans.`
        ).catch(() => {});
      }
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Calendar Connected — ButterflAI</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🦋</text></svg>">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #faf9f7; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      background: white; border-radius: 24px; padding: 44px 32px;
      max-width: 380px; width: 100%; text-align: center;
      box-shadow: 0 4px 32px rgba(124,58,237,0.10);
    }
    .icon {
      width: 72px; height: 72px;
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 20px; font-size: 34px;
    }
    h1 { font-size: 24px; font-weight: 800; color: #1a1a1a; margin-bottom: 8px; }
    .sub { font-size: 15px; color: #666; line-height: 1.6; margin-bottom: 28px; }
    .pill {
      display: inline-block; background: #f5f3ff; color: #7c3aed;
      font-size: 13px; font-weight: 600; padding: 6px 14px;
      border-radius: 999px; margin-bottom: 28px;
    }
    .hint { font-size: 13px; color: #aaa; line-height: 1.6; }
    .brand { margin-top: 32px; font-size: 20px; font-weight: 800; color: #7c3aed; letter-spacing: -0.5px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📅</div>
    <h1>Calendar connected!</h1>
    <p class="sub">I can now check your real availability when coordinating plans — no more double-booking.</p>
    <div class="pill">🦋 You'll get a text shortly</div>
    <p class="hint">You can close this window and go back to your conversation.</p>
    <div class="brand">ButterflAI</div>
  </div>
</body>
</html>`);
    }
  } catch (err) {
    console.error('[oauth] callback error:', err.message);
    res.status(500).send('Something went wrong. Please try again.');
  }
});

// ── Contact import API ────────────────────────────────────────────────────────

// Add a contact manually (user's "people I could invite" list)
// Bulk import from Contact Picker API (phone-native, no computer needed)
app.post('/api/contacts/import', (req, res) => {
  const { userId, contacts } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts must be an array' });

  const user = db.getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let imported = 0, skipped = 0;
  for (const c of contacts) {
    if (!c.name || !c.phone) { skipped++; continue; }
    try {
      db.upsertContact({ invited_by_user_id: userId, name: c.name, phone: c.phone, tier: 0 });
      imported++;
    } catch (_) { skipped++; }
  }
  console.log(`[contacts] bulk import userId=${userId} imported=${imported} skipped=${skipped}`);
  res.json({ ok: true, imported, skipped });
});

// Get a signed import link (agent sends this to the user)
app.get('/api/contacts/import-url/:userId', (req, res) => {
  const user = db.getUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'not found' });
  const baseUrl = process.env.BASE_URL || 'https://butterflai.social';
  res.json({ url: `${baseUrl}/contacts-import.html?userId=${user.id}` });
});

app.post('/api/contacts/add', (req, res) => {
  const { userId, name, phone } = req.body;
  if (!userId || !name) return res.status(400).json({ error: 'userId and name required' });
  try {
    const contactId = contactsImport.addManualContact(userId, { name, phone });
    res.json({ ok: true, contactId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get importable (Tier 0) contacts
app.get('/api/contacts/importable/:userId', (req, res) => {
  const contacts = contactsImport.getImportableContacts(req.params.userId);
  res.json({ contacts });
});

// Get active (Tier 1+) contacts
app.get('/api/contacts/active/:userId', (req, res) => {
  const contacts = contactsImport.getActiveContacts(req.params.userId);
  res.json({ contacts });
});

// Send an invite to a specific Tier 0 contact (Gate 2)
app.post('/api/contacts/invite', async (req, res) => {
  const { userId, contactId, context } = req.body;
  if (!userId || !contactId) return res.status(400).json({ error: 'userId and contactId required' });
  try {
    const result = await contactsImport.sendInvite(userId, contactId, context || 'keeping in touch');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`ButterflAI web running on :${PORT}`);
  startAgentLoop();
  startNudgeLoop();
});
