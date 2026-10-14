/**
 * The plan's Creating list follows who's in. Someone who says no (or is removed) is no
 * longer someone to-dos can be assigned to: their open to-dos go back to "anyone can take
 * it", and the host is told which ones. Someone who says yes can be assigned to-dos right
 * away — todos.members() reads the guest list live, so that needs no write here.
 */
'use strict';

const db = require('../../db');
const { inApp, first } = require('../notice');

module.exports = {
  name: 'creating',
  on: ['guest_responded', 'guest_removed'],
  run(changes) {
    let freed = 0;
    for (const c of changes) {
      const d = c.data;
      const out = c.type === 'guest_removed' || (d.status === 'declined' && d.previous !== 'declined');
      if (!out || !d.phone) continue;
      const open = db._raw().prepare('SELECT id, text FROM event_todos WHERE event_id = ? AND assignee_phone = ? AND done_at IS NULL')
        .all(c.event_id, d.phone);
      if (!open.length) continue;
      db._raw().prepare('UPDATE event_todos SET assignee_phone = NULL, assignee_name = NULL WHERE event_id = ? AND assignee_phone = ? AND done_at IS NULL')
        .run(c.event_id, d.phone);
      freed += open.length;
      const e = db._raw().prepare('SELECT title, host_user_id FROM social_events WHERE id = ?').get(c.event_id);
      if (!e) continue;
      const items = open.map((t) => `“${t.text}”`).join(', ');
      inApp(e.host_user_id, c.event_id, `✨ ${first(d.name)} ${c.type === 'guest_removed' ? 'is no longer in' : "can't make it to"} ${e.title}, so ${items} ${open.length === 1 ? 'is' : 'are'} open again — anyone in the plan can take ${open.length === 1 ? 'it' : 'them'}.`);
    }
    return freed;
  },
};
