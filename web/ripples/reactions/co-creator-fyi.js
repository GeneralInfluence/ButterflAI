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
      const who = first(db.getUser(c.actor_id)?.name);
      if (c.type === 'merged') {
        const from = db._raw().prepare('SELECT title, host_user_id FROM social_events WHERE id = ?').get(c.data?.from);
        for (const host of new Set([e.host_user_id, from?.host_user_id].filter((h) => h && h !== c.actor_id))) {
          told += inApp(host, e.id, `${who} combined "${from?.title || 'another plan'}" into ${e.title} — its people, Creating items and discussion are here now.`) ? 1 : 0;
        }
        continue;
      }
      if (e.host_user_id === c.actor_id) continue;
      const k = `${e.id}:${c.actor_id}`;
      if (!byActor.has(k)) byActor.set(k, { e, who, what: [] });
      const w = WHAT[c.type];
      if (w && !byActor.get(k).what.includes(w)) byActor.get(k).what.push(w);
    }
    for (const { e, who, what } of byActor.values()) {
      if (what.length) told += inApp(e.host_user_id, e.id, `${who} ${what.join(' and ')} on ${e.title}. You can see or undo it under Recent changes.`) ? 1 : 0;
    }
    return told;
  },
};
