/**
 * plans.js — shared plans, quiet interest, and the Home feed.
 *
 * Owner decisions (2026-10-08, MEMORY.md §11):
 *  - People share plans when they want to, not when asked. How long a plan holds comes
 *    from their own wording ("tonight", "this weekend") — resolved in datetime.resolveUntil.
 *  - "What're my boys up to tonight?" answers ONLY from what each friend has shared with
 *    the asker. Nobody is pinged. Asking leaves a quiet signal ("Sean's up for something
 *    tonight") that friends see in their Home feed.
 *  - ButterflAI is not a messenger: no per-person "please respond" pushes. Direct pings
 *    are a future per-friend opt-in.
 *
 * Visibility (pull-not-push, PRIVACY): a plan is visible only to the sharer's own
 * contacts — or one of their contact groups if they named it — and never to anyone on
 * the sharer's avoid list. Interest signals follow the same rule in reverse: nobody gets
 * a signal from someone they avoid, and the asker's own avoid list is respected.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const avoid = require('./avoid');
const { resolveUntil } = require('./datetime');

const now = () => Math.floor(Date.now() / 1000);
const firstName = (u) => (u?.nickname || String(u?.name || '').trim().split(/\s+/)[0] || 'A friend');

// "my boys", "the Boys", "boys" all match a group named "The Boys" / "boys".
function normGroup(name) {
  return String(name || '').toLowerCase().trim().replace(/^(my|the)\s+/, '').replace(/^(my|the)\s+/, '').replace(/s$/, '');
}

function findGroup(userId, name) {
  const want = normGroup(name);
  const groups = db.getContactGroups(userId);
  return { group: groups.find((g) => normGroup(g.name) === want) || null, groups };
}

// The users (accounts) behind a list of contact rows.
function usersFor(contacts) {
  return contacts.map((c) => ({ contact: c, user: c.phone ? db.getUserByPhone(c.phone) : null }));
}

/** Does `ownerId` have `viewer` (a user) in their own contacts? */
function ownerKnows(ownerId, viewer) {
  if (!viewer?.phone) return false;
  return !!db._raw().prepare('SELECT 1 FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(ownerId, viewer.phone);
}

function avoids(userId, other) {
  if (!other?.phone) return false;
  try { return !!avoid.findByPhone(avoid.listAvoid(userId, { context: 'plans visibility' }), other.phone); }
  catch (_) { return false; }
}

/** Can `viewer` see this plan? Sharer's contact (or named group member), not avoided. */
function canSee(viewer, plan) {
  if (!viewer || viewer.id === plan.user_id) return viewer?.id === plan.user_id;
  if (!ownerKnows(plan.user_id, viewer)) return false;
  if (avoids(plan.user_id, viewer)) return false;
  if (plan.group_id) {
    const inGroup = db._raw().prepare(`
      SELECT 1 FROM contact_group_members m JOIN contacts c ON c.id = m.contact_id
      WHERE m.group_id = ? AND c.phone = ?`).get(plan.group_id, viewer.phone);
    if (!inGroup) return false;
  }
  return true;
}

/** Share a plan. `until` is the user's wording for how long it holds. */
function sharePlan(userId, { text, until, group } = {}) {
  const body = String(text || '').trim();
  if (!body) return { error: 'EMPTY_PLAN', message: 'Say what the plan is.' };
  const user = db.getUser(userId);
  let groupId = null;
  if (group) {
    const { group: g, groups } = findGroup(userId, group);
    if (!g) {
      return { error: 'GROUP_NOT_FOUND', message: `No group called "${group}". Groups: ${groups.map((x) => x.name).join(', ') || 'none yet'}. Create it with manage_contact_group or share with all contacts.` };
    }
    groupId = g.id;
  }
  const exp = resolveUntil(until || body, user?.timezone);
  const id = uuidv4();
  db._raw().prepare('INSERT INTO shared_plans (id, user_id, text, group_id, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, body.slice(0, 500), groupId, exp.ts);
  return { ok: true, plan_id: id, visible_to: group ? `your "${group}" group` : 'your contacts on ButterflAI', until: exp.label };
}

function myPlans(userId) {
  return db._raw().prepare('SELECT * FROM shared_plans WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC').all(userId, now());
}

function clearPlan(userId, planId = null) {
  const r = planId
    ? db._raw().prepare('DELETE FROM shared_plans WHERE id = ? AND user_id = ?').run(planId, userId)
    : db._raw().prepare('DELETE FROM shared_plans WHERE user_id = ?').run(userId);
  return { ok: true, cleared: r.changes };
}

/**
 * "What're my boys up to tonight?" — answer from what each friend has shared with the
 * asker, and leave each of them a quiet interest signal. Never pings anyone.
 */
function checkFriendsPlans(requesterId, { group, when } = {}) {
  const requester = db.getUser(requesterId);
  let contacts;
  if (group) {
    const { group: g, groups } = findGroup(requesterId, group);
    if (!g) return { error: 'GROUP_NOT_FOUND', message: `No group called "${group}". Groups: ${groups.map((x) => x.name).join(', ') || 'none yet'}.` };
    contacts = g.members;
  } else {
    contacts = db.getContactsByUser(requesterId);
  }
  const exp = resolveUntil(when || 'tonight', requester?.timezone);
  const about = String(when || 'tonight').slice(0, 60);
  const results = [];
  const notOnButterflai = [];
  let signalled = 0;

  for (const { contact, user } of usersFor(contacts)) {
    const name = contact.nickname || contact.name;
    if (!user) { notOnButterflai.push(name); continue; }
    if (user.id === requesterId) continue;
    if (avoids(requesterId, user)) continue;                     // asker's own avoid list
    const visible = db._raw().prepare('SELECT * FROM shared_plans WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC')
      .all(user.id, now()).filter((p) => canSee(requester, p));
    results.push({ name, plans: visible.map((p) => p.text) });
    // Quiet signal — unless they avoid the asker.
    if (!avoids(user.id, requester)) {
      db._raw().prepare(`
        INSERT INTO interest_signals (id, from_user_id, to_user_id, about, expires_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(from_user_id, to_user_id) DO UPDATE SET about = excluded.about, expires_at = excluded.expires_at, created_at = strftime('%s','now')
      `).run(uuidv4(), requesterId, user.id, about, exp.ts);
      signalled++;
    }
  }
  return {
    friends: results,
    shared_something: results.filter((r) => r.plans.length).length,
    nothing_shared: results.filter((r) => !r.plans.length).map((r) => r.name),
    not_on_butterflai: notOnButterflai,
    quiet_signal: signalled
      ? `${signalled} friend(s) will see "${firstName(requester)}'s up for something ${about}" in their Home feed. Nobody was pinged.`
      : null,
  };
}

/** Active plans visible to the viewer (from people who have them as a contact). */
function plansVisibleTo(viewer) {
  if (!viewer?.phone) return [];
  return db._raw().prepare(`
    SELECT DISTINCT p.*, u.name AS owner_name, u.nickname AS owner_nickname
    FROM shared_plans p
    JOIN users u ON u.id = p.user_id
    JOIN contacts c ON c.invited_by_user_id = p.user_id AND c.phone = ?
    WHERE p.expires_at > ? AND p.user_id != ?
    ORDER BY p.created_at DESC`).all(viewer.phone, now(), viewer.id)
    .filter((p) => canSee(viewer, p));
}

function interestFor(userId) {
  return db._raw().prepare(`
    SELECT s.*, u.name AS from_name, u.nickname AS from_nickname FROM interest_signals s
    JOIN users u ON u.id = s.from_user_id
    WHERE s.to_user_id = ? AND s.expires_at > ? ORDER BY s.created_at DESC`).all(userId, now())
    .filter((s) => !avoids(userId, db.getUser(s.from_user_id)));
}

/**
 * The Home feed, ranked by what matters soonest:
 *  invites waiting on you (soonest first) → your events in the next 24h → friends' plans
 *  → friends up for something → later events. Your own shared plans come back separately.
 */
function feedFor(userId) {
  const user = db.getUser(userId);
  const t = now();
  const items = [];

  // Events you're hosting or invited to (next 14 days, plus ones that started <3h ago)
  const hosted = db._raw().prepare(`
    SELECT id, title, activity_type, venue_name, scheduled_at, flexible_time FROM social_events
    WHERE host_user_id = ? AND COALESCE(status, 'open') != 'cancelled'
      AND scheduled_at BETWEEN ? AND ?`).all(userId, t - 3 * 3600, t + 14 * 86400);
  for (const e of hosted) items.push({ type: 'event', role: 'host', event_id: e.id, title: e.title, venue: e.venue_name, at: e.scheduled_at });

  if (user?.phone) {
    const invited = db._raw().prepare(`
      SELECT ei.id AS invitation_id, ei.status, se.id AS event_id, se.title, se.venue_name, se.scheduled_at, u.name AS host_name
      FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
      JOIN social_events se ON se.id = ei.event_id JOIN users u ON u.id = se.host_user_id
      WHERE c.phone = ? AND se.host_user_id != ? AND ei.status IN ('invited','accepted')
        AND ei.dismissed_at IS NULL AND COALESCE(se.status, 'open') != 'cancelled'
        AND se.scheduled_at BETWEEN ? AND ?`).all(user.phone, userId, t - 3 * 3600, t + 14 * 86400);
    for (const e of invited) {
      items.push({ type: e.status === 'invited' ? 'invite' : 'event', role: 'guest', event_id: e.event_id,
        invitation_id: e.invitation_id, title: e.title, venue: e.venue_name, at: e.scheduled_at, host: firstName({ name: e.host_name }) });
    }
  }

  for (const p of plansVisibleTo(user)) {
    items.push({ type: 'plan', plan_id: p.id, who: firstName({ name: p.owner_name, nickname: p.owner_nickname }), text: p.text, until: p.expires_at, created_at: p.created_at });
  }

  // One "up for something" item per person (latest)
  for (const s of interestFor(userId)) {
    items.push({ type: 'interest', who: firstName({ name: s.from_name, nickname: s.from_nickname }), about: s.about, created_at: s.created_at });
  }

  const hoursUntil = (at) => (at - t) / 3600;
  const score = (i) => {
    if (i.type === 'invite') return 1000 - Math.max(0, hoursUntil(i.at));          // waiting on you
    if (i.type === 'event' && hoursUntil(i.at) <= 24) return 900 - hoursUntil(i.at); // happening soon
    if (i.type === 'plan') return 800 - (t - i.created_at) / 3600;                    // friends' plans, newest first
    if (i.type === 'interest') return 700 - (t - i.created_at) / 3600;
    return 500 - hoursUntil(i.at);                                                     // later events
  };
  items.sort((a, b) => score(b) - score(a));

  return {
    items,
    my_plans: myPlans(userId).map((p) => ({ plan_id: p.id, text: p.text, until: p.expires_at })),
  };
}

/** Hard-delete expired plans and signals. */
function purgeExpired() {
  const p = db._raw().prepare('DELETE FROM shared_plans WHERE expires_at <= ?').run(now()).changes;
  const s = db._raw().prepare('DELETE FROM interest_signals WHERE expires_at <= ?').run(now()).changes;
  return p + s;
}

module.exports = { sharePlan, myPlans, clearPlan, checkFriendsPlans, plansVisibleTo, interestFor, feedFor, canSee, purgeExpired };
