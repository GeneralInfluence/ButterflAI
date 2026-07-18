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

const cookieParser = require('cookie-parser');
const db = require('./db');
const sms = require('./sms');
const { ConsentRequired, RecipientOptedOut } = require('./sms');
const sse      = require('./sse');
const sensitive = require('./sensitive');
const webAuth  = require('./webapp-auth');
const { handleOnboarding } = require('./onboarding');
const { startAgentLoop } = require('./agent');
const { startNudgeLoop } = require('./cadence');
const { startCoordLoop }           = require('./coord-loop');
const { mcpTransport, handleInboundRequest } = require('./mcp-transport');
const calendar = require('./calendar');
const adminRouter = require('./admin');
const contactsImport = require('./contacts-import');
const venues = require('./venues');
const push   = require('./push');
const multiparty = require('./multiparty');
const lift = require('./lift');
const flai = require('./flai');

// Telegram bot — optional, retained for future use
let telegramBot = null;
try {
  if (process.env.TELEGRAM_BOT_TOKEN) {
    telegramBot = require('./bot').bot;
  }
} catch (_) { /* Telegram optional */ }

const app = express();
const PORT = process.env.PORT || 3000;

// Fly.io (and most production reverse proxies) set X-Forwarded-For.
// Without trust proxy, express-rate-limit throws a ValidationError on every request.
app.set('trust proxy', 1);

// Force-revalidate HTML pages on every request so app updates are always picked up.
// Static assets (JS/CSS/images) still get ETag caching from express.static.
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path.startsWith('/app/') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Temporary request logger for debugging
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    console.log(`[req] ${req.method} ${req.path} cookie=${req.headers.cookie ? 'yes' : 'NO'} ip=${req.ip}`);
  }
  next();
});

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// All /api/* responses must never be cached
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ── Auth guard for /app/* — must run BEFORE static middleware ─────────────────
// Without this, static middleware serves HTML files directly, bypassing auth.
app.use('/app', (req, res, next) => {
  // /app/login is public — no auth required
  if (req.path === '/login' || req.path === '/login.html') return next();
  const token = req.cookies?.[webAuth.COOKIE_NAME];
  if (!token) return res.redirect('/app/login');
  const payload = webAuth.verifyToken(token);
  if (!payload) return res.redirect('/app/login');
  try {
    const user = db.getUser(payload.userId);
    if (!user) return res.redirect('/app/login');
  } catch { return res.redirect('/app/login'); }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

// Stricter rate limits for write endpoints bots like to hammer.
// Skipped in NODE_ENV=test so test suites aren't blocked by their own requests.
const skipInTest = () => process.env.NODE_ENV === 'test';
const joinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 8,
  skip: skipInTest,
  message: { error: 'Too many signup attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  skip: skipInTest,
  message: { error: 'Too many OTP requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Input validation helpers ──────────────────────────────────────────────────

const { toE164 } = require('./phoneUtils');

/**
 * Validate and normalize a phone number.
 * Returns { ok: true, phone } or { ok: false, error }.
 */
function validatePhone(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, error: 'Phone number is required.' };
  const trimmed = raw.trim();
  if (trimmed.length > 30) return { ok: false, error: 'Invalid phone number.' };
  let phone;
  try { phone = toE164(trimmed); } catch { return { ok: false, error: 'Invalid phone number.' }; }
  if (!/^\+\d{7,15}$/.test(phone)) return { ok: false, error: 'Invalid phone number.' };
  return { ok: true, phone };
}

/**
 * Validate a display name.
 * Returns { ok: true, name } or { ok: false, error }.
 */
function validateName(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, error: 'Name is required.' };
  const name = raw.trim().slice(0, 100); // hard cap at 100 chars
  if (!name) return { ok: false, error: 'Name is required.' };
  if (name.length < 1) return { ok: false, error: 'Name is required.' };
  // Reject names with HTML tags or common injection patterns
  if (/<[^>]+>|javascript:|on\w+\s*=|SELECT\s+.*FROM|INSERT\s+INTO|DROP\s+TABLE|UNION\s+SELECT/i.test(name)) {
    return { ok: false, error: 'Invalid name.' };
  }
  return { ok: true, name };
}

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

// PWA share target fallback — GET redirects to contacts; POST is handled by service worker
app.get('/share-target', (req, res) => res.redirect('/app/contacts?import=shared'));

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

app.post('/api/join', joinLimiter, async (req, res) => {
  const { name: rawName, phone: rawPhone, ref } = req.body;

  const nameResult = validateName(rawName);
  if (!nameResult.ok) return res.status(400).json({ error: nameResult.error });

  const phoneResult = validatePhone(rawPhone);
  if (!phoneResult.ok) return res.status(400).json({ error: phoneResult.error });

  const normalizedPhone = phoneResult.phone;
  const name = nameResult.name;

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
  let newUserId = existingUser?.id;
  if (!existingUser) {
    newUserId = uuidv4();
    db.createUser({
      id: newUserId,
      name,
      phone: normalizedPhone,
      onboarding_state: 'complete',
    });
  }

  // Handle referral — look up token, redeem if pending
  let referral = null;
  if (ref && newUserId) {
    try {
      referral = db.getReferralByToken(ref);
      if (referral && referral.status === 'pending') {
        db.redeemReferral(ref, newUserId);
      } else {
        referral = null; // already redeemed or invalid
      }
    } catch (err) {
      console.error('[join] referral lookup failed:', err.message);
      referral = null;
    }
  }

  // Send welcome SMS
  await sms.notifyUser(normalizedPhone,
    `Welcome to ButterflAI, ${name.trim()}! 🦋\n\n` +
    `I'm your personal social agent — I'll help you stay meaningfully connected ` +
    `with the people who matter.\n\n` +
    `Text me anytime. Reply STOP to opt out, HELP for help.`
  ).catch(err => console.error('[join] welcome SMS failed:', err.message));

  // Grant referral reward after welcome SMS
  if (referral && newUserId) {
    flai.grantReferral(referral.referrer_user_id, newUserId)
      .catch(err => console.error('[join] grantReferral failed:', err.message));
  }

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

app.get('/api/user/:userId/audit', webAuth.requireAuth, (req, res) => {
  // Invariant 4 (PRIVACY.md): users may only read their own audit log
  if (req.params.userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — you may only view your own audit log' });
  }
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

  if (pending.action_type === 'attendance_confirm') {
    // Parse attendance reply: "Y", "N", "skip", "1Y 2N", "1Y 2N 3skip", etc.
    // Do NOT re-prompt — ask once only (spec rule).
    db.deletePendingAction(pending.id);

    const confirmations = payload.confirmations || [];
    const nowSecs = Math.floor(Date.now() / 1000);

    if (confirmations.length === 1) {
      // Single-event reply: Y / N / skip
      const c = confirmations[0];
      const trimmed = body.trim().toLowerCase();
      let attended = null;
      let confirmedAt = null;
      if (/^y(es|ep|eah)?[.!]?$/i.test(trimmed) || trimmed === 'yes') {
        attended = 1; confirmedAt = nowSecs;
      } else if (/^n(o|ope)?[.!]?$/i.test(trimmed) || trimmed === 'no') {
        attended = 0; confirmedAt = nowSecs;
      }
      // skip or anything else → attended stays null, no confirmed_at
      db.updateAttendanceConfirmation(c.id, { attended, confirmed_at: confirmedAt });

      // Wire lift after Y/N (not skip)
      if (attended !== null) {
        lift.computeAndLogLift(c.event_id, user.id).catch(err =>
          console.error('[server] lift compute error:', err.message)
        );
      }
    } else {
      // Multi-event reply: "1Y 2N 3skip" etc.
      // Build a map: position (1-based) → intent
      const tokens = body.trim().toUpperCase().split(/\s+/);
      const intentMap = {};
      for (const token of tokens) {
        const m = token.match(/^(\d+)(Y|YES|N|NO|SKIP)$/i);
        if (m) {
          const idx = parseInt(m[1], 10) - 1; // 0-based
          intentMap[idx] = m[2].toUpperCase();
        }
      }

      // If no numbered tokens, try treating the whole body as a single answer for all
      const isBulkYes = /^y(es|ep|eah)?[.!]?$/i.test(body.trim());
      const isBulkNo  = /^n(o|ope)?[.!]?$/i.test(body.trim());

      for (let i = 0; i < confirmations.length; i++) {
        const c = confirmations[i];
        const intent = intentMap[i] || (isBulkYes ? 'Y' : isBulkNo ? 'N' : 'SKIP');
        let attended = null;
        let confirmedAt = null;
        if (intent === 'Y' || intent === 'YES') {
          attended = 1; confirmedAt = nowSecs;
        } else if (intent === 'N' || intent === 'NO') {
          attended = 0; confirmedAt = nowSecs;
        }
        db.updateAttendanceConfirmation(c.id, { attended, confirmed_at: confirmedAt });

        if (attended !== null) {
          lift.computeAndLogLift(c.event_id, user.id).catch(err =>
            console.error('[server] lift compute error:', err.message)
          );
        }
      }
    }

    return `Got it — thanks for confirming! 🦋`;
  }

  if (pending.action_type === 'approve_share') {
    // Code-gated per-edge consent. The grant requires the explicit keyword SHARE — NOT a
    // bare "yes"/"ok", which could be a reply the user meant for a different pending prompt
    // (confused-deputy). So a casual affirmative can never leak private data; it fails closed.
    db.deletePendingAction(pending.id);
    const wantsShare = /\bshare\b/i.test(lower);
    const declines   = isNo || /\b(keep\s+(it\s+)?private|cancel|don'?t)\b/i.test(lower);
    if (wantsShare) {
      const ok = sensitive.approveSharing(user.id, payload.data_key, payload.contact_user_id);
      return ok
        ? `Done — ${payload.contact_name}'s ButterflAI can now factor that in. You can revoke anytime in Settings. 🔒`
        : `Hmm, I couldn't find that item to share — nothing was shared.`;
    }
    if (declines) {
      return `Kept private — I won't share it with ${payload.contact_name}.`;
    }
    // Anything else (including a bare "yes"/"ok") does NOT grant. Re-queue for the agent.
    db.storeInboundMessage({ from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'sms', text: body });
    return `I didn't share anything — reply SHARE to that request only if you did want to share it. 🦋`;
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

// ── Referral routes ───────────────────────────────────────────────────────────

// GET /event/:id — public event invite page
app.get('/event/:id', (req, res) => {
  const event = multiparty.getEvent(req.params.id);
  if (!event || event.status === 'cancelled') {
    return res.status(404).send('Event not found or cancelled.');
  }
  const host = db.getUser(event.host_user_id);
  const hostName = host?.name || 'Someone';
  const isPublic = event.event_type === 'public';
  const rsvp = multiparty.getRsvpSummary(event.id);
  const attendingCount = rsvp.accepted || 0;

  // Use venue timezone if we can infer it, else fall back to host timezone
  const hostTz = host?.timezone || 'America/New_York';
  const dt = new Date(event.scheduled_at * 1000);
  const dateStr = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: hostTz });
  const timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: hostTz });
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${event.title} — ButterflAI</title>
<script>
// If the user is already logged into ButterflAI, take them straight into the app.
// The Events page inside the app shows this invitation and lets them RSVP from there.
fetch('/api/user/me').then(r => {
  if (r.ok) window.location.replace('/app/events?invite=${event.id}');
}).catch(() => {});
</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f2f2f7;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:20px;padding:32px 24px;max-width:420px;width:100%;box-shadow:0 4px 20px rgba(0,0,0,.08)}
.emoji{font-size:48px;text-align:center;margin-bottom:16px}
h1{font-size:22px;font-weight:700;color:#1c1c1e;margin-bottom:8px;text-align:center}
.host{font-size:15px;color:#8e8e93;text-align:center;margin-bottom:24px}
.detail{display:flex;gap:12px;align-items:flex-start;margin-bottom:14px}
.detail-icon{font-size:20px;flex-shrink:0;width:28px;text-align:center}
.detail-text{font-size:15px;color:#3a3a3c;line-height:1.4}
.detail-label{font-size:12px;color:#8e8e93;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
.divider{border:none;border-top:1px solid #f2f2f7;margin:20px 0}
.btn{display:block;width:100%;padding:16px;border-radius:14px;font-size:17px;font-weight:600;text-align:center;text-decoration:none;cursor:pointer;border:none;margin-bottom:10px}
.btn-primary{background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff}
.btn-secondary{background:#f2f2f7;color:#3a3a3c}
.powered{font-size:12px;color:#c7c7cc;text-align:center;margin-top:16px}
</style>
</head><body>
<div class="card">
  <div class="emoji">${event.activity_type === 'party' ? '🎉' : event.activity_type === 'pool' ? '🏊' : '🦋'}</div>
  <h1>${event.title}</h1>
  <p class="host">${isPublic ? `Organized by ${hostName}` : `Hosted by ${hostName}`}</p>
  ${isPublic && attendingCount > 0 ? `<p style="text-align:center;font-size:14px;color:#7c3aed;font-weight:600;margin-bottom:16px">✅ ${attendingCount} going</p>` : ''}
  <div class="detail">
    <div class="detail-icon">📅</div>
    <div class="detail-text">
      <div class="detail-label">When</div>
      ${dateStr}<br>${timeStr}
    </div>
  </div>
  ${event.venue_name ? `<div class="detail">
    <div class="detail-icon">📍</div>
    <div class="detail-text">
      <div class="detail-label">Where</div>
      ${event.venue_name}${event.venue_address ? `<br><span style="color:#8e8e93">${event.venue_address}</span>` : ''}
    </div>
  </div>` : ''}
  ${event.notes ? `<div class="detail">
    <div class="detail-icon">💬</div>
    <div class="detail-text">
      <div class="detail-label">Notes</div>
      ${event.notes}
    </div>
  </div>` : ''}
  <hr class="divider">
  ${isPublic ? `
  <div id="rsvp-form">
    <input id="rsvp-name" placeholder="Your name" style="width:100%;padding:14px;border:1px solid #e5e7eb;border-radius:12px;font-size:16px;margin-bottom:10px;outline:none">
    <input id="rsvp-phone" placeholder="Phone (optional)" type="tel" style="width:100%;padding:14px;border:1px solid #e5e7eb;border-radius:12px;font-size:16px;margin-bottom:14px;outline:none">
    <button class="btn btn-primary" onclick="submitRsvp('accepted')" style="margin-bottom:8px">✓ I'm going</button>
    <button class="btn btn-secondary" onclick="submitRsvp('declined')">✗ Can't make it</button>
    <p id="rsvp-msg" style="text-align:center;margin-top:12px;font-size:14px;color:#8e8e93"></p>
  </div>
  <script>
  async function submitRsvp(status) {
    const name  = document.getElementById('rsvp-name').value.trim();
    const phone = document.getElementById('rsvp-phone').value.trim();
    const msg   = document.getElementById('rsvp-msg');
    if (!name) { msg.textContent = 'Please enter your name.'; return; }
    const r = await fetch('/api/events/${event.id}/public-rsvp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, status })
    });
    if (r.ok) {
      document.getElementById('rsvp-form').innerHTML =
        status === 'accepted'
          ? '<p style="text-align:center;font-size:18px;font-weight:700;color:#7c3aed">✅ You\\u2019re on the list!</p><p style="text-align:center;color:#8e8e93;margin-top:8px">See you there 🦋</p>'
          : '<p style="text-align:center;font-size:18px;font-weight:700;color:#3a3a3c">Got it, maybe next time 👋</p>';
    } else {
      msg.textContent = 'Something went wrong. Try again.';
    }
  }
  </script>` : `<a class="btn btn-primary" href="/join">RSVP via ButterflAI</a>`}
  <p class="powered">Powered by 🦋 ButterflAI</p>
</div>
</body></html>`);
});

// GET /r/:token — referral landing (redirect to join with ref param)
app.get('/r/:token', (req, res) => {
  const token = req.params.token;
  // Token lives in users.referral_token; referrals table is for tracking redemptions
  const referrer = db.getUserByReferralToken(token);
  if (!referrer) return res.redirect('/join');

  // Check if the visitor is already logged in
  const sessionToken = req.cookies?.[webAuth.COOKIE_NAME];
  const payload = sessionToken ? webAuth.verifyToken(sessionToken) : null;
  const visitor = payload ? db.getUser(payload.userId) : null;

  console.log(`[referral] token=${token} cookie=${sessionToken ? 'present' : 'absent'} visitor=${visitor?.id || 'none'} referrer=${referrer.id}`);

  if (!visitor) {
    // Not logged in — serve a landing page that checks auth client-side
    // (cookie may exist in browser but wasn't sent due to link-tap context)
    const refToken = token;
    return res.send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#6c47ff">
<title>ButterflAI — You're invited</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f2f2f7;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border-radius:24px;padding:36px 24px 28px;max-width:360px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.09)}
.logo{font-size:56px;margin-bottom:12px}
h1{font-size:24px;font-weight:800;color:#111;margin-bottom:8px}
p{font-size:15px;color:#666;line-height:1.5;margin-bottom:28px}
.btns{display:flex;flex-direction:column;gap:10px}
.btn{display:block;width:100%;padding:15px;border-radius:14px;font-size:16px;font-weight:700;cursor:pointer;text-decoration:none;border:none;text-align:center}
.btn-primary{background:#6c47ff;color:#fff}
.btn-secondary{background:#f2f2f7;color:#6c47ff}
.btn:active{opacity:.85}
#status{font-size:13px;color:#999;margin-top:14px;min-height:18px}
</style>
</head>
<body>
<div class="card">
  <div class="logo">🦋</div>
  <h1 id="title">You're invited</h1>
  <p id="msg">Checking your account…</p>
  <div class="btns">
    <a id="connect-btn" class="btn btn-primary" href="#" style="display:none" onclick="doConnect();return false">Connect with your friend</a>
    <a id="login-btn"   class="btn btn-primary" href="/login?next=/r/${refToken}" style="display:none">Log in</a>
    <a id="join-btn"    class="btn btn-secondary" href="/join?ref=${refToken}" style="display:none">Create account</a>
  </div>
  <div id="status"></div>
</div>
<script>
const refToken = '${refToken}';
async function init() {
  try {
    const me = await fetch('/api/user/me').then(r => r.ok ? r.json() : null);
    if (me && me.id) {
      document.getElementById('title').textContent = 'Connect with your friend';
      document.getElementById('msg').textContent = 'Tap below to add each other as contacts.';
      document.getElementById('connect-btn').style.display = 'block';
    } else {
      document.getElementById('title').textContent = "You're invited to ButterflAI";
      document.getElementById('msg').textContent = 'Log in or create an account to connect.';
      document.getElementById('login-btn').style.display = 'block';
      document.getElementById('join-btn').style.display = 'block';
    }
  } catch(e) {
    document.getElementById('msg').textContent = 'Log in or create an account to connect.';
    document.getElementById('login-btn').style.display = 'block';
    document.getElementById('join-btn').style.display = 'block';
  }
}
async function doConnect() {
  const btn = document.getElementById('connect-btn');
  btn.textContent = 'Connecting…';
  try {
    const r = await fetch('/api/referral/connect', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({token: refToken})
    });
    const d = await r.json();
    if (r.ok) {
      location.href = '/app/contacts?connected=1&from=' + encodeURIComponent(d.referrerName || 'your friend');
    } else {
      document.getElementById('status').textContent = d.error || 'Something went wrong.';
      btn.textContent = 'Connect with your friend';
    }
  } catch(e) {
    document.getElementById('status').textContent = 'Connection failed — try again.';
    btn.textContent = 'Connect with your friend';
  }
}
init();
</script>
</body></html>`);
  }

  if (visitor && visitor.id !== referrer.id) {
    // Logged-in existing user clicking someone else's invite link — mutual add
    try { db.upsertContact({ invited_by_user_id: referrer.id, name: visitor.name || visitor.phone, phone: visitor.phone, tier: 1 }); } catch (_) {}
    try { db.upsertContact({ invited_by_user_id: visitor.id, name: referrer.name || referrer.phone, phone: referrer.phone, tier: 1 }); } catch (_) {}
    const visitorLabel = visitor.name || 'Someone';
    // Prefer push notification; fall back to SMS only if no push subscription
    const hasPush = (db.getPushSubscriptions(referrer.id) || []).length > 0;
    if (hasPush) {
      push.notifyUser(db, referrer.id, {
        title: '🦋 New connection!',
        body: `${visitorLabel} accepted your invite and was added to your contacts.`,
        url: '/app/contacts',
      }).catch(() => {});
    } else {
      sms.send(referrer.phone, `🦋 ${visitorLabel} accepted your invite and was added to your contacts!`).catch(() => {});
    }
    return res.redirect(`/app/contacts?connected=1&from=${encodeURIComponent(referrer.name || 'your friend')}`);
  }

  // Not logged in (or self-click) → show landing page (already rendered above for !visitor)
  // Self-click case: just go home
  if (visitor) return res.redirect('/app/contacts');
  res.redirect(`/join?ref=${token}`);
});

// POST /api/referral/connect — logged-in user connects via a referral token
app.post('/api/referral/connect', webAuth.requireAuth, express.json(), (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  const referrer = db.getUserByReferralToken(token);
  if (!referrer) return res.status(404).json({ error: 'Invalid invite link.' });

  const visitor = req.user;
  if (visitor.id === referrer.id) {
    return res.status(400).json({ error: "That's your own invite link!" });
  }

  // Mutual contact add
  try { db.upsertContact({ invited_by_user_id: referrer.id, name: visitor.name || visitor.phone, phone: visitor.phone, tier: 1 }); } catch (_) {}
  try { db.upsertContact({ invited_by_user_id: visitor.id, name: referrer.name || referrer.phone, phone: referrer.phone, tier: 1 }); } catch (_) {}

  // Notify referrer — prefer push, fall back to SMS
  const visitorName = visitor.name || 'Someone';
  const hasPush = (db.getPushSubscriptions(referrer.id) || []).length > 0;
  if (hasPush) {
    push.notifyUser(db, referrer.id, {
      title: '🦋 New connection!',
      body: `${visitorName} accepted your invite and was added to your contacts.`,
      url: '/app/contacts',
    }).catch(() => {});
  } else {
    sms.send(referrer.phone, `🦋 ${visitorName} accepted your invite and was added to your contacts!`).catch(() => {});
  }

  res.json({ ok: true, referrerName: referrer.name || referrer.phone });
});

// GET /api/user/referral — get current user's referral token + stats
app.get('/api/user/referral', webAuth.requireAuth, (req, res) => {
  const token = db.getOrCreateReferralToken(req.user.id);
  const baseUrl = process.env.BASE_URL || `https://butterflai.social`;
  const url = `${baseUrl}/r/${token}`;
  // Count joined referrals (never expose FLAI count)
  const joined = db._raw()
    .prepare(`SELECT COUNT(*) as n FROM referrals WHERE referrer_user_id = ? AND status IN ('joined','rewarded')`)
    .get(req.user.id)?.n || 0;
  res.json({ ok: true, url, joined });
});

// ── Dashboard API endpoints ───────────────────────────────────────────────────

// GET /api/dashboard/overdue — cadences past due for this user
app.get('/api/dashboard/overdue', webAuth.requireAuth, (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const rows = db._raw().prepare(`
    SELECT c.*, r.contact_id,
           COALESCE(ct.name, u2.name) as contact_name,
           c.activity_type, c.frequency
    FROM cadences c
    JOIN relationships r ON c.relationship_id = r.id
    LEFT JOIN contacts ct ON ct.id = r.contact_id AND r.contact_is_user = 0
    LEFT JOIN users u2 ON u2.id = r.contact_id AND r.contact_is_user = 1
    WHERE r.user_id = ? AND c.active = 1
      AND (c.next_target_at IS NOT NULL AND c.next_target_at < ?)
    ORDER BY c.next_target_at ASC
    LIMIT 10
  `).all(req.user.id, now);
  res.json({ overdue: rows });
});

// GET /api/dashboard/upcoming — activities scheduled in next 30 days
app.get('/api/dashboard/upcoming', webAuth.requireAuth, (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const in30 = now + 30 * 86400;
  const rows = db._raw().prepare(`
    SELECT a.*
    FROM activities a
    JOIN cadences c ON a.cadence_id = c.id
    JOIN relationships r ON c.relationship_id = r.id
    WHERE r.user_id = ?
      AND a.scheduled_at BETWEEN ? AND ?
      AND a.status IN ('proposed','confirmed')
    ORDER BY a.scheduled_at ASC
    LIMIT 10
  `).all(req.user.id, now, in30);
  res.json({ upcoming: rows });
});

// ── Onboarding setup API ──────────────────────────────────────────────────────

// POST /api/onboarding/setup — web onboarding: create contacts/relationships/cadences
app.post('/api/onboarding/setup', webAuth.requireAuth, express.json(), async (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts array required' });

  try {
    for (const c of contacts) {
      if (!c.name) continue;
      const nameResult = validateName(c.name);
      if (!nameResult.ok) continue; // skip invalid contact names silently

      // Validate phone if provided
      let contactPhone = null;
      if (c.phone) {
        const phoneResult = validatePhone(c.phone);
        contactPhone = phoneResult.ok ? phoneResult.phone : null;
      }

      const contactId = uuidv4();
      db.upsertContact({
        invited_by_user_id: req.user.id,
        name: nameResult.name,
        phone: contactPhone,
        tier: 0,
      });
      // Find the contact we just upserted (by name + invited_by)
      const contact = db._raw().prepare(
        `SELECT * FROM contacts WHERE invited_by_user_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1`
      ).get(req.user.id, c.name);
      if (!contact) continue;

      // Create relationship if not exists
      const existingRel = db._raw().prepare(
        `SELECT * FROM relationships WHERE user_id = ? AND contact_id = ? LIMIT 1`
      ).get(req.user.id, contact.id);
      let relId;
      if (existingRel) {
        relId = existingRel.id;
      } else {
        relId = uuidv4();
        db.createRelationship({
          id: relId,
          user_id: req.user.id,
          contact_id: contact.id,
          contact_is_user: 0,
          nickname: null,
          notes: null,
        });
      }

      // Create cadence
      const freq = c.frequency || 'monthly';
      db.createCadence({
        id: uuidv4(),
        relationship_id: relId,
        activity_type: 'hangout',
        frequency: freq,
        group_size: 2,
        budget_per_person: null,
        preferred_areas: null,
        preferred_times: null,
      });
    }

    // Mark onboarding complete
    db.updateUser(req.user.id, { onboarding_state: 'complete' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[onboarding/setup] error:', err.message);
    res.status(500).json({ error: 'Setup failed.' });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────

// ── Admin routes (auth-gated via X-Admin-Secret header) ──────────────────────
app.use('/admin', express.json(), adminRouter);

// ── Admin middleware ──────────────────────────────────────────────────────────
// Admin = authenticated user whose phone matches ADMIN_PHONE env var.
// Set ADMIN_PHONE in Fly secrets: flyctl secrets set ADMIN_PHONE=+1xxxxxxxxxx
function requireAdmin(req, res, next) {
  const token = req.cookies?.[webAuth.COOKIE_NAME];
  const payload = token ? webAuth.verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: 'Not authenticated.' });
  const user = db.getUser(payload.userId);
  if (!user) return res.status(401).json({ error: 'User not found.' });
  const adminPhone = process.env.ADMIN_PHONE;
  if (!adminPhone || user.phone !== adminPhone) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  req.user = user;
  next();
}

function requireAdminPage(req, res, next) {
  const token = req.cookies?.[webAuth.COOKIE_NAME];
  const payload = token ? webAuth.verifyToken(token) : null;
  if (!payload) return res.redirect('/app/login');
  const user = db.getUser(payload.userId);
  if (!user) return res.redirect('/app/login');
  const adminPhone = process.env.ADMIN_PHONE;
  if (!adminPhone || user.phone !== adminPhone) return res.status(403).send('Admin access required.');
  req.user = user;
  next();
}

// ── Admin page ────────────────────────────────────────────────────────────────
app.get('/admin', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});

// ── Admin API ─────────────────────────────────────────────────────────────────

// GET /api/admin/flai/summary — circulation stats
app.get('/api/admin/flai/summary', requireAdmin, (req, res) => {
  const summary   = db.getFlaiLedgerSummary();
  const users     = db.getUsersWithBalances();
  const recent    = db.getFlaiLedgerRecent(50);
  const byReason  = db.getFlaiSpendByReason();
  res.json({ summary, users, recent, byReason });
});

// POST /api/admin/flai/grant — grant FLAI to a user
app.post('/api/admin/flai/grant', requireAdmin, express.json(), (req, res) => {
  const { userId, delta, reason } = req.body;
  if (!userId || typeof delta !== 'number' || !Number.isInteger(delta)) {
    return res.status(400).json({ error: 'userId and integer delta required' });
  }
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason required' });
  const target = db.getUser(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.appendFlaiLedger({ user_id: userId, delta, reason: reason.trim(), ref_id: req.user.id, metadata: { admin_grant: true } });
  const newBalance = db.getFlaiBalance(userId);
  console.log(`[admin] FLAI grant: ${delta} to ${target.name} (${userId}) by admin — new balance: ${newBalance}`);
  res.json({ ok: true, userId, delta, newBalance });
});

// ── Backfill baseline grants for existing users ───────────────────────────────
// POST /api/admin/flai/backfill — idempotent, skips users who already have a baseline_grant
app.post('/api/admin/flai/backfill', requireAdmin, (req, res) => {
  const { BASELINE_GRANT } = require('./flai');
  const users = db.getAllUsers();
  let credited = 0;
  let skipped  = 0;
  for (const user of users) {
    const hasGrant = db._raw().prepare(
      `SELECT 1 FROM flai_ledger WHERE user_id = ? AND reason = 'baseline_grant' LIMIT 1`
    ).get(user.id);
    if (hasGrant) { skipped++; continue; }
    db.appendFlaiLedger({ user_id: user.id, delta: BASELINE_GRANT, reason: 'baseline_grant', ref_id: 'backfill', metadata: { backfill: true } });
    credited++;
  }
  console.log(`[admin] FLAI backfill: ${credited} credited, ${skipped} skipped`);
  res.json({ ok: true, credited, skipped, baseline_grant: BASELINE_GRANT });
});

// ── User-facing capacity API (capability language only — never exposes balance) ──
// Returns a level and message suitable for display. Never returns the raw number.
app.get('/api/user/capacity', webAuth.requireAuth, (req, res) => {
  const balance = db.getFlaiBalance(req.user.id) || 0;
  let level, message, emoji;
  if (balance >= 50) {
    level = 'full';    emoji = '🟢'; message = 'Your agent has full capacity to help you this month.';
  } else if (balance >= 10) {
    level = 'moderate'; emoji = '🟡'; message = 'Your agent has moderate capacity. Invite a friend to give it more room.';
  } else {
    level = 'low';     emoji = '🔴'; message = 'Your agent is running lean. Invite a friend to boost its capacity.';
  }
  res.json({ level, emoji, message });
});

// ── Web app pages ─────────────────────────────────────────────────────────────
app.get('/app/login',      (req, res) => res.sendFile(path.join(__dirname, 'public/app/login.html')));
app.get('/app/chat',       webAuth.requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public/app/chat.html')));
app.get('/app/contacts',   webAuth.requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public/app/contacts.html')));
app.get('/app/dashboard',  webAuth.requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public/app/dashboard.html')));
app.get('/app/events',     webAuth.requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public/app/events.html')));
app.get('/app/settings',   webAuth.requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public/app/settings.html')));
app.get('/app/onboarding', webAuth.requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public/app/onboarding.html')));
app.get('/app',            (req, res) => res.redirect('/app/dashboard'));

// ── OTP auth ──────────────────────────────────────────────────────────────────
app.post('/auth/otp/send',   otpLimiter, express.json(), webAuth.sendOtp);
app.post('/auth/otp/verify', otpLimiter, express.json(), webAuth.verifyOtpHandler);
app.get('/auth/logout',      webAuth.logout);

// ── Web chat API ──────────────────────────────────────────────────────────────
// GET /api/chat/messages — last 50 conversation messages, newest-first then reversed
// Uses DESC + reverse so we get the most recent 50 (not the oldest 50).
// Optional: ?since=<unix_ts> — only return messages newer than that timestamp (for catch-up polling)
app.get('/api/chat/messages', webAuth.requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const since = parseInt(req.query.since) || 0;
  let msgs;
  if (since > 0) {
    msgs = db._raw().prepare(
      `SELECT role, text, created_at FROM conversation_history
       WHERE user_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?`
    ).all(req.user.id, since, limit);
  } else {
    msgs = db._raw().prepare(
      `SELECT role, text, created_at FROM conversation_history
       WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(req.user.id, limit).reverse();
  }
  res.json({ messages: msgs });
});

// GET /api/chat/stream — SSE stream for real-time agent responses
// Note: EventSource can't read 401 body, so we send a redirect event instead
app.get('/api/chat/stream', (req, res) => {
  const token = req.cookies?.[webAuth.COOKIE_NAME];
  if (!token) {
    // Send one event telling client to redirect, then close
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ redirect: '/app/login' })}\n\n`);
    return res.end();
  }
  const payload = webAuth.verifyToken(token);
  if (!payload) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ redirect: '/app/login' })}\n\n`);
    return res.end();
  }
  const user = db.getUser(payload.userId);
  if (!user) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ redirect: '/app/login' })}\n\n`);
    return res.end();
  }
  req.user = user;
  sse.register(user.id, res);
});

// POST /api/chat/send — inbound message from web UI
app.post('/api/chat/send', webAuth.requireAuth, express.json(), async (req, res) => {
  const text = req.body?.text?.trim();
  if (!text) return res.status(400).json({ error: 'text required' });

  try {
    // Store as inbound message and let the agent loop process it
    db.storeInboundMessage({
      from_phone: req.user.phone,
      from_type: 'user',
      from_id: req.user.id,
      channel: 'webchat',
      text,
    });
    // Immediately push a "thinking" status so the UI shows activity before the agent fires
    sse.push(req.user.id, { role: 'status', text: 'Thinking…' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[chat/send] failed to store message:', err.message);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// GET /api/debug/me — debug: who am I + contact count
app.get('/api/debug/me', webAuth.requireAuth, (req, res) => {
  const contacts = db.getContactsByUser(req.user.id);
  res.json({ userId: req.user.id, name: req.user.name, phone: req.user.phone, contactCount: contacts.length, contacts: contacts.map(c => ({ name: c.name, tier: c.tier })) });
});

// GET /api/contacts/list — contacts for the authenticated user
// Supports ?q= search and ?offset= pagination (page size 200)
app.get('/api/contacts/list', webAuth.requireAuth, (req, res) => {
  const PAGE = 200;
  const q      = (req.query.q || '').toLowerCase().trim();
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  let contacts = db.getContactsByUser(req.user.id);

  if (q) {
    contacts = contacts.filter(c =>
      (c.name       || '').toLowerCase().includes(q) ||
      (c.nickname   || '').toLowerCase().includes(q) ||
      (c.also_known_as || '').toLowerCase().includes(q) ||
      (c.phone      || '').includes(q)
    );
  }

  const total = contacts.length;
  const page  = contacts.slice(offset, offset + PAGE);
  console.log(`[contacts/list] user=${req.user.id} total=${total} offset=${offset} returning=${page.length}`);
  res.json({ contacts: page, total, offset, limit: PAGE });
});

// ── Contact Groups ─────────────────────────────────────────────────────────────

// GET /api/contacts/groups — all groups with members for the authenticated user
app.get('/api/contacts/groups', webAuth.requireAuth, (req, res) => {
  const groups = db.getContactGroups(req.user.id);
  res.json({ groups });
});

// DELETE /api/contacts/groups/:groupId — delete a group (user must own it)
app.delete('/api/contacts/groups/:groupId', webAuth.requireAuth, (req, res) => {
  db.deleteContactGroup(req.params.groupId, req.user.id);
  res.json({ ok: true });
});

// DELETE /api/contacts/groups/:groupId/members/:contactId — remove one member
app.delete('/api/contacts/groups/:groupId/members/:contactId', webAuth.requireAuth, (req, res) => {
  // Verify ownership: group must belong to this user
  const groups = db.getContactGroups(req.user.id);
  const group = groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  db.removeContactFromGroup(req.params.groupId, req.params.contactId);
  res.json({ ok: true });
});

// POST /api/user/location — store GPS coords + reverse-geocode to city
app.post('/api/user/location', webAuth.requireAuth, express.json(), async (req, res) => {
  const { lat, lng } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng required as numbers' });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  let city = null;
  let timezone = null;
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { 'User-Agent': 'ButterflAI/1.0 (+https://butterflai.social)' } }
    );
    if (r.ok) {
      const data = await r.json();
      const a = data.address || {};
      city = a.city || a.town || a.village || a.county || a.state || null;
    }
  } catch (err) {
    console.warn('[location] reverse geocode failed:', err.message);
  }

  // Detect IANA timezone from coordinates via timeapi.io (free, no key needed)
  try {
    const tzr = await fetch(`https://timeapi.io/api/timezone/coordinate?latitude=${lat}&longitude=${lng}`);
    if (tzr.ok) {
      const tzd = await tzr.json();
      timezone = tzd.timeZone || null;
    }
  } catch (_) {}

  const updates = {
    lat, lng,
    city: city || req.user.city,
    location_updated_at: Math.floor(Date.now() / 1000),
  };
  if (timezone) updates.timezone = timezone;
  db.updateUser(req.user.id, updates);

  res.json({ ok: true, lat, lng, city, timezone });
});

// GET /api/user/me — current user profile
app.get('/api/user/me', webAuth.requireAuth, (req, res) => {
  const { id, name, nickname, also_known_as, phone, city, lat, lng, share_location } = req.user;
  res.json({ id, name, nickname, also_known_as, phone, city, lat, lng,
    share_location: share_location === 0 ? false : true }); // default true if null/1
});

// PATCH /api/user/location-sharing — toggle whether location is visible to other agents
app.patch('/api/user/location-sharing', webAuth.requireAuth, express.json(), (req, res) => {
  const { share } = req.body;
  if (typeof share !== 'boolean') return res.status(400).json({ error: 'share must be boolean' });
  db.updateUser(req.user.id, { share_location: share ? 1 : 0 });
  res.json({ ok: true, share_location: share });
});

// DELETE /api/user/location — clear stored location entirely
app.delete('/api/user/location', webAuth.requireAuth, (req, res) => {
  db.updateUser(req.user.id, { city: null, lat: null, lng: null, location_updated_at: null });
  res.json({ ok: true });
});

// GET /api/push/vapid-key — return the VAPID public key for subscription
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: push.VAPID_PUBLIC || null });
});

// POST /api/push/subscribe — save a push subscription for the logged-in user
app.post('/api/push/subscribe', webAuth.requireAuth, express.json(), (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }
  db.upsertPushSubscription({
    id: uuidv4(),
    user_id: req.user.id,
    endpoint,
    p256dh: keys.p256dh,
    auth:   keys.auth,
  });
  res.json({ ok: true });
});

// POST /api/chat/sensitive-mode — toggle sensitive mode for this user's session
app.post('/api/chat/sensitive-mode', webAuth.requireAuth, express.json(), (req, res) => {
  const { on } = req.body;
  if (typeof on !== 'boolean') return res.status(400).json({ error: 'on must be boolean' });
  sensitive.setSensitiveMode(req.user.id, on);
  res.json({ ok: true, sensitive_mode: on });
});

// GET /api/user/private-data — list private data keys (not values) for the logged-in user
app.get('/api/user/private-data', webAuth.requireAuth, (req, res) => {
  const items = sensitive.listPrivateData(req.user.id);
  res.json({ items });
});

// DELETE /api/user/private-data/:key — delete a private datum
app.delete('/api/user/private-data/:key(*)', webAuth.requireAuth, (req, res) => {
  sensitive.deletePrivateData(req.user.id, req.params.key);
  res.json({ ok: true });
});

// GET /api/user/private-data/access-log — audit log for own private data
app.get('/api/user/private-data/access-log', webAuth.requireAuth, (req, res) => {
  const log = sensitive.getAccessLog(req.user.id, 50);
  res.json({ log });
});

// GET /api/user/preferences — return everything the agent has stored about this user
app.get('/api/user/preferences', webAuth.requireAuth, (req, res) => {
  const prefs = db.getPreferences(req.user.id) || {};
  // health_safety_notes lives encrypted (not in plaintext prefs). Surface it to the OWNER's
  // own settings view by decrypting on read (logged); the plaintext column stays NULL.
  const note = sensitive.readPrivateData(req.user.id, sensitive.HEALTH_NOTES_KEY, 'owner settings view');
  if (note) prefs.health_safety_notes = note;
  res.json({ preferences: prefs });
});

// DELETE /api/user/preferences/:field — clear a specific preference field
app.delete('/api/user/preferences/:field', webAuth.requireAuth, (req, res) => {
  const SAFE_FIELDS = ['food_allergies','dietary_restrictions','cuisine_loves','cuisine_avoids',
    'activity_loves','activity_avoids','vibe','budget_low','budget_high','neighborhood',
    'availability_notes','comm_style','extra_notes','health_safety_notes','health_sharing_approved'];
  const { field } = req.params;
  if (!SAFE_FIELDS.includes(field)) return res.status(400).json({ error: 'Unknown field' });
  if (field === 'health_safety_notes') {
    // Lives in the encrypted store — hard-delete there (also logs the deletion).
    sensitive.deletePrivateData(req.user.id, sensitive.HEALTH_NOTES_KEY);
  } else {
    db.upsertPreferences(req.user.id, { [field]: null });
  }
  res.json({ ok: true, cleared: field });
});

// ── Per-contact private-data sharing (replaces the deprecated global health toggle) ──
// These are code-gated by requireAuth: they act on req.user.id (the authenticated owner),
// so a grant here is a direct, deterministic user action — no LLM in the path.

function _sharingLabel(dataKey) {
  const labels = { 'health.safety_notes': 'Health & safety note' };
  if (labels[dataKey]) return labels[dataKey];
  const tail = String(dataKey || '').split('.').pop().replace(/_/g, ' ').trim();
  return tail ? tail[0].toUpperCase() + tail.slice(1) : 'Private note';
}

// Map the owner's approved recipient user_ids back to their contacts (id + name).
function _ownerContactByUserId(ownerId) {
  const map = {};
  for (const c of db.getContactsByUser(ownerId)) {
    if (!c.phone) continue;
    const u = db.getUserByPhone(c.phone);
    if (u) map[u.id] = { contact_id: c.id, name: c.name };
  }
  return map;
}

// GET — the owner's private items and, per item, which contacts each is shared with.
app.get('/api/user/private-sharing', webAuth.requireAuth, (req, res) => {
  const contactMap = _ownerContactByUserId(req.user.id);
  const items = sensitive.listPrivateData(req.user.id).map(it => {
    const shared_with = sensitive.listSharingApprovals(req.user.id, it.data_key)
      .map(uid => contactMap[uid] || { contact_id: null, name: 'Unknown (not in your contacts)' });
    return { data_key: it.data_key, category: it.category, label: _sharingLabel(it.data_key), updated_at: it.updated_at, shared_with };
  });
  // Contacts who are ButterflAI users (candidates to share with).
  const shareable_contacts = db.getContactsByUser(req.user.id)
    .filter(c => c.phone && db.getUserByPhone(c.phone))
    .map(c => ({ contact_id: c.id, name: c.name }));
  res.json({ items, shareable_contacts });
});

function _resolveOwnedContactUser(ownerId, contactId) {
  const contact = db.getContact(contactId);
  if (!contact || contact.invited_by_user_id !== ownerId) return { error: 'Contact not found', code: 404 };
  if (!contact.phone) return { error: 'Contact has no phone', code: 400 };
  const contactUser = db.getUserByPhone(contact.phone);
  if (!contactUser) return { error: 'Contact is not a ButterflAI user', code: 400 };
  return { contactUser };
}

// POST approve — the owner directly grants sharing of one item with one contact.
app.post('/api/user/private-sharing/approve', webAuth.requireAuth, express.json(), (req, res) => {
  const { data_key, contact_id } = req.body || {};
  if (!data_key || !contact_id) return res.status(400).json({ error: 'data_key and contact_id required' });
  const r = _resolveOwnedContactUser(req.user.id, contact_id);
  if (r.error) return res.status(r.code).json({ error: r.error });
  const ok = sensitive.approveSharing(req.user.id, data_key, r.contactUser.id);
  if (!ok) return res.status(404).json({ error: 'No such private item on file' });
  res.json({ ok: true });
});

// POST revoke — the owner withdraws sharing of one item with one contact.
app.post('/api/user/private-sharing/revoke', webAuth.requireAuth, express.json(), (req, res) => {
  const { data_key, contact_id } = req.body || {};
  if (!data_key || !contact_id) return res.status(400).json({ error: 'data_key and contact_id required' });
  const r = _resolveOwnedContactUser(req.user.id, contact_id);
  if (r.error) return res.status(r.code).json({ error: r.error });
  const ok = sensitive.revokeSharing(req.user.id, data_key, r.contactUser.id);
  res.json({ ok });
});

// PATCH /api/user/preferences/health-sharing — DEPRECATED.
// Consent is now per-edge (per contact), enforced via sensitive.sharing_approved_to — a
// single global "share health with anyone" toggle is no longer the gate and no longer
// affects sharing. Retained so the current settings page does not 404; the per-contact
// management UI is the replacement (see docs). This writes the (now-inert) flag only.
app.patch('/api/user/preferences/health-sharing', webAuth.requireAuth, express.json(), (req, res) => {
  const { approved } = req.body;
  if (typeof approved !== 'boolean') return res.status(400).json({ error: 'approved must be boolean' });
  db.upsertPreferences(req.user.id, { health_sharing_approved: approved ? 1 : 0 });
  res.json({ ok: true, health_sharing_approved: approved });
});

// PATCH /api/user/me — update profile fields
app.patch('/api/user/me', webAuth.requireAuth, express.json(), (req, res) => {
  const { name, nickname, also_known_as } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const updates = { name: name.trim() };
  if (typeof nickname === 'string') updates.nickname = nickname.trim() || null;
  if (typeof also_known_as === 'string') updates.also_known_as = also_known_as.trim() || null;
  db.updateUser(req.user.id, updates);
  res.json({ ok: true, ...updates });
});

// PATCH /api/contacts/:id/nickname — set your nickname for a contact
app.patch('/api/contacts/:id/nickname', webAuth.requireAuth, express.json(), (req, res) => {
  const { id } = req.params;
  const { nickname } = req.body;
  // Verify ownership
  const contacts = db.getContactsByUser(req.user.id);
  const contact = contacts.find(c => c.id === id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  db.updateContact(id, { nickname: nickname ? nickname.trim() : null });
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  // Verify DB is reachable
  try {
    db._raw().prepare('SELECT 1').get();
    res.json({ ok: true, ts: Date.now() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Agent-to-agent MCP inbound ────────────────────────────────────────────────
// Receives coordination messages from peer ButterflAI agents.
// Signature verified inside handleInboundRequest.

app.post('/mcp/inbound', express.json({ limit: '64kb' }), (req, res) => {
  const deps = {
    getWindows:   (userId) => db.getAvailableWindows(userId),
    notifyUser:   (userId, text, meta) => require('./coord-loop').notifyUser(userId, text, meta),
    checkConsent: (fromAgentId, toUserId) => {
      // Check that the from agent corresponds to a contact with can_coordinate flag
      const contact = db.getContactByAgentEndpoint(fromAgentId, toUserId);
      return !!(contact && contact.can_coordinate);
    }
  };
  return handleInboundRequest(req, res, deps);
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
  const events = multiparty.getEventsByHost(req.params.userId);
  // Attach RSVP summary to each event so host can see who accepted/declined
  const withRsvp = events.map(e => ({
    ...e,
    rsvp: multiparty.getRsvpSummary(e.id),
  }));
  res.json({ events: withRsvp });
});

// GET /api/events/invited — events the logged-in user was invited to
app.get('/api/events/invited/me', webAuth.requireAuth, (req, res) => {
  const events = multiparty.getInvitedEvents(req.user.phone);
  res.json({ events });
});

// POST /api/events/invitations/:id/dismiss — hide an invitation from the events page
app.post('/api/events/invitations/:id/dismiss', webAuth.requireAuth, (req, res) => {
  const result = multiparty.dismissInvitation(req.params.id, req.user.phone);
  if (result.error) return res.status(403).json(result);
  res.json(result);
});

// POST /api/events/rsvp — accept or decline an invitation from the web app (logged-in user)
app.post('/api/events/rsvp', webAuth.requireAuth, express.json(), (req, res) => {
  const { invitation_id, status } = req.body;
  if (!invitation_id || !['accepted', 'declined'].includes(status)) {
    return res.status(400).json({ error: 'invitation_id and status (accepted|declined) required' });
  }
  const result = multiparty.rsvpInvitation(invitation_id, req.user.phone, status);
  if (!result.ok) return res.status(403).json(result);
  res.json(result);
});

// POST /api/events/:id/public-rsvp — RSVP to a public event (no login required)
app.post('/api/events/:id/public-rsvp', express.json(), (req, res) => {
  const { name, phone, status } = req.body;
  if (!['accepted', 'declined'].includes(status)) {
    return res.status(400).json({ error: 'status must be accepted or declined' });
  }
  const result = multiparty.publicRsvp(req.params.id, { name, phone, status });
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});;

// GET /api/events/:id/manage — full event detail + invitee list (organizer only)
app.get('/api/events/:id/manage', webAuth.requireAuth, (req, res) => {
  const event = multiparty.getEvent(req.params.id);
  if (!event || event.host_user_id !== req.user.id) return res.status(403).json({ error: 'Not your event' });
  const invitees = db._raw().prepare(`
    SELECT ei.id AS invitation_id, ei.status, ei.source, c.name, c.phone
    FROM event_invitations ei
    JOIN contacts c ON c.id = ei.contact_id
    WHERE ei.event_id = ?
    ORDER BY c.name ASC
  `).all(event.id);
  res.json({ event, invitees });
});

// PATCH /api/events/:id — update event_type or status
app.patch('/api/events/:id', webAuth.requireAuth, express.json(), (req, res) => {
  const event = multiparty.getEvent(req.params.id);
  if (!event || event.host_user_id !== req.user.id) return res.status(403).json({ error: 'Not your event' });
  const allowed = ['event_type', 'status', 'title', 'notes', 'venue_name', 'venue_address', 'host_attending'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db._raw().prepare(`UPDATE social_events SET ${sets} WHERE id = ?`).run(...Object.values(updates), event.id);
  res.json({ ok: true });
});

// POST /api/events/:id/invite — invite additional contacts
app.post('/api/events/:id/invite', webAuth.requireAuth, express.json(), async (req, res) => {
  const event = multiparty.getEvent(req.params.id);
  if (!event || event.host_user_id !== req.user.id) return res.status(403).json({ error: 'Not your event' });
  const { contact_ids } = req.body;
  if (!Array.isArray(contact_ids) || !contact_ids.length) return res.status(400).json({ error: 'contact_ids required' });
  const result = await multiparty.inviteContacts(event.id, contact_ids);
  res.json({ ok: true, ...result });
});

// DELETE /api/events/:id/invite/:invitationId — remove an invitee
app.delete('/api/events/:id/invite/:invitationId', webAuth.requireAuth, (req, res) => {
  const event = multiparty.getEvent(req.params.id);
  if (!event || event.host_user_id !== req.user.id) return res.status(403).json({ error: 'Not your event' });
  db._raw().prepare('DELETE FROM event_invitations WHERE id = ? AND event_id = ?').run(req.params.invitationId, event.id);
  res.json({ ok: true });
});

app.get('/api/events/:userId/:eventId', (req, res) => {
  const event = multiparty.getEvent(req.params.eventId);
  if (!event || event.host_user_id !== req.params.userId) return res.status(404).json({ error: 'Not found' });
  res.json({ event, rsvp: multiparty.getRsvpSummary(req.params.eventId) });
});

// ── Google OAuth callbacks ────────────────────────────────────────────────────

// Initiate Google Calendar OAuth for a user.
// Accepts ?userId= (SMS link) or falls back to the authenticated session cookie.
app.get('/auth/google/calendar', (req, res) => {
  let userId = req.query.userId;
  if (!userId) {
    // Try session cookie
    const token = req.cookies?.[webAuth.COOKIE_NAME];
    const payload = token ? webAuth.verifyToken(token) : null;
    userId = payload?.userId;
  }
  if (!userId || !db.getUser(userId)) return res.status(400).send('Invalid userId');
  const url = calendar.getAuthUrl(userId);
  res.redirect(url);
});

// Apple Calendar connect — user submits Apple ID + app-specific password.
// Accepts ?userId= (SMS link) or falls back to the authenticated session cookie.
app.get('/auth/apple/calendar', (req, res) => {
  let userId = req.query.userId;
  if (!userId) {
    const token = req.cookies?.[webAuth.COOKIE_NAME];
    const payload = token ? webAuth.verifyToken(token) : null;
    userId = payload?.userId;
  }
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
        <a href="/app/settings" style="display:inline-block;margin-top:20px;padding:12px 28px;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;font-size:15px;font-weight:600;border-radius:12px;text-decoration:none;">← Back to settings</a>
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
    <a href="/app/settings" style="display:inline-block;margin-top:4px;margin-bottom:20px;padding:12px 28px;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;font-size:15px;font-weight:600;border-radius:12px;text-decoration:none;">← Back to settings</a>
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
app.post('/api/contacts/import', webAuth.requireAuth, express.json(), (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts must be an array' });
  if (contacts.length > 500) return res.status(400).json({ error: 'Maximum 500 contacts per import' });

  const userId = req.user.id;
  let imported = 0, skipped = 0;
  for (const c of contacts) {
    const nameResult = validateName(c.name);
    if (!nameResult.ok) { skipped++; continue; }

    // Accept phone as-is if it passes validation, else store without phone
    let phone = null;
    if (c.phone) {
      const phoneResult = validatePhone(c.phone);
      phone = phoneResult.ok ? phoneResult.phone : null;
    }
    // Must have at least a valid name
    try {
      db.upsertContact({ invited_by_user_id: userId, name: nameResult.name, phone, tier: 0 });
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

// ── Global error safety net — prevent process crashes from unhandled errors ───
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err.message, err.stack);
  // Do not exit — keep serving
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
});

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  // One-time, idempotent: move any plaintext health notes into the encrypted store before
  // serving traffic (PRIVACY.md Invariant 1). No-op once migrated.
  try {
    const { migrated } = sensitive.migratePlaintextHealthNotes();
    if (migrated) console.log(`[startup] migrated ${migrated} plaintext health note(s) to encrypted store`);
  } catch (e) {
    console.error('[startup] health-notes migration failed:', e.message);
  }
  app.listen(PORT, () => {
    console.log(`ButterflAI web running on :${PORT}`);
    startAgentLoop();
    startNudgeLoop();
    startCoordLoop({ transport: mcpTransport });
  });
}

module.exports = { app, handlePendingAction };
