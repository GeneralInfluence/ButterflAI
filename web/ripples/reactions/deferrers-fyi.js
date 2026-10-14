/**
 * People who deferred on a plan ("whatever Melanie decides") get an FYI — not a question —
 * when the date, place, lock-in or cancellation changes (owner, 2026-10-09). One FYI per
 * operation, even if the date and place changed together.
 */
'use strict';

const db = require('../../db');
const defer = require('../../defer');

module.exports = {
  name: 'deferrers-fyi',
  on: ['dates_changed', 'place_changed', 'locked_in', 'cancelled'],
  run(changes) {
    const e = db._raw().prepare('SELECT host_user_id FROM social_events WHERE id = ?').get(changes[0].event_id);
    const tz = (e && db.getUser(e.host_user_id)?.timezone) || 'America/Los_Angeles';
    const big = [];
    for (const c of changes) {
      const d = c.data;
      if (c.type === 'dates_changed' && d.scheduled_at && !d.date_tbd) {
        big.push(`the date is now ${new Date(d.scheduled_at * 1000).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })}`);
      }
      if (c.type === 'place_changed' && d.venue_name) big.push(`it's now at ${d.venue_name}`);
      if (c.type === 'locked_in') big.push("it's locked in");
      if (c.type === 'cancelled') big.push("it's cancelled");
    }
    return big.length ? defer.notifyDeferred(changes[0].event_id, big.join('; ')) : 0;
  },
};
