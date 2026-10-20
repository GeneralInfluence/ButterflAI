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
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { createAnthropicClient, DEFAULT_MODEL } = require('./anthropic-client');

const KEEP_DAYS = 7;
const EVERY = 20 * 3600;
const KINDS = ['nearby', 'reconnect', 'new', 'wish'];
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
  return { plans, friends, said, wishes, dismissed, avoidedNames: (avoided || []).map((a) => a.name).filter(Boolean) };
}

const PROMPT = (user, c, today) => `You are ButterflAI, imagining what could be fun for ${String(user.name || 'this person').split(' ')[0]} — gentle ideas ("spells") that might make good things happen with the people in their life and widen their circle. Today is ${today}${user.city ? `; they live in ${user.city}` : ''}.

What you know (their own):
- Recent plans: ${c.plans.map((p) => p.title).join('; ') || 'none'}
- Friends they make plans with (and when they last did): ${c.friends.map((f) => `${String(f.name).split(' ')[0]}${f.last ? ` (${new Date(f.last * 1000).toISOString().slice(0, 10)})` : ''}`).join(', ') || 'none yet'}
- Their wishes: ${c.wishes.join('; ') || 'none yet'}
- Things they said lately: ${c.said.slice(0, 15).map((s) => `"${s}"`).join(' ') || 'nothing'}
- Not into (dismissed before — don't suggest anything like these): ${c.dismissed.join('; ') || 'nothing yet'}

${user.city ? `Search the web once or twice for what's actually on in or near ${user.city} in the next two weeks (shows, music, markets, classes, outdoor things) and use real ones.` : ''}
Imagine 4 ideas, one of each kind:
- "nearby": something real happening near them soon (name, day, place; include the link).
- "reconnect": doing something with a friend they haven't seen in a while (only friends listed above).
- "new": something that widens their circle — a class, a group, a meetup, a new scene.
- "wish": a way one of their wishes could happen (or, with no wishes, something they'd likely love from what they said).
Each: a short, inviting title (under 70 characters, like "Jazz at Shea's Thursday with Allie?") and one line why. Warm, specific, never pushy. Only use friends' first names from the list above.
Reply with JSON only: {"spells":[{"kind":"nearby","title":"…","why":"…","link":"https://…"}, …]}`;

/** Imagine today's spells for one person (once a day). Returns how many were made. */
async function generate(user, { force = false } = {}) {
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
  db._raw().prepare("DELETE FROM spells WHERE user_id = ? AND status = 'new'").run(user.id);   // today's replace yesterday's untouched ones
  for (const s of list.filter((x) => x && KINDS.includes(x.kind) && clean(x.title)).filter(ok).slice(0, 4)) {
    const link = /^https?:\/\//.test(String(s.link || '')) ? String(s.link).slice(0, 400) : null;
    db._raw().prepare('INSERT INTO spells (id, user_id, kind, title, why, link, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), user.id, s.kind, clean(s.title, 90), clean(s.why, 200), link, now() + KEEP_DAYS * 86400);
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

const view = (s) => ({ id: s.id, kind: s.kind, title: s.title, why: s.why, link: s.link, status: s.status });
function forUser(userId) {
  return db._raw().prepare("SELECT * FROM spells WHERE user_id = ? AND status = 'new' AND expires_at > ? ORDER BY CASE kind WHEN 'nearby' THEN 0 WHEN 'reconnect' THEN 1 WHEN 'wish' THEN 2 ELSE 3 END")
    .all(userId, now()).map(view);
}

/** ✨ Sounds nice → your wish (matching starts) · plan → the ＋ New plan text · dismiss → remembered. */
function answer(userId, id, ans) {
  const s = db._raw().prepare('SELECT * FROM spells WHERE id = ? AND user_id = ?').get(id, userId);
  if (!s) return { error: 'NOT_FOUND' };
  if (ans === 'wish') {
    const w = require('./wishes').add(userId, { text: s.title.replace(/\?$/, '') });
    db._raw().prepare("UPDATE spells SET status = 'kept' WHERE id = ?").run(id);
    return { ok: true, wish: w.wish };
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

module.exports = { generate, tick, forUser, answer, purgeOld, contextFor, KINDS, _setClient };
