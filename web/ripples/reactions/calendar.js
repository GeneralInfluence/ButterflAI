/**
 * Google Calendar follows the plan (owner, 2026-10-13: "a person's google calendar should
 * reflect their ButterflAI calendar"). Any change that can alter what someone's calendar
 * shows marks everyone in the plan — plus anyone who already has an entry for it (someone
 * just removed, the plan folded into another) — for a sync; calmirror.js works out what
 * each calendar should show from the plan object and writes only what changed.
 */
'use strict';

const db = require('../../db');
const calmirror = require('../../calmirror');

module.exports = {
  name: 'calendar',
  on: ['created', 'renamed', 'dates_changed', 'place_changed', 'details_changed', 'locked_in', 'cancelled', 'merged',
    'guest_added', 'guest_responded', 'guest_removed', 'invite_hidden'],
  run(changes) {
    const plans = new Set(changes.map((c) => c.event_id));
    for (const c of changes) if (c.type === 'merged' && c.data.from) plans.add(c.data.from);
    let marked = 0;
    for (const id of plans) {
      const already = db._raw().prepare('SELECT user_id FROM calendar_mirror WHERE event_id = ?').all(id).map((r) => r.user_id);
      marked += calmirror.markDirty(id, [...calmirror.peopleIn(id), ...already]);
    }
    calmirror.flushSoon();
    return marked;
  },
};
