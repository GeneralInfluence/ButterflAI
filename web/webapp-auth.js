'use strict';

/**
 * Web app authentication — phone OTP + JWT
 *
 * Flow:
 *   1. POST /auth/otp/send   { phone }     → sends 6-digit code via SMS
 *   2. POST /auth/otp/verify { phone, code } → returns JWT in httpOnly cookie
 *   3. Middleware requireAuth(req, res, next) → validates cookie on protected routes
 */

const { v4: uuidv4 } = require('uuid');
const jwt            = require('jsonwebtoken');
const db             = require('./db');
const sms            = require('./sms');
const { toE164 }     = require('./phoneUtils');

const JWT_SECRET  = process.env.JWT_SECRET;
const OTP_TTL_SEC = 5 * 60; // 5 minutes
const JWT_TTL     = '30d';
const COOKIE_NAME = 'bfly_session';

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function storeOtp(phone, code) {
  const id         = uuidv4();
  const expiresAt  = Math.floor(Date.now() / 1000) + OTP_TTL_SEC;
  db._raw().prepare(
    'INSERT INTO otp_codes (id, phone, code, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, phone, code, expiresAt);
  return id;
}

function verifyOtp(phone, code) {
  const row = db._raw().prepare(
    `SELECT * FROM otp_codes
     WHERE phone=? AND code=? AND used=0 AND expires_at > strftime('%s','now')
     ORDER BY created_at DESC LIMIT 1`
  ).get(phone, code);
  if (!row) return false;
  db._raw().prepare('UPDATE otp_codes SET used=1 WHERE id=?').run(row.id);
  return true;
}

function cleanExpiredOtps() {
  db._raw().prepare(`DELETE FROM otp_codes WHERE expires_at < strftime('%s','now') - 3600`).run();
}

// ── JWT ───────────────────────────────────────────────────────────────────────

function issueToken(userId) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET not set');
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_TTL });
}

function verifyToken(token) {
  if (!JWT_SECRET) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// ── Middleware ────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Session expired.' });
  const user = db.getUser(payload.userId);
  if (!user) return res.status(401).json({ error: 'User not found.' });
  req.user = user;
  next();
}

function requireAuthPage(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.redirect('/app/login');
  const payload = verifyToken(token);
  if (!payload) return res.redirect('/app/login');
  const user = db.getUser(payload.userId);
  if (!user) return res.redirect('/app/login');
  req.user = user;
  next();
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function sendOtp(req, res) {
  const rawPhone = req.body?.phone;
  if (!rawPhone) return res.status(400).json({ error: 'phone required' });

  let phone;
  try { phone = toE164(rawPhone); } catch {
    return res.status(400).json({ error: 'Invalid phone number.' });
  }

  const code = generateOtp();
  storeOtp(phone, code);
  cleanExpiredOtps();

  try {
    await sms.send(phone,
      `Your ButterflAI verification code is: ${code}\n\nExpires in 5 minutes.`,
      { skipConsentCheck: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] OTP send failed:', err.message);
    res.status(500).json({ error: 'Failed to send code. Try again.' });
  }
}

function verifyOtpHandler(req, res) {
  const rawPhone = req.body?.phone;
  const code     = String(req.body?.code || '').trim();

  if (!rawPhone || !code) return res.status(400).json({ error: 'phone and code required' });

  let phone;
  try { phone = toE164(rawPhone); } catch {
    return res.status(400).json({ error: 'Invalid phone number.' });
  }

  if (!verifyOtp(phone, code)) {
    return res.status(401).json({ error: 'Invalid or expired code.' });
  }

  // Find or create user
  let user = db.getUserByPhone(phone);
  if (!user) {
    // New user — create account, start onboarding
    const id = uuidv4();
    db.createUser({ id, phone, name: 'New user', onboarding_state: 'new' });
    user = db.getUser(id);
  }

  const token = issueToken(user.id);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });

  res.json({ ok: true, userId: user.id, name: user.name });
}

function logout(req, res) {
  res.clearCookie(COOKIE_NAME);
  res.redirect('/app/login');
}

module.exports = {
  requireAuth,
  requireAuthPage,
  sendOtp,
  verifyOtpHandler,
  logout,
  issueToken,
  verifyToken,
  COOKIE_NAME,
};
