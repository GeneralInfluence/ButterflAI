/**
 * mentions.js — who the user means, from how and where they've talked about people.
 *
 * Owner, 2026-10-09: "I may say 'Al' … I've been calling Allie 'Al' recently. As I use
 * Al for activities in my city, those activities and groups should be part of the
 * context in knowing that name. One day I may find a friend named Al, an entirely
 * different person, and the context of the activities should make that clear."
 *
 *  - Each time the user acts on someone, we record the name they used and the context:
 *    the plan, activity, place and group (in code, agent.js).
 *  - lookup_contact passes what the conversation is about. When two people fit the
 *    name, the one whose past context matches wins; if context doesn't clearly separate
 *    them, the agent asks — and says why each might be the one.
 * Recent mentions count more (45-day half-life). Owner-only data, like contacts.
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { norm } = require('./names');

const HALF_LIFE_DAYS = 45;
// Passively accumulated data must expire (MEMORY.md §3.6). At 180 days a mention counts
// ~6% of a fresh one; past that it's deleted. Learned aliases on the contact stay until
// the user removes them.
const RETENTION_DAYS = 180;
const STOP = new Set(['the', 'and', 'with', 'for', 'our', 'my', 'trip', 'plan', 'plans', 'about', 'this', 'that', 'some', 'tonight', 'today', 'tomorrow', 'weekend', 'party', 'thing']);
const terms = (s) => [...new Set(norm(s).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)))];

/** Words describing an event / group, for matching later conversations. */
function describe({ eventId, groupId }) {
  const parts = [];
  let gid = groupId;
  if (eventId) {
    const e = db._raw().prepare('SELECT title, activity_type, venue_name, group_id FROM social_events WHERE id = ?').get(eventId);
    if (e) { parts.push(e.title, e.activity_type, e.venue_name); gid = gid || e.group_id; }
  }
  if (gid) {
    const g = db._raw().prepare('SELECT name FROM contact_groups WHERE id = ?').get(gid);
    if (g) parts.push(g.name);
  }
  return { words: terms(parts.filter(Boolean).join(' ')).join(' '), groupId: gid || null, label: parts.filter(Boolean).slice(0, 2).join(' · ') };
}

// `context` = what the conversation was about when the user used the name (from lookup).
function record(userId, contactId, { nameUsed = null, eventId = null, groupId = null, context = '' } = {}) {
  const d = describe({ eventId, groupId });
  d.words = [...new Set([...d.words.split(' '), ...terms(context)].filter(Boolean))].join(' ');
  // Same person, same name, same context within a day counts once (five messages to Allie
  // about Grover in an afternoon are one mention, not five).
  const name = nameUsed ? String(nameUsed).slice(0, 40) : null;
  const dup = db._raw().prepare(`SELECT 1 FROM contact_mentions WHERE user_id = ? AND contact_id = ? AND name_used IS ? AND context IS ?
    AND created_at > strftime('%s','now') - 86400`).get(userId, contactId, name, d.words || null);
  if (dup) return false;
  db._raw().prepare(`INSERT INTO contact_mentions (id, user_id, contact_id, name_used, event_id, group_id, context) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(uuidv4(), userId, contactId, name, eventId, d.groupId, d.words || null);
  return true;
}

/** Hard-delete mentions past retention. */
function purgeOld() {
  return db._raw().prepare(`DELETE FROM contact_mentions WHERE created_at < strftime('%s','now') - ?`).run(RETENTION_DAYS * 86400).changes;
}

/**
 * How well a candidate fits: { nameUses, contextHits, why }.
 *  nameUses    — recency-weighted times the user called them `query`
 *  contextHits — recency-weighted overlap between `context` and where they came up
 *                (past mentions, their groups, plans they're invited to)
 */
function fit(userId, contact, query, context) {
  const now = Math.floor(Date.now() / 1000);
  const w = (ts) => Math.pow(0.5, (now - ts) / (HALF_LIFE_DAYS * 86400));
  const rows = db._raw().prepare('SELECT name_used, context, event_id, group_id, created_at FROM contact_mentions WHERE user_id = ? AND contact_id = ?').all(userId, contact.id);
  const q = norm(query);
  let nameUses = 0, contextHits = 0;
  const where = new Map();
  const want = terms(context || '');
  for (const r of rows) {
    if (q && norm(r.name_used) === q) nameUses += w(r.created_at);
    const have = new Set(String(r.context || '').split(' '));
    const hit = want.filter((t) => have.has(t)).length;
    if (hit) {
      contextHits += hit * w(r.created_at);
      const d = describe({ eventId: r.event_id, groupId: r.group_id });
      if (d.label) where.set(d.label, (where.get(d.label) || 0) + 1);
    }
  }
  // Present-day links count too: their groups and the plans they're invited to.
  if (want.length) {
    const groups = db._raw().prepare(`SELECT g.name FROM contact_groups g JOIN contact_group_members m ON m.group_id = g.id WHERE g.user_id = ? AND m.contact_id = ?`).all(userId, contact.id);
    const events = db._raw().prepare(`SELECT se.title, se.activity_type, se.venue_name FROM social_events se JOIN event_invitations ei ON ei.event_id = se.id
      WHERE se.host_user_id = ? AND ei.contact_id = ? AND COALESCE(se.status, 'open') != 'cancelled'`).all(userId, contact.id);
    for (const x of [...groups.map((g) => g.name), ...events.map((e) => [e.title, e.activity_type, e.venue_name].join(' '))]) {
      const hit = want.filter((t) => terms(x).includes(t)).length;
      if (hit) { contextHits += hit; where.set(String(x).split(' ').slice(0, 4).join(' ').trim(), 1); }
    }
  }
  const whyParts = [];
  if (nameUses >= 0.5) whyParts.push(`you've called them "${query}" before`);
  if (where.size) whyParts.push(`came up with ${[...where.keys()].slice(0, 3).join(', ')}`);
  return { nameUses, contextHits, why: whyParts.join('; ') || undefined };
}

module.exports = { record, fit, terms, purgeOld, RETENTION_DAYS };
