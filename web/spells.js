/**
 * spells.js — ButterflAI imagines what's possible for you (owner, 2026-10-20, 🐛 #36: "imagine
 * what's possible. Based on text that the person has had in the past … you could be doing this, you
 * could be going there … ways in which somebody could be expanding their social network … butterfly
 * ends up making things happen by constantly casting spells … putting ideas in people's heads").
 *
 * Once a day per person (coord loop), a short model call — with web search for what's on near them —
 * imagines a few ideas ("spells"): something happening nearby, reconnecting with a friend they
 * haven't seen in a while, something new that widens their circle, something from their wishes.
 * Each can become a wish (✨ Sounds nice — then mutual-wish matching starts, wishes.js), a plan (＋),
 * or be dismissed (remembered, so similar ones stop).
 *
 * Privacy (PRIVACY.md "Spells"): built ONLY from the person's own conversation, plans and wishes, and
 * public web results — never other people's chats. Friends named are the person's own contacts from
 * their own plans, never anyone on their avoid list (checked in code). Private-mode messages are never
 * read. Kept 7 days.
 *
 * 🐛 #37 — passing ideas on: ✨ Sounds nice on a public idea (something on nearby, something new) also
 * passes it on, without the person's name, to people associated with them in the same town — friends
 * and people they've made plans with — as "people around you like this"; and ideas liked around them
 * shape what ButterflAI imagines next for everyone nearby. Only the idea's public title (no one named)
 * ever spreads; ideas about friends or wishes never do. Avoid lists apply both ways.
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { createAnthropicClient, DEFAULT_MODEL } = require('./anthropic-client');

const KEEP_DAYS = 7;
const EVERY = 20 * 3600;
const KINDS = ['nearby', 'reconnect', 'new', 'wish'];
const PUBLIC_KINDS = ['nearby', 'new'];   // the only ideas that spread (no one's friends or wishes)
const PER_BATCH = 8;
const MAX_PER_DAY = 80;                    // the daily batch + more as the ✨ Feed is scrolled (10 batches)
const ECHOES_PER_DAY = 3;                  // passed-on ideas one person receives a day
const now = () => Math.floor(Date.now() / 1000);

let _client = null;
let _enabled = process.env.NODE_ENV !== 'test';
function _setClient(c) { _client = c; _enabled = !!c; }
function client() {
  if (!_enabled) return null;
  if (!_client) { try { _client = createAnthropicClient(); } catch (_) { _enabled = false; return null; } }
  return _client;
}

const clean = (t, n = 140) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** What the person's own ButterflAI knows that's relevant (theirs only). */
function contextFor(user) {
  const t = now();
  const plans = db._raw().prepare(`SELECT se.title, se.scheduled_at, se.date_tbd FROM social_events se
    LEFT JOIN event_invitations ei ON ei.event_id = se.id LEFT JOIN contacts c ON c.id = ei.contact_id
    WHERE COALESCE(se.status, 'open') != 'cancelled' AND (se.host_user_id = ? OR (c.phone = ? AND ei.status = 'accepted'))
    AND se.created_at > ? GROUP BY se.id ORDER BY se.created_at DESC LIMIT 15`).all(user.id, user.phone || '', t - 90 * 86400);
  // Friends from their own plans, with when they last had one together — never avoided people.
  const avoid = require('./avoid');
  let avoided = [];
  try { avoided = avoid.listAvoid(user.id, { accessor: 'spells', context: 'spell ideas (never shown)' }); } catch (_) { avoided = null; }
  const friends = db._raw().prepare(`SELECT COALESCE(c.nickname, c.name) AS name, c.phone, max(se.scheduled_at) AS last FROM event_invitations ei
    JOIN contacts c ON c.id = ei.contact_id JOIN social_events se ON se.id = ei.event_id
    WHERE se.host_user_id = ? AND ei.status = 'accepted' AND COALESCE(se.status, 'open') != 'cancelled' GROUP BY c.phone ORDER BY last LIMIT 12`).all(user.id)
    .filter((f) => avoided && !avoid.findByPhone(avoided, f.phone));
  const said = db._raw().prepare(`SELECT text FROM conversation_history WHERE user_id = ? AND role = 'user' AND private_ct IS NULL
    AND created_at > ? ORDER BY created_at DESC LIMIT 25`).all(user.id, t - 30 * 86400).map((r) => clean(r.text, 200));
  const wishes = db._raw().prepare("SELECT text FROM wishes WHERE user_id = ? AND status = 'active'").all(user.id).map((r) => r.text);
  const dismissed = db._raw().prepare("SELECT title FROM spells WHERE user_id = ? AND status = 'dismissed' ORDER BY created_at DESC LIMIT 12").all(user.id).map((r) => r.title);
  const current = db._raw().prepare("SELECT title FROM spells WHERE user_id = ? AND status = 'new' AND expires_at > ?").all(user.id, t).map((r) => r.title);
  // Ideas people around them liked lately (no names) — how people nearby influence each other (🐛 #37).
  const around = [...new Set(associates(user.id).filter((u) => sameTown(user, u))
    .flatMap((u) => db._raw().prepare(`SELECT public_title FROM spells WHERE user_id = ? AND status = 'kept' AND public_title IS NOT NULL AND created_at > ?`).all(u.id, t - 14 * 86400).map((r) => r.public_title)))].slice(0, 10);
  return { plans, friends, said, wishes, dismissed, current, around, avoidedNames: (avoided || []).map((a) => a.name).filter(Boolean) };
}

const PROMPT = (user, c, today) => `You are ButterflAI, imagining what could be fun for ${String(user.name || 'this person').split(' ')[0]} — gentle ideas ("spells") that might make good things happen with the people in their life and widen their circle. Today is ${today}${user.city ? `; they live in ${user.city}` : ''}.

What you know (their own):
- Recent plans: ${c.plans.map((p) => p.title).join('; ') || 'none'}
- Friends they make plans with (and when they last did): ${c.friends.map((f) => `${String(f.name).split(' ')[0]}${f.last ? ` (${new Date(f.last * 1000).toISOString().slice(0, 10)})` : ''}`).join(', ') || 'none yet'}
- Their wishes: ${c.wishes.join('; ') || 'none yet'}
- Things they said lately: ${c.said.slice(0, 15).map((s) => `"${s}"`).join(' ') || 'nothing'}
- Not into (dismissed before — don't suggest anything like these): ${c.dismissed.join('; ') || 'nothing yet'}
- Ideas they already have (don't repeat): ${(c.current || []).join('; ') || 'none'}
- Liked lately by people around them (anonymous — a hint at what's good nearby): ${(c.around || []).join('; ') || 'nothing yet'}

${user.city ? `Search the web once or twice for what's actually on in or near ${user.city} in the next two weeks (shows, music, markets, classes, outdoor things) and use real ones.` : ''}
Imagine 8 ideas, two of each kind:
- "nearby": something real happening near them soon (name, day, place; include the link).
- "reconnect": doing something with a friend they haven't seen in a while (only friends listed above).
- "new": something that widens their circle — a class, a group, a meetup, a new scene.
- "wish": a way one of their wishes could happen (or, with no wishes, something they'd likely love from what they said).
Each: a short, inviting title (under 70 characters, like "Jazz at Shea's Thursday with Allie?") and one line why. Warm, specific, never pushy. Only use friends' first names from the list above.
For "nearby" and "new" ideas also give "public_title": the same idea with no person named and nothing about them (like "Jazz at Shea's Thursday") — it may be passed on to others.
Reply with JSON only: {"spells":[{"kind":"nearby","title":"…","public_title":"…","why":"…","link":"https://…"}, …]}`;

/** Imagine today's spells for one person (once a day). Returns how many were made. */
async function generate(user, { force = false, more = false } = {}) {
  const c = client();
  if (!c || !user) return 0;
  const last = db._raw().prepare('SELECT max(created_at) t FROM spells WHERE user_id = ?').get(user.id).t || 0;
  if (!force && now() - last < EVERY) return 0;
  const ctx = contextFor(user);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: user.timezone || 'America/Los_Angeles' });
  const messages = [{ role: 'user', content: PROMPT(user, ctx, today) }];
  const tools = user.city ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2, ...(user.timezone ? { user_location: { type: 'approximate', city: user.city, timezone: user.timezone } } : {}) }] : undefined;
  let text = '';
  for (let i = 0; i < 3; i++) {
    const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: 1200, messages, ...(tools ? { tools } : {}) });
    text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (r.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: r.content });
  }
  let list = [];
  try { list = JSON.parse(text.match(/\{[\s\S]*\}/)[0]).spells || []; } catch (_) { return 0; }
  // Never name someone on their avoid list, whatever the model wrote (checked in code).
  const avoidWords = ctx.avoidedNames.map((n) => String(n).split(/\s+/)[0].toLowerCase()).filter((w) => w.length > 1);
  const ok = (s) => !avoidWords.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(`${s.title} ${s.why}`));
  let made = 0;
  // Today's replace yesterday's untouched ones; "More ideas" adds to them. Passed-on ideas stay.
  if (!more) db._raw().prepare("DELETE FROM spells WHERE user_id = ? AND status = 'new' AND source = 'own'").run(user.id);
  const have = new Set(db._raw().prepare("SELECT lower(title) t FROM spells WHERE user_id = ? AND status = 'new'").all(user.id).map((r) => r.t));
  for (const s of list.filter((x) => x && KINDS.includes(x.kind) && clean(x.title)).filter(ok)) {
    if (made >= PER_BATCH) break;
    if (have.has(clean(s.title, 90).toLowerCase())) continue;
    const link = /^https?:\/\//.test(String(s.link || '')) ? String(s.link).slice(0, 400) : null;
    const pub = PUBLIC_KINDS.includes(s.kind) && clean(s.public_title) && ok({ title: s.public_title, why: '' }) ? clean(s.public_title, 90) : null;
    // Its public title matches another of today's ideas (not a passed-on one, which is merged below): a repeat.
    const repeat = pub && pub.toLowerCase() !== clean(s.title, 90).toLowerCase() && have.has(pub.toLowerCase());
    have.add(clean(s.title, 90).toLowerCase());
    if (repeat && !db._raw().prepare("SELECT 1 FROM spells WHERE user_id = ? AND status = 'new' AND source = 'echo' AND lower(title) = lower(?)").get(user.id, pub)) continue;
    const sid = uuidv4();
    db._raw().prepare('INSERT INTO spells (id, user_id, kind, title, why, link, expires_at, public_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sid, user.id, s.kind, clean(s.title, 90), clean(s.why, 200), link, now() + KEEP_DAYS * 86400, pub);
    // The same idea was passed on to them already: one card — theirs — carrying who-many liked it.
    const dup = pub && db._raw().prepare("SELECT id, echoes FROM spells WHERE user_id = ? AND status = 'new' AND source = 'echo' AND lower(title) = lower(?)").get(user.id, pub);
    if (dup) { db._raw().prepare('UPDATE spells SET echoes = ? WHERE id = ?').run(dup.echoes, sid); db._raw().prepare('DELETE FROM spells WHERE id = ?').run(dup.id); }
    made++;
  }
  return made;
}

/** Everyone who uses ButterflAI, a few per tick. */
async function tick({ limit = 5 } = {}) {
  if (!client()) return 0;
  const users = db._raw().prepare(`SELECT u.* FROM users u WHERE u.onboarding_state = 'complete'
    AND NOT EXISTS (SELECT 1 FROM spells s WHERE s.user_id = u.id AND s.created_at > ?) LIMIT ?`).all(now() - EVERY, limit);
  let n = 0;
  for (const u of users) { try { n += await generate(u); } catch (err) { console.warn('[spells] generate failed:', err.message); } }
  return n;
}

/** ✨ More ideas (🐛 #37): another batch on top of today's, up to MAX_PER_DAY. */
async function more(userId) {
  const user = db.getUser(userId);
  const made = db._raw().prepare("SELECT count(*) n FROM spells WHERE user_id = ? AND source = 'own' AND created_at > ?").get(userId, now() - EVERY).n;
  if (made >= MAX_PER_DAY) return { error: 'ENOUGH', message: 'That’s plenty of ideas for today — more tomorrow.' };
  const n = await generate(user, { force: true, more: true });
  return n ? { ok: true, made: n } : { error: 'NONE', message: 'Couldn’t imagine more right now — try again later.' };
}

// ── Passing ideas on (🐛 #37) ──
/** People associated with someone: friends (saved each other) and people they've made plans with. */
function associates(userId) {
  const me = db.getUser(userId);
  if (!me?.phone) return [];
  const ids = new Set();
  for (const r of db._raw().prepare(`SELECT u.id FROM contacts c JOIN users u ON u.phone = c.phone
    WHERE c.invited_by_user_id = ? AND EXISTS (SELECT 1 FROM contacts b WHERE b.invited_by_user_id = u.id AND b.phone = ?)`).all(userId, me.phone)) ids.add(r.id);
  const since = now() - 180 * 86400;
  const myPlans = db._raw().prepare(`SELECT se.id FROM social_events se LEFT JOIN event_invitations ei ON ei.event_id = se.id LEFT JOIN contacts c ON c.id = ei.contact_id
    WHERE se.created_at > ? AND (se.host_user_id = ? OR (c.phone = ? AND ei.status = 'accepted')) GROUP BY se.id`).all(since, userId, me.phone).map((r) => r.id);
  for (const id of myPlans) {
    const host = db._raw().prepare('SELECT host_user_id FROM social_events WHERE id = ?').get(id)?.host_user_id;
    if (host) ids.add(host);
    for (const r of db._raw().prepare(`SELECT u.id FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id JOIN users u ON u.phone = c.phone
      WHERE ei.event_id = ? AND ei.status = 'accepted'`).all(id)) ids.add(r.id);
  }
  ids.delete(userId);
  return [...ids].map((id) => db.getUser(id)).filter(Boolean);
}
const town = (u) => String(u?.city || '').trim().toLowerCase();
function sameTown(a, b) {
  if (town(a) && town(a) === town(b)) return true;
  if ([a?.lat, a?.lng, b?.lat, b?.lng].every((x) => Number.isFinite(Number(x)) && x !== null)) {
    const R = 6371, rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h)) <= 80;
  }
  return false;
}
function avoidsEither(a, b) {
  try {
    const avoid = require('./avoid');
    const list = (u) => avoid.listAvoid(u.id, { accessor: 'spells', context: 'passing an idea on (never shown)' });
    return !!(avoid.findByPhone(list(a), b.phone) || avoid.findByPhone(list(b), a.phone));
  } catch (_) { return true; }
}
/** Pass a liked public idea on to people around the person — never with their name. */
function echo(fromUserId, spell) {
  if (!PUBLIC_KINDS.includes(spell.kind) || !spell.public_title) return 0;
  const from = db.getUser(fromUserId);
  let sent = 0;
  for (const u of associates(fromUserId)) {
    if (!sameTown(from, u) || avoidsEither(from, u)) continue;
    const same = db._raw().prepare('SELECT id, status, source FROM spells WHERE user_id = ? AND (lower(title) = lower(?) OR lower(public_title) = lower(?))').get(u.id, spell.public_title, spell.public_title);
    if (same) {   // they have it already: one more person likes it (unless they dismissed or kept it)
      if (same.status === 'new') { db._raw().prepare('UPDATE spells SET echoes = echoes + 1 WHERE id = ?').run(same.id); sent++; }
      continue;
    }
    const today = db._raw().prepare("SELECT count(*) n FROM spells WHERE user_id = ? AND source = 'echo' AND created_at > ?").get(u.id, now() - 86400).n;
    if (today >= ECHOES_PER_DAY) continue;
    db._raw().prepare(`INSERT INTO spells (id, user_id, kind, title, why, link, expires_at, public_title, source, origin_id, echoes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'echo', ?, 1)`).run(uuidv4(), u.id, spell.kind, spell.public_title, 'People around you like this', spell.link, now() + KEEP_DAYS * 86400, spell.public_title, spell.id);
    sent++;
  }
  return sent;
}

const view = (s) => ({ id: s.id, kind: s.kind, title: s.title, why: s.why, link: s.link, status: s.status,
  passed_on: s.source === 'echo' || s.echoes > 0, liked_by: s.echoes || undefined, can_spread: !!s.public_title && PUBLIC_KINDS.includes(s.kind) });
function forUser(userId) {
  return db._raw().prepare("SELECT * FROM spells WHERE user_id = ? AND status = 'new' AND expires_at > ? ORDER BY CASE kind WHEN 'nearby' THEN 0 WHEN 'reconnect' THEN 1 WHEN 'wish' THEN 2 ELSE 3 END, echoes DESC, created_at DESC")
    .all(userId, now()).map(view);
}

/** ✨ Sounds nice → your wish (matching starts) · plan → the ＋ New plan text · dismiss → remembered. */
function answer(userId, id, ans) {
  const s = db._raw().prepare('SELECT * FROM spells WHERE id = ? AND user_id = ?').get(id, userId);
  if (!s) return { error: 'NOT_FOUND' };
  if (ans === 'wish') {
    const w = require('./wishes').add(userId, { text: s.title.replace(/\?$/, '') });
    db._raw().prepare("UPDATE spells SET status = 'kept' WHERE id = ?").run(id);
    // A liked public idea (yours or passed on to you) goes on to people around you, without your name.
    const pub = s.public_title ? s : null;
    const passed = pub ? echo(userId, pub) : 0;
    return { ok: true, wish: w.wish, passed_on: passed };
  }
  if (ans === 'plan') {
    db._raw().prepare("UPDATE spells SET status = 'planned' WHERE id = ?").run(id);
    return { ok: true, text: `${s.title.replace(/\?$/, '')}${s.why ? ` — ${s.why}` : ''}${s.link ? ` (${s.link})` : ''}` };
  }
  if (ans === 'dismiss') { db._raw().prepare("UPDATE spells SET status = 'dismissed' WHERE id = ?").run(id); return { ok: true }; }
  return { error: 'BAD_ANSWER' };
}

/** Kept 7 days; dismissed titles kept 60 days (so similar ones stop), then gone. */
function purgeOld() {
  return db._raw().prepare("DELETE FROM spells WHERE (status != 'dismissed' AND expires_at < ?) OR (status = 'dismissed' AND created_at < ?)").run(now(), now() - 60 * 86400).changes;
}

/** A public idea from someone in your town, seen in your ✨ Feed: becomes yours (passed on) so you can answer it. */
function adopt(userId, originId) {
  const o = db._raw().prepare('SELECT * FROM spells WHERE id = ?').get(originId);
  const me = db.getUser(userId), from = o && db.getUser(o.user_id);
  if (!o || !me || !from || o.user_id === userId || !PUBLIC_KINDS.includes(o.kind) || !o.public_title || o.status === 'dismissed') return null;
  if (!sameTown(me, from) || avoidsEither(me, from)) return null;
  const have = db._raw().prepare('SELECT id FROM spells WHERE user_id = ? AND (lower(title) = lower(?) OR lower(public_title) = lower(?))').get(userId, o.public_title, o.public_title);
  if (have) return have.id;
  const likes = db._raw().prepare("SELECT count(DISTINCT user_id) n FROM spells WHERE lower(public_title) = lower(?) AND status = 'kept'").get(o.public_title).n;
  const id = uuidv4();
  db._raw().prepare(`INSERT INTO spells (id, user_id, kind, title, why, link, expires_at, public_title, source, origin_id, echoes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'echo', ?, ?)`).run(id, userId, o.kind, o.public_title, 'Found around you', o.link, now() + KEEP_DAYS * 86400, o.public_title, o.id, likes);
  return id;
}

module.exports = { generate, more, tick, forUser, answer, adopt, purgeOld, contextFor, associates, echo, sameTown, avoidsEither, KINDS, PUBLIC_KINDS, MAX_PER_DAY, _setClient };
