/**
 * connections.js — tell people when a connection stops working (owner, 2026-10-19: "I want
 * to be told when the grants or any other types of connections expire so that way they can
 * be fixed or reconnected").
 *
 * Sean's Google grant (Calendar + Contacts, one consent) expired on Oct 16 — Google ends
 * grants after 7 days while the OAuth app is in "testing" — and for three days plans quietly
 * stopped reaching his calendar and contacts stopped syncing.
 *
 * Connections: 'google' (Calendar + Contacts — one grant) and 'apple' (iCloud Calendar,
 * app-specific password). Every place that uses one reports here: an auth failure → broken();
 * a success → ok(). A daily check (coord loop) tries each connection even when nothing is
 * using it. The first time one breaks, its owner is told once — in the app with a push, or
 * by text if they have no notifications (deliver.notifySelf) — with what stopped and a link
 * to reconnect; again after 3 days if it's still broken (at most twice). Settings shows
 * "Reconnect". Reconnecting (new grant / new password) marks it ok.
 */
'use strict';

const db = require('./db');

const now = () => Math.floor(Date.now() / 1000);
const REMIND_AFTER = 3 * 86400;
const CHECK_EVERY = 20 * 3600;

const NAMES = { google: 'Google', apple: 'Apple Calendar' };
const WHAT = {
  google: 'your plans aren\'t reaching your Google Calendar and your contacts aren\'t syncing',
  apple: 'your plans aren\'t reaching your Apple Calendar',
};

/** Is this error the connection itself failing (expired / revoked / wrong password)? Not a blip. */
function isAuthError(err) {
  const s = `${err?.message || ''} ${err?.response?.data?.error || ''} ${err?.code || ''} ${err?.status || ''}`;
  return /invalid_grant|invalid_client|unauthorized_client|Invalid Credentials|token has been expired or revoked|\b401\b|Unauthorized|login failed|invalid credentials/i.test(s)
    && !/ECONN|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(s);
}
const reason = (err) => {
  const s = String(err?.message || err || '');
  return /invalid_grant|expired or revoked/i.test(s) ? 'Google ended ButterflAI\'s access' : /\b401\b|Unauthorized|credentials/i.test(s) ? 'the password or access was refused' : s.slice(0, 120);
};

function row(userId, key) { return db._raw().prepare('SELECT * FROM connection_health WHERE user_id = ? AND key = ?').get(userId, key); }

/** It worked (or was just reconnected): clear any warning. */
function ok(userId, key) {
  if (!userId) return;
  const was = row(userId, key);
  if (was?.status === 'broken') {
    // Back: retry what failed while it was down, and bring every plan up to date.
    try { db._raw().prepare('UPDATE calendar_mirror SET attempts = 0 WHERE user_id = ?').run(userId); require('./calmirror').markAllFor(userId); require('./calmirror').flushSoon(); } catch (_) {}
  }
  db._raw().prepare(`INSERT INTO connection_health (user_id, key, status, checked_at) VALUES (?, ?, 'ok', ?)
    ON CONFLICT(user_id, key) DO UPDATE SET status = 'ok', error = NULL, broken_at = NULL, notified_at = NULL, checked_at = excluded.checked_at`).run(userId, key, now());
}

/** It failed because the connection itself no longer works. Tells the owner (once, then a reminder). */
async function broken(userId, key, err) {
  if (!userId || !NAMES[key]) return null;
  const before = row(userId, key);
  if (!before || before.status !== 'broken') {
    db._raw().prepare(`INSERT INTO connection_health (user_id, key, status, error, broken_at, checked_at) VALUES (?, ?, 'broken', ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET status = 'broken', error = excluded.error, broken_at = excluded.broken_at, notified_at = NULL, checked_at = excluded.checked_at`)
      .run(userId, key, reason(err), now(), now());
  }
  return tell(userId, key);
}

async function tell(userId, key) {
  const r = row(userId, key);
  if (!r || r.status !== 'broken') return null;
  const reminders = r.notified_at ? 1 : 0;   // told before → this is the reminder
  if (r.notified_at && (now() - r.notified_at < REMIND_AFTER || now() - r.broken_at > 2 * REMIND_AFTER)) return null;
  const { LINKS } = require('./links');
  const text = `⚠️ Your ${NAMES[key]} connection stopped working (${r.error || 'access ended'}) — ${WHAT[key]}. Reconnect it in Settings → Connections: ${LINKS.settings}`
    + (reminders ? ' (still disconnected)' : '');
  db.appendConversation(userId, 'assistant', text, null, 'notice');
  const online = require('./sse').push(userId, { role: 'assistant', kind: 'notice', text, ts: now() });
  try { await require('./deliver').notifySelf(db.getUser(userId), text, { online }); } catch (_) {}
  db._raw().prepare('UPDATE connection_health SET notified_at = ? WHERE user_id = ? AND key = ?').run(now(), userId, key);
  return text;
}

/** Report the outcome of a call that used a connection. Returns the error (rethrow-friendly). */
function report(userId, key, err) {
  if (!err) { ok(userId, key); return null; }
  if (isAuthError(err)) broken(userId, key, err).catch(() => {});
  return err;
}

/** For Settings: { google: {broken, error, since}, apple: {...} } */
function statusFor(userId) {
  const out = {};
  for (const r of db._raw().prepare("SELECT key, error, broken_at FROM connection_health WHERE user_id = ? AND status = 'broken'").all(userId)) {
    out[r.key] = { broken: true, error: r.error, since: r.broken_at };
  }
  return out;
}

/**
 * Daily: try each connected account even when nothing is using it, so an expiry is noticed
 * the day it happens. Also sends any reminder due. Returns how many were checked.
 */
async function checkAll({ force = false } = {}) {
  let n = 0;
  const calendar = require('./calendar');
  const due = (userId, key) => force || !(row(userId, key)?.checked_at > now() - CHECK_EVERY);
  const google = db._raw().prepare(`SELECT DISTINCT user_id FROM (SELECT user_id FROM calendar_tokens WHERE provider = 'google'
    UNION SELECT user_id FROM contact_sync_tokens WHERE provider = 'google')`).all();
  for (const { user_id: u } of google) {
    if (!due(u, 'google')) { await tell(u, 'google'); continue; }
    n++;
    try { await calendar.checkGoogleAccess(u); ok(u, 'google'); }
    catch (err) { if (isAuthError(err)) await broken(u, 'google', err); else db._raw().prepare('UPDATE connection_health SET checked_at = ? WHERE user_id = ? AND key = ?').run(now(), u, 'google'); }
  }
  for (const { user_id: u } of db._raw().prepare("SELECT user_id FROM calendar_tokens WHERE provider = 'apple'").all()) {
    if (!due(u, 'apple')) { await tell(u, 'apple'); continue; }
    n++;
    try { await require('./calendar-apple').checkAccess(u); ok(u, 'apple'); }
    catch (err) { if (isAuthError(err)) await broken(u, 'apple', err); }
  }
  return n;
}

module.exports = { ok, broken, report, isAuthError, statusFor, checkAll, tell };
