require('dotenv').config();
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const telegram = require('./telegram');
const { bot } = process.env.TELEGRAM_BOT_TOKEN ? require('./bot') : { bot: null };

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50 });
app.use(limiter);

// ── Invite landing page ──────────────────────────────────────────────────────

app.get('/invite/:token', (req, res) => {
  const invite = db.getInvite(req.params.token);

  if (!invite) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  if (invite.status !== 'pending') return res.sendFile(path.join(__dirname, 'public', 'already-resolved.html'));

  const inviter = db.getUser(invite.created_by_user_id);
  res.sendFile(path.join(__dirname, 'public', 'invite.html'));
});

// API: get invite metadata (called by invite.html via fetch)
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

// ── Opt-out ──────────────────────────────────────────────────────────────────

app.post('/api/invite/:token/optout', (req, res) => {
  const invite = db.getInvite(req.params.token);
  if (!invite || invite.status !== 'pending') {
    return res.status(400).json({ error: 'Invalid or already resolved invite' });
  }

  const contactId = uuidv4();
  const name = req.body.name || invite.contact_name || 'Someone';

  db.createContact({
    id: contactId,
    invited_by_user_id: invite.created_by_user_id,
    name,
    tier: 0,
    opted_out_at: Math.floor(Date.now() / 1000),
  });

  db.resolveInvite(invite.token, 'opted_out', contactId);

  // Notify inviter's agent
  const inviter = db.getUser(invite.created_by_user_id);
  if (inviter?.telegram_id) {
    telegram.notifyUser(inviter.telegram_id,
      `👋 ${name} saw your ButterflAI invite and opted out. No worries — they won't be contacted again.`
    );
  }

  res.json({ ok: true });
});

// ── Tier 1: Contact mode opt-in ──────────────────────────────────────────────

app.post('/api/invite/:token/contact', (req, res) => {
  const invite = db.getInvite(req.params.token);
  if (!invite || invite.status !== 'pending') {
    return res.status(400).json({ error: 'Invalid or already resolved invite' });
  }

  const { name, telegram_username, availability, neighborhoods, dietary } = req.body;
  if (!name || !telegram_username) {
    return res.status(400).json({ error: 'Name and Telegram username required' });
  }

  const contactId = uuidv4();

  db.createContact({
    id: contactId,
    invited_by_user_id: invite.created_by_user_id,
    name,
    telegram_username: telegram_username.replace('@', ''),
    tier: 1,
  });

  db.setContactPreferences({
    contact_id: contactId,
    availability_notes: availability || null,
    neighborhoods: neighborhoods ? JSON.stringify(neighborhoods) : null,
    dietary: dietary ? JSON.stringify(dietary) : null,
    comm_preference: 'telegram',
  });

  db.resolveInvite(invite.token, 'accepted_contact', contactId);

  // Notify inviter's agent
  const inviter = db.getUser(invite.created_by_user_id);
  if (inviter?.telegram_chat_id) {
    telegram.notifyUser(inviter.telegram_chat_id,
      `⏳ ${name} accepted your invite! Waiting for them to activate on Telegram...`
    );
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  const deepLink = botUsername
    ? `https://t.me/${botUsername}?start=contact_${contactId}`
    : null;

  res.json({ ok: true, tier: 1, deepLink, contactId });
});

// ── Tier 2: Full ButterflAI signup ───────────────────────────────────────────

app.post('/api/invite/:token/signup', (req, res) => {
  const invite = db.getInvite(req.params.token);
  if (!invite || invite.status !== 'pending') {
    return res.status(400).json({ error: 'Invalid or already resolved invite' });
  }

  const { name, telegram_username, availability, neighborhoods, dietary } = req.body;
  if (!name || !telegram_username) {
    return res.status(400).json({ error: 'Name and Telegram username required' });
  }

  // Create a pending full user account
  const userId = uuidv4();
  db.createUser({
    id: userId,
    name,
    telegram_username: telegram_username.replace('@', ''),
  });

  // Also create a contact record linking back to the inviter
  const contactId = uuidv4();
  db.createContact({
    id: contactId,
    invited_by_user_id: invite.created_by_user_id,
    name,
    telegram_username: telegram_username.replace('@', ''),
    tier: 2,
  });

  db.setContactPreferences({
    contact_id: userId,
    availability_notes: availability || null,
    neighborhoods: neighborhoods ? JSON.stringify(neighborhoods) : null,
    dietary: dietary ? JSON.stringify(dietary) : null,
    comm_preference: 'telegram',
  });

  db.resolveInvite(invite.token, 'accepted_full', contactId);

  // Notify inviter's agent
  const inviter = db.getUser(invite.created_by_user_id);
  if (inviter?.telegram_id) {
    telegram.notifyUser(inviter.telegram_id,
      `🦋 ${name} signed up for their own ButterflAI! Once their agent is set up, ours can coordinate automatically.`
    );
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  const deepLink = botUsername
    ? `https://t.me/${botUsername}?start=user_${userId}`
    : null;

  res.json({ ok: true, tier: 2, userId, deepLink });
});

// ── Telegram webhook (production) ────────────────────────────────────────────

app.post(`/webhook/telegram/${process.env.WEBHOOK_SECRET || 'butterflai-secret'}`, (req, res) => {
  if (bot) bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ── Generate invite (internal agent API) ─────────────────────────────────────

app.post('/api/agent/invite/create', (req, res) => {
  const { userId, contactName } = req.body;
  // TODO: verify agent API key / ClawBank signature
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const user = db.getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const token = uuidv4().replace(/-/g, '');
  db.createInvite({ token, created_by_user_id: userId, contact_name: contactName || null });

  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  res.json({ token, url: `${baseUrl}/invite/${token}` });
});

app.listen(PORT, () => console.log(`ButterflAI web running on :${PORT}`));
