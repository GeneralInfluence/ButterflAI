/**
 * wishes.js — things you'd love to happen, cast out into your world (owner, 2026-10-20: "things I
 * wish would happen. They're not concrete plans … trying to cast a spell into the world so to speak
 * in order to bring the world together").
 *
 * Owner decisions (2026-10-20):
 *  - It's between the agents: everybody says what they wish for and the agents look for overlap.
 *    People don't browse each other's wishes.
 *  - A match is only made when it's BOTH people's wish (a mutual wish). Both hear about it. Anything
 *    else is the wisher's own to make happen.
 *  - You see who it is only if they're close to you (you have each other saved). Outside your circle,
 *    serendipity: "someone near you also wishes for …" — anonymous until BOTH say they're open to it;
 *    then names are shared and they get a plan together.
 * Protections (PRIVACY.md "Wishes"): nearby = same city / within 80 km, from shared location only;
 * avoid lists both ways; per wish "Only people I know" (open_to_new = 0); wishes end after 60 days and
 * are deleted when removed; a wish's text is never shown to anyone — only what the two have in common.
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { createAnthropicClient, DEFAULT_MODEL } = require('./anthropic-client');

const KEEP_DAYS = 60;
const NEARBY_KM = 80;
const now = () => Math.floor(Date.now() / 1000);

let _client = null;
let _enabled = process.env.NODE_ENV !== 'test';
function _setClient(c) { _client = c; _enabled = !!c; }
function client() {
  if (!_enabled) return null;
  if (!_client) { try { _client = createAnthropicClient(); } catch (_) { _enabled = false; return null; } }
  return _client;
}

const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 200);

function add(userId, { text, open_to_new = true }) {
  const t = clean(text);
  if (!t) return { error: 'EMPTY', message: 'Say what you wish for.' };
  const id = uuidv4();
  db._raw().prepare('INSERT INTO wishes (id, user_id, text, open_to_new, expires_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, t, open_to_new ? 1 : 0, now() + KEEP_DAYS * 86400);
  return { ok: true, wish: view(db._raw().prepare('SELECT * FROM wishes WHERE id = ?').get(id)) };
}
function own(userId, id) { return db._raw().prepare('SELECT * FROM wishes WHERE id = ? AND user_id = ?').get(id, userId); }
function update(userId, id, { open_to_new }) {
  const w = own(userId, id); if (!w) return { error: 'NOT_FOUND' };
  if (open_to_new !== undefined) db._raw().prepare('UPDATE wishes SET open_to_new = ? WHERE id = ?').run(open_to_new ? 1 : 0, id);
  return { ok: true, wish: view(db._raw().prepare('SELECT * FROM wishes WHERE id = ?').get(id)) };
}
function remove(userId, id) {
  const w = own(userId, id); if (!w) return { error: 'NOT_FOUND' };
  forget([id]);
  return { ok: true };
}
function forget(ids) {
  for (const id of ids) {
    db._raw().prepare('DELETE FROM wish_matches WHERE wish_a = ? OR wish_b = ?').run(id, id);
    db._raw().prepare('DELETE FROM wish_checked WHERE wish_a = ? OR wish_b = ?').run(id, id);
    db._raw().prepare('DELETE FROM wishes WHERE id = ?').run(id);
  }
}
const view = (w) => ({ id: w.id, text: w.text, open_to_new: !!w.open_to_new, status: w.status, event_id: w.event_id || null, expires_at: w.expires_at });

// ── Who may be matched with whom ─────────────────────────────────────────────
function hasSaved(ownerId, other) {
  return !!(other?.phone && db._raw().prepare('SELECT 1 FROM contacts WHERE invited_by_user_id = ? AND phone = ? AND COALESCE(hidden, 0) = 0').get(ownerId, other.phone));
}
/** Close = you have each other saved. */
function close(a, b) { return hasSaved(a.id, b) && hasSaved(b.id, a); }
function avoids(a, b) {
  try {
    const avoid = require('./avoid');
    const list = (u) => avoid.listAvoid(u.id, { accessor: 'wishes', context: 'wish matching (never shown)' });
    return !!(avoid.findByPhone(list(a), b.phone) || avoid.findByPhone(list(b), a.phone));
  } catch (_) { return true; }   // can't check → don't match
}
function km(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Near enough to meet, from shared location only (city, or coordinates within 80 km). */
function nearby(a, b) {
  if (a.share_location === 0 || b.share_location === 0) return false;
  if (a.lat != null && b.lat != null && a.lng != null && b.lng != null) return km(a, b) <= NEARBY_KM;
  return !!(a.city && b.city && a.city.trim().toLowerCase() === b.city.trim().toLowerCase());
}

/** The wishes this wish may be compared with: close people's, and open nearby people's when both are open. */
function candidates(w) {
  const me = db.getUser(w.user_id);
  if (!me) return [];
  return db._raw().prepare("SELECT * FROM wishes WHERE status = 'active' AND user_id != ? AND expires_at > ?").all(w.user_id, now())
    .filter((o) => !db._raw().prepare('SELECT 1 FROM wish_checked WHERE (wish_a = ? AND wish_b = ?) OR (wish_a = ? AND wish_b = ?)').get(w.id, o.id, o.id, w.id))
    .map((o) => ({ o, u: db.getUser(o.user_id) }))
    .filter(({ u }) => u && !avoids(me, u))
    .map(({ o, u }) => ({ o, u, kind: close(me, u) ? 'friend' : (w.open_to_new && o.open_to_new && nearby(me, u)) ? 'nearby' : null }))
    .filter((c) => c.kind)
    .slice(0, 30);
}

/** Ask the model which candidate wishes are the same wish as this one — something they could do together. */
async function compare(w, cands) {
  const c = client();
  if (!c || !cands.length) return [];
  const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: 400, messages: [{ role: 'user', content:
    `A person wishes: "${w.text}"\n\nOther people's wishes (by id):\n${cands.map((x) => `- ${x.o.id}: "${x.o.text}"`).join('\n')}\n\n`
    + 'Which of these are the SAME wish — something these two people could genuinely do together (same activity or experience; timing compatible if any is given)? '
    + 'Be strict: "go to the hot springs" and "relax somewhere warm" can match; "learn salsa" and "go dancing" can match; "see a movie" and "go hiking" do not. '
    + 'For each match give a short name for doing it together ("Hot springs this fall"). Reply with JSON only: {"matches":[{"id":"…","together":"…"}]} or {"matches":[]}.' }] });
  try {
    const j = JSON.parse(String((r.content || []).map((b) => b.text || '').join('')).match(/\{[\s\S]*\}/)[0]);
    const ok = new Set(cands.map((x) => x.o.id));
    return (j.matches || []).filter((m) => ok.has(m.id)).map((m) => ({ id: m.id, together: clean(m.together) || clean(w.text) }));
  } catch (_) { return []; }
}

function notify(userId, text) {
  require('./ripples/notice').inApp(userId, null, text, { url: '/app/dashboard#feeling' });
}
function nameOf(viewerId, otherId) { return require('./people').nameFor(viewerId, otherId, { first: true }); }

/** Find mutual wishes for every active wish not yet compared. Returns how many matches were made. */
async function match({ limit = 40 } = {}) {
  let made = 0;
  const active = db._raw().prepare("SELECT * FROM wishes WHERE status = 'active' AND expires_at > ? ORDER BY created_at DESC LIMIT ?").all(now(), limit);
  for (const w of active) {
    const cands = candidates(w);
    if (!cands.length) continue;
    let found;
    try { found = await compare(w, cands); } catch (err) { console.warn('[wishes] compare failed:', err.message); continue; }
    for (const x of cands) db._raw().prepare('INSERT OR IGNORE INTO wish_checked (wish_a, wish_b) VALUES (?, ?)').run(w.id, x.o.id);
    for (const m of found) {
      const x = cands.find((c) => c.o.id === m.id);
      const id = uuidv4();
      const r = db._raw().prepare('INSERT OR IGNORE INTO wish_matches (id, wish_a, wish_b, user_a, user_b, kind, together) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, w.id, x.o.id, w.user_id, x.o.user_id, x.kind, m.together);
      if (!r.changes) continue;
      made++;
      // Both hear about it — it's both their wish (owner, 2026-10-20).
      if (x.kind === 'friend') {
        notify(w.user_id, `✨ ${nameOf(w.user_id, x.o.user_id)} wishes for this too: ${m.together}. Make it a plan? (Home → Wishes)`);
        notify(x.o.user_id, `✨ ${nameOf(x.o.user_id, w.user_id)} wishes for this too: ${m.together}. Make it a plan? (Home → Wishes)`);
      } else {
        const city = (u) => (db.getUser(u)?.city ? ` in ${db.getUser(u).city}` : ' near you');
        notify(w.user_id, `✨ Someone${city(w.user_id)} wishes for this too: ${m.together}. Open to meeting them? (Home → Wishes)`);
        notify(x.o.user_id, `✨ Someone${city(x.o.user_id)} wishes for this too: ${m.together}. Open to meeting them? (Home → Wishes)`);
      }
    }
  }
  return made;
}

/** A match as this viewer sees it: a name only if close or both said yes. */
function matchView(m, viewerId) {
  const meA = m.user_a === viewerId;
  const other = meA ? m.user_b : m.user_a;
  const mine = meA ? m.a_answer : m.b_answer, theirs = meA ? m.b_answer : m.a_answer;
  const named = m.kind === 'friend' || (m.a_answer === 'open' && m.b_answer === 'open');   // both said yes → introduced
  return { id: m.id, kind: m.kind, together: m.together, status: m.status, event_id: m.event_id,
    who: named ? nameOf(viewerId, other) : null, my_answer: mine || null, waiting_on_them: m.kind === 'nearby' && mine === 'open' && !theirs };
}
function forUser(userId) {
  const mine = db._raw().prepare("SELECT * FROM wishes WHERE user_id = ? AND status != 'removed' AND expires_at > ? ORDER BY created_at DESC").all(userId, now()).map(view);
  const matches = db._raw().prepare("SELECT * FROM wish_matches WHERE (user_a = ? OR user_b = ?) AND status != 'dismissed' ORDER BY created_at DESC").all(userId, userId)
    .filter((m) => { const mine = m.user_a === userId ? m.a_answer : m.b_answer; return mine !== 'no'; })
    .map((m) => matchView(m, userId));
  return { mine, matches };
}

/** Make the plan the two of them wish for (host = the person who asked), with the other invited. */
async function planFor(m, hostId, guestId) {
  const host = db.getUser(hostId), guest = db.getUser(guestId);
  let cid = db._raw().prepare('SELECT id FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(hostId, guest.phone)?.id;
  if (!cid) cid = db.upsertContact({ invited_by_user_id: hostId, name: guest.name, phone: guest.phone, tier: 1 });
  if (!db._raw().prepare('SELECT 1 FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(guestId, host.phone)) {
    db.upsertContact({ invited_by_user_id: guestId, name: host.name, phone: host.phone, tier: 1 });   // they've met through a wish now
  }
  const r = await require('./planops').create(hostId, { title: m.together.slice(0, 80), activity_type: 'hangout', tentative: true, contact_ids: [cid] }, { via: 'wish' });
  const eventId = r.eventId || null;   // a new plan, or the open one with that name (PLAN_EXISTS)
  if (eventId) {
    db._raw().prepare("UPDATE wish_matches SET status = 'planned', event_id = ? WHERE id = ?").run(eventId, m.id);
    db._raw().prepare("UPDATE wishes SET status = 'planned', event_id = ? WHERE id IN (?, ?)").run(eventId, m.wish_a, m.wish_b);
  }
  return { ...r, eventId };
}

/**
 * Answer a match. friend: 'plan' (make it a plan with them) or 'no'. nearby: 'open' (open to
 * meeting) or 'no'; when both are open, names are shared and a plan is made with both.
 */
async function answer(userId, matchId, ans) {
  const m = db._raw().prepare('SELECT * FROM wish_matches WHERE id = ? AND (user_a = ? OR user_b = ?)').get(matchId, userId, userId);
  if (!m) return { error: 'NOT_FOUND' };
  if (!['plan', 'open', 'no'].includes(ans)) return { error: 'BAD_ANSWER' };
  const meA = m.user_a === userId, other = meA ? m.user_b : m.user_a;
  db._raw().prepare(`UPDATE wish_matches SET ${meA ? 'a_answer' : 'b_answer'} = ? WHERE id = ?`).run(ans, m.id);
  if (ans === 'no') return { ok: true, status: 'no' };   // the other person is never told
  if (m.status === 'planned') return { ok: true, status: 'planned', event_id: m.event_id };
  if (m.kind === 'friend') {
    const r = await planFor(m, userId, other);
    if (r.eventId) notify(other, `✨ ${nameOf(other, userId)} made it a plan: ${m.together}. It's in your Plans.`);
    return { ok: !!r.eventId, status: 'planned', event_id: r.eventId, error: r.eventId ? undefined : r.error };
  }
  const fresh = db._raw().prepare('SELECT * FROM wish_matches WHERE id = ?').get(m.id);
  if (fresh.a_answer === 'open' && fresh.b_answer === 'open') {
    db._raw().prepare("UPDATE wish_matches SET status = 'connected' WHERE id = ?").run(m.id);
    const r = await planFor(fresh, userId, other);
    notify(other, `✨ You're both open to it: ${nameOf(other, userId)} wishes for ${m.together} too. There's a plan for the two of you in Plans.`);
    return { ok: true, status: 'connected', event_id: r.eventId, who: nameOf(userId, other) };
  }
  return { ok: true, status: 'waiting' };
}

/** Wishes end after 60 days (owner choice). */
function purgeOld() {
  const old = db._raw().prepare('SELECT id FROM wishes WHERE expires_at < ?').all(now()).map((r) => r.id);
  forget(old);
  return old.length;
}

module.exports = { add, update, remove, forUser, match, answer, purgeOld, candidates, nearby, close, KEEP_DAYS, _setClient };
