/**
 * linktoken.js — signed, expiring links that act for one user, for one purpose.
 *
 * Security fix (2026-10-09): the calendar/contacts connect links and the Google OAuth
 * `state` carried a bare userId. Anyone could start a connect flow for another user and
 * attach THEIR OWN Google/Apple calendar or contacts to that user's ButterflAI — whose
 * agent would then write that person's plans into the attacker's calendar. A link token
 * names the user and purpose, expires, and is HMAC-signed with a key derived from
 * JWT_SECRET (fails closed if unset).
 */
'use strict';

const crypto = require('crypto');

function key() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set');
  return crypto.createHash('sha256').update('butterflai-link:' + s).digest();
}
const mac = (body) => crypto.createHmac('sha256', key()).update(body).digest('base64url');

/** A token for `userId`, usable only for `purpose`, valid for `ttlSecs`. */
function sign(userId, purpose, ttlSecs) {
  const body = Buffer.from(JSON.stringify({ u: userId, p: purpose, e: Math.floor(Date.now() / 1000) + ttlSecs,
    n: crypto.randomBytes(6).toString('base64url') })).toString('base64url');
  return `${body}.${mac(body)}`;
}

/** The userId if `token` is valid, unexpired and for `purpose`; otherwise null. */
function verify(token, purpose) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const want = Buffer.from(mac(body)), got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const { u, p, e } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p !== purpose || !u || !(e > Math.floor(Date.now() / 1000))) return null;
    return u;
  } catch (_) { return null; }
}

const DAY = 86400;
const TTL = { link: 7 * DAY, oauth: 30 * 60, form: 30 * 60 };

module.exports = { sign, verify, TTL };
