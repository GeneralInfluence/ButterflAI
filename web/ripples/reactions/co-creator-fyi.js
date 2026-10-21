/**
 * Plans are made together (owner, 2026-10-19: "Hosting doesn't mean that I'm the only one who
 * can do anything"): anyone who said yes can change a plan's details (plan.canEdit). When
 * someone other than the host does, the host gets an in-app FYI saying who changed what —
 * one per operation. When two plans are combined, each plan's host who didn't do it is told.
 */
'use strict';

const db = require('../../db');
const { inApp, first } = require('../notice');

const WHAT = { renamed: 'renamed it', dates_changed: 'changed the dates', place_changed: 'changed the place',
  details_changed: 'changed the details', locked_in: 'locked it in' };

module.exports = {
  name: 'co-creator-fyi',
  on: ['renamed', 'dates_changed', 'place_changed', 'details_changed', 'locked_in', 'merged'],
  run(changes) {
    let told = 0;
    const byActor = new Map();
    for (const c of changes) {
      if (!c.actor_id) continue;
      const e = db._raw().prepare('SELECT id, title, host_user_id FROM social_events WHERE id = ?').get(c.event_id);
      if (!e) continue;
      const who = (viewer) => require('../../people').nameFor(viewer, c.actor_id, { first: true });
      if (c.type === 'merged') {
        const from = db._raw().prepare('SELECT title, host_user_id FROM social_events WHERE id = ?').get(c.data?.from);
        for (const host of new Set([e.host_user_id, from?.host_user_id].filter((h) => h && h !== c.actor_id))) {
          told += inApp(host, e.id, `${who(host)} combined "${from?.title || 'another plan'}" into ${e.title} — its people, Creating items and discussion are here now.`) ? 1 : 0;
        }
        continue;
      }
      if (e.host_user_id === c.actor_id) continue;
      const k = `${e.id}:${c.actor_id}`;
      if (!byActor.has(k)) byActor.set(k, { e, who: who(e.host_user_id), what: [] });
      const w = WHAT[c.type];
      if (w && !byActor.get(k).what.includes(w)) byActor.get(k).what.push(w);
    }
    for (const [k, { e, who, what }] of byActor.entries()) {
      if (!what.length) continue;
      // The notification opens the plan with this change shown — before and after — once (2026-10-21).
      const actor = k.split(':')[1];
      const last = db._raw().prepare('SELECT max(id) id FROM plan_changes WHERE event_id = ? AND actor_id = ?').get(e.id, actor)?.id;
      const url = last ? `/app/events?event=${encodeURIComponent(e.id)}&changed=${last}` : null;
      told += inApp(e.host_user_id, e.id, `${who} ${what.join(' and ')} on ${e.title}. Tap to see what changed, or undo it under Recent changes.`, { url }) ? 1 : 0;
    }
    return told;
  },
};
