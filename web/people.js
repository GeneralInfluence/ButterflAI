/**
 * people.js — what to call another ButterflAI user, as THIS viewer knows them.
 *
 * 2026-10-20: Sean's agent said "I asked New's assistant…" — Alexandria never finished signing
 * up, so her account is still named "New user"; agent queries, replies and notices used the
 * account name. Now: the viewer's own contact name for that person (nickname first), else the
 * account name unless it's a placeholder, else "a friend".
 */
'use strict';

const db = require('./db');

const PLACEHOLDER = /^(new user|new|user|unknown|test)$/i;

function nameFor(viewerId, otherUserId, { first = false } = {}) {
  const other = otherUserId && db.getUser(otherUserId);
  let name = null;
  if (other?.phone && viewerId) {
    const c = db._raw().prepare('SELECT COALESCE(nickname, name) AS n FROM contacts WHERE invited_by_user_id = ? AND phone = ? ORDER BY updated_at DESC LIMIT 1').get(viewerId, other.phone);
    if (c?.n && !PLACEHOLDER.test(String(c.n).trim())) name = c.n;
  }
  if (!name && other?.name && !PLACEHOLDER.test(String(other.name).trim())) name = other.name;
  name = String(name || 'A friend').trim();
  return first ? name.split(/\s+/)[0] : name;
}

/**
 * The name people already know someone by, for an account that has none yet (owner,
 * 2026-10-20: "you should be able to use the name from the person who invited them … she
 * should already have the name Alex"). The contact on their first invitation (who invited
 * them), else how most people saved that number. null if nobody has a real name for it.
 */
function knownName(phone) {
  if (!phone) return null;
  const ok = (n) => n && !PLACEHOLDER.test(String(n).trim()) && /\p{L}/u.test(n);
  const inviter = db._raw().prepare(`SELECT COALESCE(c.nickname, c.name) AS n FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
    WHERE c.phone = ? ORDER BY ei.created_at, ei.rowid LIMIT 5`).all(phone).map((r) => r.n).find(ok);
  if (inviter) return String(inviter).trim();
  const counts = new Map();
  for (const r of db._raw().prepare('SELECT COALESCE(nickname, name) AS n FROM contacts WHERE phone = ?').all(phone)) {
    if (ok(r.n)) counts.set(r.n.trim(), (counts.get(r.n.trim()) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/** An account still on a placeholder name gets the name people know them by (if any). Returns the name or null. */
function fillName(user) {
  if (!user || !PLACEHOLDER.test(String(user.name || '').trim())) return null;
  const n = knownName(user.phone);
  if (n) db.updateUser(user.id, { name: n.slice(0, 60) });
  return n;
}

module.exports = { nameFor, knownName, fillName, PLACEHOLDER };
