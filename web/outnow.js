/**
 * outnow.js — I'm out: who's near you right now and up for something (owner, 2026-10-20, at Lake
 * Tahoe: "it would be nice if there was … hey, there's a few potential connections around. You could
 * reach out to somebody and just have a drink or have a coffee or have dinner or sit on the beach and
 * have a six-pack").
 *
 *  - You say you're out and what you're up for (coffee / a drink / dinner / hanging out). The app
 *    sends your phone's location while it's open; it ends after a few hours (or Stop).
 *  - Near you now: friends who are out nearby (named — you have each other saved): "Say hi" asks them;
 *    if they say yes there's a plan for the two of you. Other people out nearby, both "open to new
 *    people": anonymous ("someone ~2 mi away is up for a drink too"); "I'm interested" reaches them
 *    only if they're interested in you too — then first names are shared and there's a plan to meet.
 * Safety (PRIVACY.md "I'm out"): nobody sees anyone's location, only a rough distance band; within
 * 15 km; location rounded to ~1 km and deleted when the outing ends; avoid lists both ways; meeting new
 * people needs "I'm 18 or older"; "Not now" tells nobody.
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const RADIUS_KM = 15;   // the default reach (~15–20 min drive)
// How far they'll go, chosen per outing (owner, 2026-10-20): minutes away → km (rough, for driving).
const REACH = { 5: 5, 10: 10, 20: 20, 30: 30 };
const ACTIVITIES = { coffee: '☕ coffee', drink: '🍺 a drink', dinner: '🍽️ dinner', hang: '🏖️ hanging out' };
const now = () => Math.floor(Date.now() / 1000);
// Someone nearby you don't know is a token only you can use (not their account id).
const SECRET = process.env.JWT_SECRET || 'outnow';
const token = (viewer, other) => require('crypto').createHmac('sha256', SECRET).update(`${viewer}:${other}`).digest('hex').slice(0, 20);
const round = (x) => Math.round(Number(x) * 100) / 100;   // ~1 km

function km(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function band(k) { const mi = k * 0.621; return mi < 1 ? 'under a mile' : mi < 3 ? '~2 mi' : mi < 7 ? '~5 mi' : '~10 mi'; }

/** I'm out (or still out — the location refreshes whenever the app opens). */
function goOut(userId, { up_for = [], lat, lng, hours = 4, open_to_new = false, adult = false, minutes = 20 }) {
  const acts = (Array.isArray(up_for) ? up_for : []).filter((a) => ACTIVITIES[a]);
  if (!acts.length) return { error: 'UP_FOR', message: 'Pick what you’re up for.' };
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { error: 'LOCATION', message: 'Need your location to find people nearby.' };
  if (open_to_new && !adult) return { error: 'ADULT', message: 'Meeting new people is for 18 and over.' };
  const until = now() + Math.max(1, Math.min(12, Number(hours) || 4)) * 3600;
  const maxKm = REACH[Number(minutes)] || RADIUS_KM;
  db._raw().prepare(`INSERT INTO out_now (user_id, up_for, lat, lng, open_to_new, until, updated_at, max_km) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET up_for = excluded.up_for, lat = excluded.lat, lng = excluded.lng, open_to_new = excluded.open_to_new, until = excluded.until, updated_at = excluded.updated_at, max_km = excluded.max_km`)
    .run(userId, JSON.stringify(acts), round(lat), round(lng), open_to_new ? 1 : 0, until, now(), maxKm);
  return { ok: true, me: mine(userId) };
}
/** Only refresh where you are (opening the app while out). */
function refresh(userId, { lat, lng }) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return { error: 'LOCATION' };
  const r = db._raw().prepare('UPDATE out_now SET lat = ?, lng = ?, updated_at = ? WHERE user_id = ? AND until > ?').run(round(lat), round(lng), now(), userId, now());
  return r.changes ? { ok: true } : { error: 'NOT_OUT' };
}
function stop(userId) {
  db._raw().prepare('DELETE FROM out_now WHERE user_id = ?').run(userId);
  db._raw().prepare("DELETE FROM out_requests WHERE (from_user = ? OR to_user = ?) AND status = 'pending'").run(userId, userId);
  return { ok: true };
}
function row(userId) { return db._raw().prepare('SELECT * FROM out_now WHERE user_id = ? AND until > ?').get(userId, now()); }
function mine(userId) {
  const r = row(userId);
  return r ? { up_for: JSON.parse(r.up_for), until: r.until, open_to_new: !!r.open_to_new, minutes: Object.keys(REACH).find((m) => REACH[m] === r.max_km) || null } : null;
}

function savedEach(a, b) {
  const has = (o, u) => !!(u?.phone && db._raw().prepare('SELECT 1 FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(o.id, u.phone));
  return has(a, b) && has(b, a);
}
function avoided(a, b) {
  try {
    const avoid = require('./avoid');
    const list = (u) => avoid.listAvoid(u.id, { accessor: 'out_now', context: 'nearby matching (never shown)' });
    return !!(avoid.findByPhone(list(a), b.phone) || avoid.findByPhone(list(b), a.phone));
  } catch (_) { return true; }
}
const words = (acts) => acts.map((a) => ACTIVITIES[a]).join(' or ');

/** Who's near you now: friends (named) and, when you're both open to new people, others (anonymous). */
function nearby(userId) {
  const me = row(userId);
  if (!me) return { me: null, friends: [], others: [], asks: asksFor(userId) };
  const meU = db.getUser(userId);
  const out = { me: mine(userId), friends: [], others: [], asks: asksFor(userId) };
  for (const r of db._raw().prepare('SELECT * FROM out_now WHERE user_id != ? AND until > ?').all(userId, now())) {
    const k = km(me, r);
    if (k > Math.min(me.max_km || RADIUS_KM, r.max_km || RADIUS_KM)) continue;   // within BOTH people's reach
    const u = db.getUser(r.user_id);
    if (!u || avoided(meU, u)) continue;
    const acts = JSON.parse(r.up_for);
    const shared = acts.filter((a) => JSON.parse(me.up_for).includes(a));
    const sent = db._raw().prepare('SELECT status FROM out_requests WHERE from_user = ? AND to_user = ?').get(userId, r.user_id)?.status || null;
    if (savedEach(meU, u)) {
      out.friends.push({ id: r.user_id, name: require('./people').nameFor(userId, r.user_id, { first: true }), up_for: words(acts), distance: band(k), asked: sent });
    } else if (me.open_to_new && r.open_to_new && shared.length) {
      out.others.push({ id: token(userId, r.user_id), _user: r.user_id, up_for: words(shared), distance: band(k), asked: sent });
    }
  }
  return out;
}

/** What's waiting for you: a friend saying hi (named), or a mutual "interested" (introduced). */
function asksFor(userId) {
  return db._raw().prepare("SELECT * FROM out_requests WHERE to_user = ? AND kind = 'friend' AND status = 'pending' ORDER BY created_at DESC").all(userId)
    .map((q) => ({ id: q.id, name: require('./people').nameFor(userId, q.from_user, { first: true }), activity: ACTIVITIES[q.activity] || 'meeting up' }));
}

function notify(userId, text) { require('./ripples/notice').inApp(userId, null, text, { url: '/app/dashboard#feeling' }); }

async function makePlan(hostId, guestId, activity, { introduce = false } = {}) {
  const host = db.getUser(hostId), guest = db.getUser(guestId);
  let cid = db._raw().prepare('SELECT id FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(hostId, guest.phone)?.id;
  if (!cid) cid = db.upsertContact({ invited_by_user_id: hostId, name: guest.name, phone: guest.phone, tier: 1 });
  if (introduce && !db._raw().prepare('SELECT 1 FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(guestId, host.phone)) {
    db.upsertContact({ invited_by_user_id: guestId, name: host.name, phone: host.phone, tier: 1 });
  }
  const what = { coffee: 'Coffee', drink: 'A drink', dinner: 'Dinner', hang: 'Hanging out' }[activity] || 'Meeting up';
  const title = `${what} with ${String(guest.name).split(' ')[0]} — tonight`.slice(0, 80);
  const r = await require('./planops').create(hostId, { title, activity_type: activity === 'dinner' ? 'dinner' : 'hangout', flexible_time: true,
    notes: introduce ? 'You met through "I\'m out" — pick somewhere public to meet.' : undefined, contact_ids: [cid] }, { via: 'out_now' });
  if (r.eventId) {
    const inv = db._raw().prepare('SELECT id FROM event_invitations WHERE event_id = ? AND contact_id = ?').get(r.eventId, cid);
    if (inv) require('./planops').respond(inv.id, 'accepted', { by: 'guest', phone: guest.phone, userId: guestId, via: 'out_now', going: true });
  }
  return r.eventId || null;
}

/** "Say hi" (friend) or "I'm interested" (someone nearby). */
async function reach(userId, otherId, { activity } = {}) {
  const view = nearby(userId);
  const f = view.friends.find((x) => x.id === otherId), o = view.others.find((x) => x.id === otherId);
  if (!f && !o) return { error: 'NOT_NEARBY', message: 'They’re not out near you any more.' };
  if (o) otherId = o._user;
  const myActs = view.me.up_for;
  const theirs = JSON.parse(row(otherId).up_for);
  const act = (activity && myActs.includes(activity) ? activity : null) || myActs.find((a) => theirs.includes(a)) || myActs[0];
  db._raw().prepare(`INSERT INTO out_requests (id, from_user, to_user, kind, activity) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(from_user, to_user) DO UPDATE SET activity = excluded.activity, status = 'pending', created_at = strftime('%s','now')`)
    .run(uuidv4(), userId, otherId, f ? 'friend' : 'nearby', act);
  if (f) {
    notify(otherId, `👋 ${require('./people').nameFor(otherId, userId, { first: true })} is out near you and up for ${ACTIVITIES[act]}. Want to? (Home → Feeling)`);
    return { ok: true, status: 'asked' };
  }
  // Someone nearby: nothing reaches them unless they're interested in you too.
  const back = db._raw().prepare("SELECT * FROM out_requests WHERE from_user = ? AND to_user = ? AND status = 'pending'").get(otherId, userId);
  if (!back) return { ok: true, status: 'waiting' };
  db._raw().prepare("UPDATE out_requests SET status = 'met' WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)").run(userId, otherId, otherId, userId);
  const eventId = await makePlan(userId, otherId, act, { introduce: true });
  const me = db.getUser(userId), them = db.getUser(otherId);
  notify(otherId, `✨ You're both up for it: ${String(me.name).split(' ')[0]} is nearby and interested too — ${ACTIVITIES[act]}. There's a plan for the two of you in Plans. Meet somewhere public.`);
  return { ok: true, status: 'met', name: String(them.name).split(' ')[0], event_id: eventId };
}

/** A friend said hi: yes → a plan for the two of you; no → they're not told. */
async function answer(userId, requestId, yes) {
  const q = db._raw().prepare("SELECT * FROM out_requests WHERE id = ? AND to_user = ? AND status = 'pending'").get(requestId, userId);
  if (!q) return { error: 'NOT_FOUND' };
  if (!yes) { db._raw().prepare("UPDATE out_requests SET status = 'declined' WHERE id = ?").run(q.id); return { ok: true, status: 'declined' }; }
  db._raw().prepare("UPDATE out_requests SET status = 'accepted' WHERE id = ?").run(q.id);
  const eventId = await makePlan(q.from_user, userId, q.activity);
  db._raw().prepare('UPDATE out_requests SET event_id = ? WHERE id = ?').run(eventId, q.id);
  notify(q.from_user, `🙌 ${require('./people').nameFor(q.from_user, userId, { first: true })} is in — ${ACTIVITIES[q.activity]}. It's in your Plans.`);
  return { ok: true, status: 'accepted', event_id: eventId };
}

/** Outings end on their own; their location goes with them. */
function purgeOld() {
  const ended = db._raw().prepare('SELECT user_id FROM out_now WHERE until < ?').all(now()).map((r) => r.user_id);
  for (const u of ended) stop(u);
  db._raw().prepare("DELETE FROM out_requests WHERE created_at < ? AND status != 'met'").run(now() - 86400);
  return ended.length;
}

module.exports = { goOut, refresh, stop, nearby, reach, answer, purgeOld, mine, ACTIVITIES, RADIUS_KM, REACH, _km: km };
