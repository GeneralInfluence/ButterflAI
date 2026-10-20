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

module.exports = { nameFor, PLACEHOLDER };
