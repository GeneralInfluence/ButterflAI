/**
 * Heads-up (owner, 2026-10-13): when someone says yes to a plan, anyone in it who is still
 * deciding — invited, interested, or deferring — and has that person on their avoid list
 * is told privately, in the app, and their answer is paused until they say whether they're
 * still going (their agent won't answer for them meanwhile). It says only who said yes —
 * never why it matters — and the person who said yes is never told (PRIVACY.md
 * Invariant 8: used, not said). The same check when someone is *invited* runs inside the
 * invite itself (multiparty.inviteContacts — Invariant 9's choke point).
 */
'use strict';

const db = require('../../db');
const avoid = require('../../avoid');
const { inApp, first } = require('../notice');

module.exports = {
  name: 'avoid-heads-up',
  on: ['guest_responded'],
  run(changes) {
    let told = 0;
    for (const c of changes) {
      const d = c.data;
      if (d.status !== 'accepted' || d.previous === 'accepted' || !d.phone) continue;
      const e = db._raw().prepare('SELECT id, title, tentative FROM social_events WHERE id = ?').get(c.event_id);
      if (!e) continue;
      const others = db._raw().prepare(`SELECT ei.id, ei.status, c.phone FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
        WHERE ei.event_id = ? AND ei.id != ? AND ei.status IN ('invited', 'accepted') AND ei.dismissed_at IS NULL`).all(e.id, d.invitation_id || '');
      for (const o of others) {
        if (avoid.phoneKey(o.phone) === avoid.phoneKey(d.phone)) continue;
        const u = db.getUserByPhone(o.phone);
        if (!u) continue;
        const entry = avoid.findByPhone(avoid.listAvoid(u.id, { context: 'rsvp heads-up' }), d.phone);
        if (!entry) continue;
        require('../../planops').askOwner(o.id, { via: 'ripple' });
        avoid.recordActivity(u.id, 'needs_decision', { eventId: e.id, avoidId: entry.id,
          text: `${entry.name} (on your avoid list) said yes to "${e.title}". Paused your answer and asked you.` });
        inApp(u.id, e.id, `⚠️ Heads-up: ${first(entry.name)} said yes to ${e.title}. Still going? Answer on the plan — your ButterflAI won't answer for you until you do.`,
          { url: `/app/events?event=${encodeURIComponent(e.id)}` });
        told++;
      }
    }
    return told;
  },
};
