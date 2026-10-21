/**
 * ideafeed.js — the 🧭 Explore tab (owner, 2026-10-20: "these suggestions should become a feed, a social
 * feed, and should have their own tab along the bottom … a never-ending feed that is constantly being
 * populated with stuff that Butterfly has found in their area or other people are up to, and is
 * constantly updated by the other people's inputs").
 *
 * One ranked list, read a page at a time (the page sends what it has already shown):
 *  1. Right now (first page only): friends who are out near you (named), how many people around you
 *     are out and for what (counts only — people you could already see in I'm out), friends' shares
 *     ("Free tonight"), and public plans in your town.
 *  2. Your ideas (spells.js): what ButterflAI imagined for you and what was passed on to you.
 *  3. Around you: public ideas ButterflAI found for other people in your town (titles only — no one
 *     named), most-liked first. Answering one makes it yours (spells.adopt).
 * When it runs out the page asks for more (spells.more — a new batch with a web search), up to a
 * daily limit; everyone's ideas and likes keep the "around you" part changing.
 */
'use strict';

const db = require('./db');
const spells = require('./spells');

const PAGE = 10;
const POOL_DAYS = 14;
const now = () => Math.floor(Date.now() / 1000);

/** Public ideas from other people in your town, one per idea, most liked first. */
function pool(user, have) {
  const rows = db._raw().prepare(`SELECT s.* FROM spells s WHERE s.user_id != ? AND s.public_title IS NOT NULL AND s.kind IN ('nearby', 'new') AND s.link IS NOT NULL AND COALESCE(s.link_ok, 1) = 1
    AND s.status != 'dismissed' AND s.created_at > ? ORDER BY s.created_at DESC LIMIT 600`).all(user.id, now() - POOL_DAYS * 86400);
  const ok = new Map();
  const byTitle = new Map();
  for (const r of rows) {
    const key = r.public_title.toLowerCase();
    if (have.has(key)) continue;
    if (!ok.has(r.user_id)) { const u = db.getUser(r.user_id); ok.set(r.user_id, !!u && spells.sameTown(user, u) && !spells.avoidsEither(user, u)); }
    if (!ok.get(r.user_id)) continue;
    const g = byTitle.get(key) || { row: r, likes: new Set(), seen: 0 };
    if (r.status === 'kept') g.likes.add(r.user_id);
    g.seen++;
    byTitle.set(key, g);
  }
  return [...byTitle.values()].sort((a, b) => b.likes.size - a.likes.size || b.row.created_at - a.row.created_at)
    .map((g) => ({ type: 'idea', id: `pool:${g.row.id}`, kind: g.row.kind, title: g.row.public_title, link: g.row.link_ok === 1 ? g.row.link : null, image: g.row.image || null,
      source_site: g.row.link ? spells.host(g.row.link) : null, date: g.row.date || null, place: g.row.place || null, lat: g.row.lat ?? null, lng: g.row.lng ?? null,
      why: 'Found around you', liked_by: g.likes.size || undefined, around: true }));
}

/**
 * One card per event (Sean, 2026-10-21: "You're suggesting the same things over and over through different links"):
 * your ideas, ideas passed on to you and ideas from around town are merged — the same title in other words, the same
 * page, or the same place on the same day is one card (the first one, which is yours when you have it).
 */
function onePerEvent(items) {
  const kept = [];
  for (const i of items) {
    if (i.type !== 'idea') { kept.push(i); continue; }
    const w = spells.words(i.title);
    const dup = kept.some((k) => k.type === 'idea' && (spells.alike(w, spells.words(k.title))
      || (i.link && k.link && i.link === k.link && (i.date || '') === (k.date || ''))
      || (i.date && i.place && k.date === i.date && k.place && k.place.toLowerCase() === i.place.toLowerCase())));
    if (!dup) kept.push(i);
  }
  return kept;
}

/** What's happening right now (first page). */
function rightNow(user) {
  const out = [];
  try {
    const out_ = require('./outnow');
    const v = out_.nearby(user.id);
    for (const f of v.friends) out.push({ type: 'friend_out', id: `out:${f.id}`, title: `${f.name} is out · ${f.distance}`, sub: `Up for ${f.up_for}` });
    if ((v.around || []).length) out.push({ type: 'around', id: 'around', title: 'Out around you right now', chips: v.around.map((a) => `${a.label}${a.count > 1 ? ` · ${a.count}` : ''}`) });
    if (!v.me) out.push({ type: 'go_out', id: 'go_out', title: 'Out and about?', sub: 'Say what you’re up for and see who’s nearby' });
  } catch (_) {}
  try {
    const feeling = require('./feeling');
    for (const p of feeling.plansVisibleTo(user).slice(0, 5)) {
      out.push({ type: 'share', id: `share:${p.id}`, title: `${require('./people').nameFor(user.id, p.user_id, { first: true })}: ${p.text}`, sub: 'Shared with you' });
    }
  } catch (_) {}
  // Plans you made from Explore lately (🐛 #53) — on top, so the feed remembers what you did with it.
  for (const r of db._raw().prepare(`SELECT s.title AS idea, se.id, se.title FROM spells s JOIN social_events se ON se.id = s.event_id
    WHERE s.user_id = ? AND COALESCE(se.status, 'open') != 'cancelled' AND s.created_at > ? ORDER BY s.created_at DESC LIMIT 5`).all(user.id, now() - 14 * 86400)) {
    out.push({ type: 'my_plan', id: `myplan:${r.id}`, title: r.title, sub: `Your plan from the idea “${r.idea}”`, url: `/app/chat?event=${r.id}` });
  }
  // Public plans hosted by people in your town (open to anyone).
  const pub = db._raw().prepare(`SELECT se.id, se.title, se.scheduled_at, se.host_user_id FROM social_events se
    WHERE se.event_type = 'public' AND COALESCE(se.status, 'open') != 'cancelled' AND se.scheduled_at > ? AND se.scheduled_at < ? AND se.host_user_id != ?
    ORDER BY se.scheduled_at LIMIT 20`).all(now(), now() + 30 * 86400, user.id);
  for (const e of pub) {
    const h = db.getUser(e.host_user_id);
    if (!h || !spells.sameTown(user, h) || spells.avoidsEither(user, h)) continue;
    out.push({ type: 'public_plan', id: `event:${e.id}`, title: e.title, sub: new Date(e.scheduled_at * 1000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: user.timezone || 'America/Los_Angeles' }), url: `/event/${e.id}` });
  }
  return out;
}

/** One page of the feed, leaving out what the page already showed. */
function page(userId, { seen = [] } = {}) {
  const user = db.getUser(userId);
  if (!user) return { items: [], done: true };
  const shown = new Set((Array.isArray(seen) ? seen : []).slice(0, 2000).map(String));
  const mine = spells.forUser(userId).filter((s) => !s.asked).map((s) => ({ type: 'idea', ...s }));   // a search's ideas sit under it
  const have = new Set(db._raw().prepare('SELECT lower(title) t, lower(public_title) p FROM spells WHERE user_id = ?').all(userId).flatMap((r) => [r.t, r.p]).filter(Boolean));
  const all = [...(shown.size ? [] : rightNow(user)), ...onePerEvent([...mine, ...pool(user, have)])].filter((i) => !shown.has(i.id));
  const items = all.slice(0, PAGE);
  // Pictures still to look up get looked up now, for the next scroll (in the background).
  if (items.some((i) => i.type === 'idea' && ((i.source_site && !i.link && !i.image) || (i.place && i.lat == null)))) spells.fillImages().catch(() => {});
  const madeToday = db._raw().prepare("SELECT count(*) n FROM spells WHERE user_id = ? AND source = 'own' AND created_at > ?").get(userId, now() - 20 * 3600).n;
  return { items, done: all.length <= PAGE, can_imagine_more: madeToday < spells.MAX_PER_DAY };
}

/** Everything on Explore that has a place on the map (🐛 #43): your ideas and those found around you. */
function map(userId) {
  const user = db.getUser(userId);
  if (!user) return { pins: [] };
  const mine = spells.forUser(userId).map((s) => ({ type: 'idea', ...s }));
  const have = new Set(db._raw().prepare('SELECT lower(title) t, lower(public_title) p FROM spells WHERE user_id = ?').all(userId).flatMap((r) => [r.t, r.p]).filter(Boolean));
  const all = [...mine, ...pool(user, have)];
  const pins = all.filter((i) => Number.isFinite(i.lat) && Number.isFinite(i.lng))
    .map(({ id, kind, title, date, place, lat, lng, link, image, liked_by, why }) => ({ id, kind, title, date, place, lat, lng, link, image, liked_by, why }));
  const me = Number.isFinite(user.lat) && Number.isFinite(user.lng) ? { lat: user.lat, lng: user.lng } : null;
  return { pins, me, unplaced: all.length - pins.length, today: new Date().toLocaleDateString('en-CA', { timeZone: user.timezone || 'America/Los_Angeles' }) };
}

/** The posts the page saved (🐛 #57): only those still shown — an idea since hidden (a link that didn't open,
 *  answered, expired) isn't brought back from the phone's memory. */
function items(userId, ids) {
  const user = db.getUser(userId);
  if (!user || !Array.isArray(ids)) return { items: [] };
  const want = new Set(ids.slice(0, 400).map(String));
  const have = new Set();
  const all = [...spells.forUser(userId).map((s) => ({ type: 'idea', ...s })), ...pool(user, have)];
  const byId = new Map(all.map((i) => [i.id, i]));
  return { items: ids.map(String).filter((id) => want.has(id) && byId.has(id)).map((id) => byId.get(id)) };
}

module.exports = { page, pool, rightNow, map, items, onePerEvent, PAGE };
