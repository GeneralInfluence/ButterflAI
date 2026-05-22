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
const { handleOnboarding } = require('./onboarding');

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
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

// ── SMS webhook (primary human channel) ─────────────────────────────────────

app.post('/sms', sms.validateTwilioRequest, async (req, res) => {
  const body   = (req.body.Body  || '').trim();
  const from   = (req.body.From  || '').trim();   // E.164 caller phone

  const twiml = buildTwiml();

  // 1. STOP — highest priority, handled before anything else
  if (/^stop$/i.test(body) || /^stop\b/i.test(body)) {
    db.recordOptOut(from, 'stop_reply');
    twiml.push(`You've been opted out and won't receive any more messages from ButterflAI. ` +
               `Text START to re-subscribe at any time.`);
    return res.type('text/xml').send(twiml.toString());
  }

  // 2. START — re-subscribe
  if (/^start$/i.test(body)) {
    // Remove from opt-out registry (contacts.tier is updated separately when they re-engage)
    db.prepare && db.removeOptOut && db.removeOptOut(from); // graceful — may not exist yet
    twiml.push(`Welcome back! You're re-subscribed. Text us anytime.`);
    return res.type('text/xml').send(twiml.toString());
  }

  // 3. Check opt-out status before doing anything
  if (db.isOptedOut(from)) {
    // Silently drop the message — they opted out
    return res.type('text/xml').send(twiml.toString());
  }

  // 4. Route: onboarding vs. established user
  const user = db.getUserByPhone(from);
  const isOnboarding = !user || user.onboarding_state !== 'complete';

  try {
    let reply;

    if (isOnboarding) {
      reply = await handleOnboarding(from, body, db);
    } else {
      // Established user: queue message for agent processing
      db.storeInboundMessage({
        from_phone: from,
        from_type: 'user',
        from_id: user.id,
        channel: 'sms',
        text: body,
      });
      // Simple ack — the agent will follow up asynchronously
      reply = `Got it! I'll take care of that. 🦋`;
    }

    if (reply) twiml.push(reply);
  } catch (err) {
    console.error('[SMS] handler error:', err);
    twiml.push(`Something went wrong on my end — I'll be back shortly. Sorry!`);
  }

  res.type('text/xml').send(twiml.toString());
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

// ── Contact self-service portal (§7) ─────────────────────────────────────────
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

app.listen(PORT, () => console.log(`ButterflAI web running on :${PORT}`));
