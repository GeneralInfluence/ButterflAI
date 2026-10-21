/**
 * spells.js — ButterflAI imagines what's possible for you (owner, 2026-10-20, 🐛 #36: "imagine
 * what's possible. Based on text that the person has had in the past … you could be doing this, you
 * could be going there … ways in which somebody could be expanding their social network … butterfly
 * ends up making things happen by constantly casting spells … putting ideas in people's heads").
 *
 * Once a day per person (coord loop), a short model call — with web search for what's on near them —
 * imagines a few ideas ("spells"): something happening nearby, reconnecting with a friend they
 * haven't seen in a while, something new that widens their circle, something from their wishes.
 * Each can become a wish (✨ Sounds fun — then mutual-wish matching starts, wishes.js), a plan (＋),
 * or be dismissed (remembered, so similar ones stop).
 *
 * Privacy (PRIVACY.md "Spells"): built ONLY from the person's own conversation, plans and wishes, and
 * public web results — never other people's chats. Friends named are the person's own contacts from
 * their own plans, never anyone on their avoid list (checked in code). Private-mode messages are never
 * read. Kept 7 days.
 *
 * 🐛 #37 — passing ideas on: ✨ Sounds fun on a public idea (something on nearby, something new) also
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
const MAX_PER_DAY = 80;                    // the daily batch + more as the 🧭 Explore is scrolled (10 batches)
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
  // Open Creating items in their plans, and who's on them — doing one together can be its own fun (🐛 #44).
  const todos = db._raw().prepare(`SELECT t.id, t.text, se.title AS plan FROM event_todos t JOIN social_events se ON se.id = t.event_id
    WHERE t.done_at IS NULL AND t.suggested = 0 AND COALESCE(se.status, 'open') != 'cancelled' AND (se.host_user_id = ? OR EXISTS (
      SELECT 1 FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = se.id AND c.phone = ? AND ei.status = 'accepted'))
    ORDER BY t.created_at DESC LIMIT 8`).all(user.id, user.phone || '')
    .map((t) => ({ text: t.text, plan: t.plan, with: require('./todos').team(t.id).filter((m) => m.phone !== user.phone).map((m) => String(m.name).split(' ')[0])
      .filter((n) => !(avoided || []).some((a) => String(a.name || '').split(' ')[0] === n)) }));
  // What they said about ideas after looking at them (🐛 #42) — their own taste, in their own words.
  const notes = db._raw().prepare("SELECT title, note, status FROM spells WHERE user_id = ? AND note IS NOT NULL ORDER BY created_at DESC LIMIT 12").all(user.id)
    .map((r) => `"${r.title}"${r.status === 'kept' ? ' (into it)' : r.status === 'dismissed' ? ' (not for them)' : ''}: ${clean(r.note, 160)}`);
  const asks = db._raw().prepare('SELECT text FROM explore_asks WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 8').all(user.id, t - 14 * 86400).map((r) => clean(r.text, 160));
  return { plans, friends, said, wishes, dismissed, current, around, todos, notes, asks, avoidedNames: (avoided || []).map((a) => a.name).filter(Boolean) };
}

const PROMPT = (user, c, today) => `You are ButterflAI, imagining what could be fun for ${String(user.name || 'this person').split(' ')[0]} — gentle ideas ("spells") that might make good things happen with the people in their life and widen their circle. Today is ${today}${user.city ? `; they live in ${user.city}` : ''}.

What you know (their own):
- Recent plans: ${c.plans.map((p) => p.title).join('; ') || 'none'}
- Friends they make plans with (and when they last did): ${c.friends.map((f) => `${String(f.name).split(' ')[0]}${f.last ? ` (${new Date(f.last * 1000).toISOString().slice(0, 10)})` : ''}`).join(', ') || 'none yet'}
- Their wishes: ${c.wishes.join('; ') || 'none yet'}
- Things they said lately: ${c.said.slice(0, 15).map((s) => `"${s}"`).join(' ') || 'nothing'}
- Not into (dismissed before — don't suggest anything like these): ${c.dismissed.join('; ') || 'nothing yet'}
- Things they're making happen in their plans (and who's on them): ${(c.todos || []).map((t) => `${t.text} (${t.plan}${t.with.length ? `, with ${t.with.join(' & ')}` : ''})`).join('; ') || 'none'}
- What they've asked Explore for lately (searches and steering — follow it): ${(c.asks || []).map((a) => `"${a}"`).join('; ') || 'nothing yet'}
- What they said about ideas they looked at (their taste — follow it): ${(c.notes || []).join('; ') || 'nothing yet'}
- Ideas they already have (don't repeat): ${(c.current || []).join('; ') || 'none'}
- Liked lately by people around them (anonymous — a hint at what's good nearby): ${(c.around || []).join('; ') || 'nothing yet'}

${user.city ? `Search the web once or twice for what's actually on in or near ${user.city} in the next two weeks (shows, music, markets, classes, outdoor things) and use real ones.` : ''}
${c.focus ? `They just asked Explore for: "${c.focus}". If that's a search, imagine 8 ideas that answer it (any kinds that fit, real things first); if it's feedback about their ideas ("more outdoors", "less concerts"), follow it and imagine 8 that fit it. Kinds:` : 'Imagine 8 ideas, two of each kind:'}
- "nearby": something real happening near them soon (name, day, place; include the link).
- "reconnect": doing something with a friend they haven't seen in a while (only friends listed above) — or making one of the things they're making happen into time together: figuring it out over a drink, a coffee or a quick call with the people on it ("Plan the massages over a drink with Melanie?").
- "new": something that widens their circle — a class, a group, a meetup, a new scene.
- "wish": a way one of their wishes could happen (or, with no wishes, something they'd likely love from what they said).
Every idea is something fun to do — never an errand, a chore or a reminder ("Confirm Zack's name with Liam" is not an idea).
Each: a short, inviting title (under 70 characters, like "Jazz at Shea's Thursday with Allie?") and one line why. Warm, specific, never pushy. Only use friends' first names from the list above.
For "nearby" and "new" ideas also give "public_title": the same idea with no person named and nothing about them (like "Jazz at Shea's Thursday") — it may be passed on to others.
Facts must come from your search results: "link" only to a page you actually found (the event's own page if you found it), "date" (YYYY-MM-DD) when it's on a day, "place" — the venue's real name as it appears on a map ("Cargo Concert Hall", never "a cozy spot") — and "address" (its street address) when you found it. Today is ${today}; get weekdays right. Never two ideas about the same event.
Reply with JSON only: {"spells":[{"kind":"nearby","title":"…","public_title":"…","why":"…","link":"https://…","date":"YYYY-MM-DD","place":"…","address":"…"}, …]}`;

/** Imagine today's spells for one person (once a day). Returns how many were made. */
async function generate(user, { force = false, more = false, focus = null } = {}) {
  const c = client();
  if (!c || !user) return 0;
  const last = db._raw().prepare('SELECT max(created_at) t FROM spells WHERE user_id = ?').get(user.id).t || 0;
  if (!force && now() - last < EVERY) return 0;
  const ctx = { ...contextFor(user), focus: focus ? clean(focus, 200) : null };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: user.timezone || 'America/Los_Angeles' });
  const messages = [{ role: 'user', content: PROMPT(user, ctx, today) }];
  const tools = user.city ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2, ...(user.timezone ? { user_location: { type: 'approximate', city: user.city, timezone: user.timezone } } : {}) }] : undefined;
  let text = '';
  const found = new Set();   // the sites the web search actually returned (🐛 #41)
  for (let i = 0; i < 3; i++) {
    const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: 1200, messages, ...(tools ? { tools } : {}) });
    for (const b of r.content || []) if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const x of b.content) { const h = host(x.url); if (h) found.add(h); }
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
  // Ideas already around (new, or answered this week): a near-repeat in other words is skipped.
  // (Passed-on ideas aren't here: one matching yours is merged into it below.)
  const recent = db._raw().prepare("SELECT title FROM spells WHERE user_id = ? AND source = 'own' AND (status = 'new' OR created_at > ?)").all(user.id, now() - 7 * 86400).map((r) => words(r.title));
  for (const s of list.filter((x) => x && KINDS.includes(x.kind) && clean(x.title)).filter(ok)) {
    if (made >= PER_BATCH) break;
    if (have.has(clean(s.title, 90).toLowerCase())) continue;
    if (recent.some((w) => alike(w, words(s.title)))) continue;
    // A link only to a site the search actually returned; never plain http (🐛 #41).
    let link = /^https:\/\//.test(String(s.link || '')) ? String(s.link).slice(0, 400) : null;
    if (link && !found.has(host(link))) link = null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(s.date || '')) && !Number.isNaN(Date.parse(s.date)) ? s.date : null;
    if (date && date < today) continue;   // already over
    if (date) { s.title = fixWeekdays(s.title, date); s.why = fixWeekdays(s.why, date); if (s.public_title) s.public_title = fixWeekdays(s.public_title, date); }
    const place = clean(s.place, 80) || null;
    const address = clean(s.address, 160) || null;
    const pub = PUBLIC_KINDS.includes(s.kind) && clean(s.public_title) && ok({ title: s.public_title, why: '' }) ? clean(s.public_title, 90) : null;
    // Its public title matches another of today's ideas (not a passed-on one, which is merged below): a repeat.
    const repeat = pub && pub.toLowerCase() !== clean(s.title, 90).toLowerCase() && have.has(pub.toLowerCase());
    have.add(clean(s.title, 90).toLowerCase());
    if (repeat && !db._raw().prepare("SELECT 1 FROM spells WHERE user_id = ? AND status = 'new' AND source = 'echo' AND lower(title) = lower(?)").get(user.id, pub)) continue;
    const sid = uuidv4();
    db._raw().prepare('INSERT INTO spells (id, user_id, kind, title, why, link, expires_at, public_title, date, place, address, asked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sid, user.id, s.kind, clean(s.title, 90), clean(s.why, 200), link, now() + KEEP_DAYS * 86400, pub, date, place, address, focus ? clean(focus, 120) : null);
    recent.push(words(s.title));
    // The same idea was passed on to them already: one card — theirs — carrying who-many liked it.
    const dup = pub && db._raw().prepare("SELECT id, echoes FROM spells WHERE user_id = ? AND status = 'new' AND source = 'echo' AND lower(title) = lower(?)").get(user.id, pub);
    if (dup) { db._raw().prepare('UPDATE spells SET echoes = ? WHERE id = ?').run(dup.echoes, sid); db._raw().prepare('DELETE FROM spells WHERE id = ?').run(dup.id); }
    made++;
  }
  if (made) fillImages().catch(() => {});   // pictures for the new ideas, in the background
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
async function more(userId, { focus = null } = {}) {
  const user = db.getUser(userId);
  const made = db._raw().prepare("SELECT count(*) n FROM spells WHERE user_id = ? AND source = 'own' AND created_at > ?").get(userId, now() - EVERY).n;
  if (made >= MAX_PER_DAY) return { error: 'ENOUGH', message: 'That’s plenty of ideas for today — more tomorrow.' };
  const n = await generate(user, { force: true, more: true, focus });
  return n ? { ok: true, made: n } : { error: 'NONE', message: 'Couldn’t imagine more right now — try again later.' };
}

/**
 * 🔎 Ask Explore (🐛 #50): a search ("live music this weekend") or steering ("more outdoors, fewer concerts").
 * Kept (14 days) so it keeps shaping ideas; answered now with a batch made for it.
 */
async function ask(userId, text) {
  const t = clean(text, 200);
  if (!t) return { error: 'EMPTY' };
  db._raw().prepare('INSERT INTO explore_asks (id, user_id, text) VALUES (?, ?, ?)').run(uuidv4(), userId, t);
  const before = now() - 1;
  const r = await more(userId, { focus: t });
  const items = db._raw().prepare("SELECT * FROM spells WHERE user_id = ? AND status = 'new' AND source = 'own' AND asked = ? AND created_at >= ? ORDER BY created_at").all(userId, t, before).map(view);
  return { ok: !r.error || items.length > 0, asked: t, items, ...(r.error && !items.length ? { error: r.error, message: r.message } : {}) };
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
    const o = db._raw().prepare('SELECT * FROM spells WHERE id = ?').get(spell.id) || {};
    db._raw().prepare(`INSERT INTO spells (id, user_id, kind, title, why, link, expires_at, public_title, source, origin_id, echoes, image, image_checked, link_ok, date, place, lat, lng, geo_checked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'echo', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuidv4(), u.id, spell.kind, spell.public_title, 'People around you like this', spell.link, now() + KEEP_DAYS * 86400, spell.public_title, spell.id,
      o.image || null, o.image_checked || 0, o.link_ok ?? null, o.date || null, o.place || null, o.lat ?? null, o.lng ?? null, o.geo_checked || 0);
    sent++;
  }
  return sent;
}

// A link is shown only once it's been checked to open securely (🐛 #41).
const view = (s) => ({ id: s.id, kind: s.kind, title: s.title, why: s.why, status: s.status,
  image: s.image || null, link: s.link_ok === 1 ? s.link : null, link_ok: s.link_ok, source_site: s.link ? host(s.link) : null,
  date: s.date || null, place: s.place || null, lat: s.lat ?? null, lng: s.lng ?? null, passed_on: s.source === 'echo' || s.echoes > 0, liked_by: s.echoes || undefined, can_spread: !!s.public_title && PUBLIC_KINDS.includes(s.kind) });
function forUser(userId) {
  return db._raw().prepare("SELECT * FROM spells WHERE user_id = ? AND status = 'new' AND expires_at > ? ORDER BY CASE kind WHEN 'nearby' THEN 0 WHEN 'reconnect' THEN 1 WHEN 'wish' THEN 2 ELSE 3 END, echoes DESC, created_at DESC")
    .all(userId, now()).map(view);
}

/** ✨ Sounds fun → your wish (matching starts) · plan → the ＋ New plan text · dismiss → remembered. */
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

/**
 * An idea's page, opened inside ButterflAI with a comment bar (Sean, 2026-10-20: commenting while
 * looking). Yours, or one found around you (same town, public — as Explore shows it).
 */
function page(userId, id) {
  let s = null;
  if (String(id).startsWith('pool:')) {
    const o = db._raw().prepare('SELECT * FROM spells WHERE id = ?').get(String(id).slice(5));
    const me = db.getUser(userId), from = o && db.getUser(o.user_id);
    if (o && from && o.user_id !== userId && PUBLIC_KINDS.includes(o.kind) && o.public_title && sameTown(me, from) && !avoidsEither(me, from)) s = { ...o, title: o.public_title, why: null };
  } else s = db._raw().prepare('SELECT * FROM spells WHERE id = ? AND user_id = ?').get(id, userId);
  if (!s || !s.link || s.link_ok !== 1) return null;
  return { id: String(id), title: s.title, why: s.why, link: s.link, site: host(s.link), image: s.image || null, frameable: s.frameable === 1,
    description: s.page_desc || null, date: s.date || null, place: s.place || null, status: s.status, note: s.user_id === userId ? s.note : null };
}

/**
 * After looking at an idea's page (🐛 #42): into it (kept as a wish and passed on, like ✨ Sounds fun),
 * meh, or not for me (hidden, and similar ideas stop) — plus anything they want to say about it, which
 * stays theirs and shapes what ButterflAI imagines for them next. The note never reaches anyone else.
 */
function react(userId, id, { verdict, note } = {}) {
  const s = db._raw().prepare('SELECT * FROM spells WHERE id = ? AND user_id = ?').get(id, userId);
  if (!s) return { error: 'NOT_FOUND' };
  if (!['into', 'meh', 'no'].includes(verdict) && !String(note || '').trim()) return { error: 'EMPTY' };
  const text = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
  // Several comments while looking at one page add up (newest last).
  if (text) db._raw().prepare('UPDATE spells SET note = ? WHERE id = ?').run((s.note ? `${s.note} · ${text}` : text).slice(-500), id);
  let out = { ok: true };
  if (verdict === 'into' && s.status === 'new') out = { ...answer(userId, id, 'wish'), noted: !!text };
  else if (verdict === 'no' && s.status === 'new') out = { ...answer(userId, id, 'dismiss'), noted: !!text };
  else out.noted = !!text;
  return out;
}

/** Kept 7 days; dismissed titles kept 60 days (so similar ones stop), then gone. */
function purgeOld() {
  return db._raw().prepare("DELETE FROM spells WHERE (status != 'dismissed' AND expires_at < ?) OR (status = 'dismissed' AND created_at < ?)").run(now(), now() - 60 * 86400).changes;
}

/** For ideas with a link: does it open securely (🐛 #41), and its share picture (🐛 #39) — once per link.
 *  For ideas at a place: where it is, for the map (🐛 #43). */
// One run at a time: a call while one is running waits for it, then runs (nothing is skipped).
// (At most one waiting: scrolling Explore asks often, and the next run covers everything anyway.)
let _filling = Promise.resolve(), _waiting = null;
function fillImages(opts) {
  if (_waiting) return _waiting;
  const run = _filling.then(() => { _waiting = null; return fillOnce(opts); });
  _waiting = run;
  _filling = run.catch(() => 0);
  return run;
}
async function fillOnce({ limit = 12 } = {}) {
  let n = 0;
  try {
    const rows = db._raw().prepare(`SELECT id, link FROM spells WHERE link IS NOT NULL AND image_checked = 0 AND status IN ('new', 'kept')
      ORDER BY created_at DESC LIMIT ?`).all(limit);
    for (const r of rows) {
      const known = db._raw().prepare('SELECT image, link_ok, frameable, page_desc FROM spells WHERE link = ? AND image_checked = 1 LIMIT 1').get(r.link);
      const c = known ? { ok: known.link_ok === 1, image: known.image, frameable: known.frameable === 1, desc: known.page_desc } : await require('./ogimage').check(r.link);
      if (!c) continue;   // couldn't check (offline) — try later
      db._raw().prepare('UPDATE spells SET image = ?, link_ok = ?, frameable = ?, page_desc = ?, image_checked = 1 WHERE link = ? AND image_checked = 0')
        .run(c.image, c.ok ? 1 : 0, c.ok ? (c.frameable ? 1 : 0) : null, c.desc || null, r.link);
      if (c.image) n++;
    }
    const places = db._raw().prepare(`SELECT s.id, s.place, s.address, u.city, u.lat ulat, u.lng ulng FROM spells s JOIN users u ON u.id = s.user_id
      WHERE (s.place IS NOT NULL OR s.address IS NOT NULL) AND s.geo_checked = 0 AND s.status IN ('new', 'kept') ORDER BY s.created_at DESC LIMIT ?`).all(limit);
    for (const p of places) {
      const known = p.place && db._raw().prepare('SELECT lat, lng FROM spells WHERE lower(place) = lower(?) AND geo_checked = 1 AND lat IS NOT NULL LIMIT 1').get(p.place);
      const near = Number.isFinite(p.ulat) && Number.isFinite(p.ulng) ? { lat: p.ulat, lng: p.ulng } : null;
      const g = known || await require('./geocode').find(p.place, p.city, { address: p.address, near });
      db._raw().prepare('UPDATE spells SET lat = ?, lng = ?, geo_checked = 1 WHERE id = ?').run(g?.lat ?? null, g?.lng ?? null, p.id);
    }
  } catch (err) { console.warn('[spells] images:', err.message); }
  return n;
}

// ── Keeping ideas true (🐛 #41) ──
function host(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return null; } }
const STOP = new Set('a an the at in on with and or for to of your you this that night day week weekend tonight today tomorrow monday tuesday wednesday thursday friday saturday sunday mon tue wed thu fri sat sun jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december'.split(' '));
function words(t) { return new Set(String(t || '').toLowerCase().replace(/[^a-z0-9\s&]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w) && !/^\d+(st|nd|rd|th)?$/.test(w))); }
function alike(a, b) {
  if (!a.size || !b.size) return false;
  let both = 0; for (const w of a) if (b.has(w)) both++;
  return both / Math.min(a.size, b.size) >= 0.75 && both >= 2;
}
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
/** "Friday" in an idea for Sat Oct 24 → "Saturday" (the model gets weekdays wrong). */
function fixWeekdays(text, date) {
  if (!text) return text;
  const real = DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
  return String(text).replace(/\b(sun|mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?)(day)?\b/gi, (m) => {
    const full = m.length > 4 || /day$/i.test(m);
    let r = full ? real : real.slice(0, 3);
    if (m[0] === m[0].toUpperCase()) r = r[0].toUpperCase() + r.slice(1);
    return r;
  });
}

/** A public idea from someone in your town, seen in your 🧭 Explore: becomes yours (passed on) so you can answer it. */
function adopt(userId, originId) {
  const o = db._raw().prepare('SELECT * FROM spells WHERE id = ?').get(originId);
  const me = db.getUser(userId), from = o && db.getUser(o.user_id);
  if (!o || !me || !from || o.user_id === userId || !PUBLIC_KINDS.includes(o.kind) || !o.public_title || o.status === 'dismissed') return null;
  if (!sameTown(me, from) || avoidsEither(me, from)) return null;
  const have = db._raw().prepare('SELECT id FROM spells WHERE user_id = ? AND (lower(title) = lower(?) OR lower(public_title) = lower(?))').get(userId, o.public_title, o.public_title);
  if (have) return have.id;
  const likes = db._raw().prepare("SELECT count(DISTINCT user_id) n FROM spells WHERE lower(public_title) = lower(?) AND status = 'kept'").get(o.public_title).n;
  const id = uuidv4();
  db._raw().prepare(`INSERT INTO spells (id, user_id, kind, title, why, link, expires_at, public_title, source, origin_id, echoes, image, image_checked, link_ok, date, place, lat, lng, geo_checked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'echo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, o.kind, o.public_title, 'Found around you', o.link, now() + KEEP_DAYS * 86400, o.public_title, o.id, likes, o.image, o.image_checked, o.link_ok, o.date, o.place, o.lat, o.lng, o.geo_checked);
  return id;
}

module.exports = { generate, more, ask, tick, forUser, answer, react, page, adopt, fillImages, fixWeekdays, alike, words, host, purgeOld, contextFor, associates, echo, sameTown, avoidsEither, KINDS, PUBLIC_KINDS, MAX_PER_DAY, _setClient };
