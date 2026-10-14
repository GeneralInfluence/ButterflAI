/**
 * home.js — the Home screen's feed and its at-a-glance summary.
 * (Was part of plans.js, split 2026-10-13.) Reads plans from plan.js, shares and interest
 * from feeling.js, to-dos from todos.js, check-ins from attendance.js.
 */

'use strict';

const db = require('./db');
const avoid = require('./avoid');
const { myPlans, plansVisibleTo, interestFor, firstName, plansFromShares } = require('./feeling');

const now = () => Math.floor(Date.now() / 1000);

/**
 * The Home feed, ranked by what matters soonest:
 *  invites waiting on you (soonest first) → your events in the next 24h → friends' plans
 *  → friends up for something → later events. Your own shared plans come back separately.
 */
// How far ahead the feed looks. Trips get planned weeks out (2026-10-09: the Grover trip
// on Oct 23 was invisible from Oct 9 with the old 14-day window).
const FEED_DAYS = 60;

// A coordination thread is named after its event (agent.js message_agent).
const eventIdOf = (threadId) => threadId && db._raw().prepare('SELECT 1 FROM social_events WHERE id = ?').get(threadId) ? threadId : undefined;

/**
 * The Home feed, ranked by what needs YOU to move things forward, then by how soon
 * (owner, 2026-10-09). Item types:
 *   invite   — someone invited you; waiting on your answer            (needs you)
 *   question — a friend's ButterflAI asked you something, unanswered   (needs you)
 *   event    — your events and ones you're going to (tentative ones say so; hosts see
 *              who's interested / not answered; "lock it in" when everyone's answered)
 *   (who you're waiting on is part of each plan's card — plan.js)
 *   plan / interest — what friends shared / who's up for something
 */
function feedFor(userId) {
  const user = db.getUser(userId);
  const t = now();
  const items = [];
  const from = t - 3 * 3600, to = t + FEED_DAYS * 86400;
  const myAvoid = (() => { try { return avoid.listAvoid(userId, { context: 'home feed' }); } catch (_) { return []; } })();

  // Plans you're in — one object each (plan.js), not re-derived here (owner, 2026-10-12).
  // Who's in / waiting / asked-but-no-answer is part of each plan's card; there are no
  // free-floating "waiting on" items any more.
  const shownEventIds = new Set();
  for (const p of require('./plan').plansFor(userId)) {
    if (p.at && (p.at < from || p.at > to)) continue;
    shownEventIds.add(p.id);
    const base = { event_id: p.id, title: p.title, venue: p.place, at: p.at, tentative: p.tentative,
      date_tbd: p.dates.kind === 'tbd', proposed_dates: p.dates.proposals.length ? p.dates.proposals : undefined };
    if (p.stage === 'invited') {
      items.push({ ...base, type: 'invite', role: 'guest', invitation_id: p.invitation.id, host: p.host.name, action: p.next });
    } else {
      items.push({ ...base, type: 'event', role: p.role, host: p.host.name, interested: p.interested, waiting_on: p.waiting_on,
        asked: p.asked, out: p.out, deferring: p.deferring, action: p.next || null });
    }
  }

  // Creating (owner, 2026-10-12): items from your plans' shared lists — their own Home
  // section between Feeling and Happenings: yours, then unassigned, then suggestions.
  const home = require('./todos').forHome(userId);
  const creating = home.items.sort((a, b) => (a.who === b.who ? 0 : a.who === 'you' ? -1 : 1) || (a.at || Infinity) - (b.at || Infinity));
  const creatingSuggestions = home.suggestions;

  // "Did you make it?" after plans you were in (attendance.js, 2026-10-13).
  for (const c of require('./attendance').openFor(userId)) {
    items.push({ type: 'checkin', confirmation_id: c.id, event_id: c.event_id, title: c.title, at: c.scheduled_at, action: 'Did you make it?' });
  }

  // Questions friends' ButterflAIs asked you that you haven't answered.
  const asked = db._raw().prepare(`
    SELECT am.id, am.body, am.created_at, am.thread_id, u.name, u.phone FROM agent_messages am JOIN users u ON u.id = am.from_user
    WHERE am.to_user = ? AND am.kind = 'query' AND am.processed = 0 AND am.created_at > ?
    ORDER BY am.created_at DESC LIMIT 5`).all(userId, t - 7 * 86400);
  for (const q of asked) {
    if (avoid.findByPhone(myAvoid, q.phone)) continue;
    items.push({ type: 'question', who: firstName(q), text: String(q.body).slice(0, 200), created_at: q.created_at,
      event_id: eventIdOf(q.thread_id), action: 'Answer in chat' });
  }

  const friendShares = plansVisibleTo(user);
  const madeFrom = plansFromShares(userId, friendShares.map((p) => p.id));
  for (const p of friendShares) {
    items.push({ type: 'plan', plan_id: p.id, who: firstName({ name: p.owner_name, nickname: p.owner_nickname }), text: p.text, until: p.expires_at, created_at: p.created_at,
      made_plan: madeFrom[p.id] || null });
  }

  // One "up for something" item per person (latest)
  for (const s of interestFor(userId)) {
    items.push({ type: 'interest', who: firstName({ name: s.from_name, nickname: s.from_nickname }), about: s.about, created_at: s.created_at });
  }

  const daysOut = (at) => Math.max(0, (at - t) / 86400);
  const hoursAgo = (ts) => Math.max(0, (t - (ts || t)) / 3600);
  const score = (i) => {
    // 1. Things waiting on you — soonest first.
    if (i.type === 'invite') return 3000 - daysOut(i.at) * 10;
    if (i.type === 'question') return 3000 - hoursAgo(i.created_at) * 0.1;
    if (i.type === 'checkin') return 2500;   // after what needs you to move a plan on
    if (i.type === 'event' && i.action) return 3000 - daysOut(i.at) * 10;
    // 2. Happening in the next day.
    if (i.type === 'event' && daysOut(i.at) <= 1) return 2000 - daysOut(i.at) * 24;
    // 3. What friends shared / who's up for something — newest first.
    if (i.type === 'plan') return 1500 - hoursAgo(i.created_at);
    if (i.type === 'interest') return 1400 - hoursAgo(i.created_at);
    // 4. Waiting on others, then everything else by how soon.
    return 1000 - daysOut(i.at) * 10;
  };
  items.sort((a, b) => score(b) - score(a));

  const myShares = myPlans(userId);
  const mineMade = plansFromShares(userId, myShares.map((p) => p.id));
  const mine = myShares.map((p) => ({ plan_id: p.id, text: p.text, until: p.expires_at, made_plan: mineMade[p.id] || null }));
  return {
    items,
    my_plans: mine,
    creating,
    creating_suggestions: creatingSuggestions,
    summary: homeSummary({ items, mine, creating, suggestions: creatingSuggestions }),
  };
}

/** Does this feed item need the viewer to act? (invite, a friend's question, a plan to lock in) */
const needsYou = (i) => i.type === 'invite' || i.type === 'question' || i.type === 'checkin' || (i.type === 'event' && !!i.action);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Home's three sections at a glance (owner, 2026-10-13): one line each beside the title,
 * computed here once so the page only displays it. Counts come from the same lists the
 * full views show, so they always agree.
 */
function homeSummary({ items, mine, creating, suggestions }) {
  const friendPlans = items.filter((i) => i.type === 'plan').length;
  const interest = items.filter((i) => i.type === 'interest').length;
  const feeling = [mine.length ? `You: ${mine[0].text}` : '',
    friendPlans ? `${plural(friendPlans, 'friend', 'friends')} shared` : '',
    interest ? `${interest} up for something` : ''].filter(Boolean);

  const yours = creating.filter((c) => c.who === 'you').length;
  const open = creating.length - yours;
  const waiting = suggestions.reduce((n, s) => n + (s.count || 0), 0);
  const making = [yours ? `${yours} for you` : '', open ? `${open} open` : '',
    waiting ? `${plural(waiting, 'suggestion', 'suggestions')} waiting` : ''].filter(Boolean);

  const needs = items.filter(needsYou).length;
  const coming = items.filter((i) => i.type === 'event' || i.type === 'invite').length;
  const happening = [needs ? `${needs} need${needs === 1 ? 's' : ''} you` : '', coming ? `${coming} coming up` : ''].filter(Boolean);

  return {
    feeling: { line: feeling.join(' · ') || 'Nothing shared yet', needs_you: false },
    creating: { line: making.join(' · ') || 'All caught up', needs_you: yours > 0 },
    happenings: { line: happening.join(' · ') || 'Nothing yet', needs_you: needs > 0 },
  };
}


module.exports = { feedFor, homeSummary, needsYou, FEED_DAYS };
