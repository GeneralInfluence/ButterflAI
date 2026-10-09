/**
 * groups.js — someone added to a group is caught up on the group's plans.
 *
 * Owner, 2026-10-09 ("add Alex Spargo to My Favorite Mamas … she should be updated with
 * all the current plans, which would include the camping trip"): adding someone to a
 * group ALWAYS invites them to the group's upcoming plans (tentative ones too) and sends
 * ONE catch-up message covering them — not one message per plan.
 *
 * What the catch-up says comes only from the plans themselves (title, dates, place, the
 * host's "plan so far" notes, who's in) — never the group's discussion: what others told
 * their agents stays with them. Invites go through multiparty.inviteContacts, so opt-outs
 * and both people's avoid lists apply exactly as for any invite.
 */
'use strict';

const db = require('./db');
const sms = require('./sms');
const sse = require('./sse');
const multiparty = require('./multiparty');
const deliver = require('./deliver');

const now = () => Math.floor(Date.now() / 1000);
const first = (u) => String(u?.nickname || u?.name || '').trim().split(/\s+/)[0] || 'A friend';

const UPCOMING = `host_user_id = ? AND COALESCE(status, 'open') != 'cancelled' AND (scheduled_at > ? OR flexible_time = 1)`;

/**
 * The group a set of invitees amounts to: the one group (2+ members) whose members are
 * all invited. Owner, 2026-10-09: "you should infer that it is a group plan — I don't
 * want to have to say so." null if none (or ambiguous).
 */
function groupCoveredBy(ownerId, contactIds, { exclude = null } = {}) {
  const invited = new Set(contactIds);
  const fits = db.getContactGroups(ownerId)
    .map((g) => ({ g, members: g.members.map((m) => m.id).filter((id) => id !== exclude) }))
    .filter(({ members }) => members.length >= 2 && members.every((id) => invited.has(id)))
    .sort((a, b) => b.members.length - a.members.length);
  if (!fits.length || (fits[1] && fits[1].members.length === fits[0].members.length)) return null;
  return fits[0].g;
}

/**
 * Upcoming plans the owner made for this group — linked ones, plus unlinked plans whose
 * invitees include all the group's other members (those get linked now).
 */
function upcomingPlans(ownerId, groupId, { exclude = null } = {}) {
  const since = now() - 3 * 3600;
  const linked = db._raw().prepare(`SELECT * FROM social_events WHERE ${UPCOMING} AND group_id = ?`).all(ownerId, since, groupId);
  for (const e of db._raw().prepare(`SELECT * FROM social_events WHERE ${UPCOMING} AND group_id IS NULL`).all(ownerId, since)) {
    const invitees = db._raw().prepare('SELECT contact_id FROM event_invitations WHERE event_id = ?').all(e.id).map((r) => r.contact_id);
    if (groupCoveredBy(ownerId, invitees, { exclude })?.id === groupId) {
      db._raw().prepare('UPDATE social_events SET group_id = ? WHERE id = ?').run(groupId, e.id);
      linked.push({ ...e, group_id: groupId });
    }
  }
  return linked.sort((a, b) => a.scheduled_at - b.scheduled_at);
}

// "Fri, Oct 23 – Sun, Oct 25" for multi-day plans; date only while tentative.
function whenText(e, tz) {
  if (e.flexible_time) return 'open invite';
  const day = (ts) => new Date(ts * 1000).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  const end = e.scheduled_at + (e.duration_mins || 120) * 60;
  if (day(end) !== day(e.scheduled_at) && (e.duration_mins || 0) >= 12 * 60) return `${day(e.scheduled_at)} – ${day(end)}`;
  if (e.tentative) return day(e.scheduled_at);
  return multiparty.formatEventDate(e.scheduled_at, tz);
}

function planLine(e, owner, recipientPhone, tz) {
  const going = db._raw().prepare(`SELECT COALESCE(c.nickname, c.name) AS name, c.phone FROM event_invitations ei
    JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND ei.status = 'accepted'`).all(e.id)
    .filter((r) => r.phone !== recipientPhone).map((r) => first({ name: r.name }));
  if (e.host_attending !== 0) going.unshift(first(owner));
  return `• ${e.title}${e.tentative ? ' (tentative)' : ''} — ${whenText(e, tz)}`
    + (e.venue_name ? ` · ${e.venue_name}` : '')
    + (e.notes ? ` · plan so far: ${String(e.notes).slice(0, 200)}` : '')
    + (going.length ? ` · in: ${going.join(', ')}` : '');
}

/**
 * Call after a contact is newly added to a group. Invites them to the group's upcoming
 * plans and sends one catch-up. Returns { caught_up, plans, via } (caught_up 0 if none).
 */
async function onMemberAdded(ownerId, groupId, contactId) {
  const owner = db.getUser(ownerId);
  const group = db.getContactGroups(ownerId).find((g) => g.id === groupId);
  const contact = db.getContact(contactId);
  if (!owner || !group || !contact || contact.invited_by_user_id !== ownerId || !contact.phone) return { caught_up: 0 };

  const plans = [];
  for (const e of upcomingPlans(ownerId, groupId, { exclude: contactId })) {
    const r = await multiparty.inviteContacts(e.id, [contactId], { quiet: true });
    if ((r.invited || []).includes(contactId)) plans.push(e);
  }
  if (!plans.length) return { caught_up: 0 };

  const recipient = db.getUserByPhone(contact.phone);
  const tz = recipient?.timezone || owner.timezone || 'America/Los_Angeles';
  const lines = plans.map((e) => planLine(e, owner, contact.phone, tz)).join('\n');
  const titles = plans.map((e) => e.title);

  if (recipient) {
    // In the app first (labelled "From Sean's ButterflAI"), push, SMS only per the usual rule.
    const r = await deliver.deliverToContact({ fromUser: owner, contact,
      message: `You're now in ${first(owner)}'s "${group.name}" group. What's planned:\n${lines}\nIt's on your Home — tell your ButterflAI if you're in.` });
    if (plans.length === 1) tagLatest([recipient.id, owner.id], plans[0].id);
    return { caught_up: plans.length, plans: titles, via: r.delivered_via };
  }

  // Not on ButterflAI: one first-contact text (self-identifies, offers STOP), like an invite.
  if (db.isOptedOut(contact.phone)) return { caught_up: 0, plans: titles, note: 'They opted out of texts — invited, but not messaged.' };
  const baseUrl = process.env.BASE_URL || 'https://butterflai.social';
  const text = `Hi ${first(contact)}! This is ${first(owner)}'s ButterflAI. ${first(owner)} added you to the "${group.name}" group. What's planned:\n${lines}\n\n`
    + `Reply to let ${first(owner)} know if you're in. Want your own ButterflAI? ${baseUrl}\n\nReply STOP to opt out.`;
  await sms.sendUnchecked(contact.phone, text);
  db.appendConversation(ownerId, 'assistant', `📤 To ${contact.nickname || contact.name} (by text): caught up on ${titles.join(', ')}`, null, 'outgoing');
  sse.push(ownerId, { role: 'assistant', kind: 'outgoing', text: `📤 To ${contact.nickname || contact.name} (by text): caught up on ${titles.join(', ')}`, ts: now() });
  return { caught_up: plans.length, plans: titles, via: 'sms' };
}

// File the catch-up cards under the plan's discussion (topics.js) when there's one plan.
function tagLatest(userIds, eventId) {
  for (const uid of userIds) {
    db._raw().prepare(`UPDATE conversation_history SET event_id = ? WHERE id = (
      SELECT id FROM conversation_history WHERE user_id = ? AND event_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1)`).run(eventId, uid);
  }
}

module.exports = { onMemberAdded, upcomingPlans, groupCoveredBy };
