/**
 * A plan's parts follow its people (owner, 2026-10-23: a part — "Friday evening" inside the birthday weekend — has
 * everyone in the bigger plan). Someone added to the bigger plan is invited to its open parts (by each part's host,
 * without needing anyone's number — people.contactFor); someone removed from it leaves them.
 */
'use strict';

const db = require('../../db');

module.exports = {
  name: 'parts',
  on: ['guest_added', 'guest_removed'],
  run(changes) {
    let n = 0;
    for (const c of changes) {
      const u = c.data?.phone ? db.getUserByPhone(c.data.phone) : null;
      if (!u) continue;
      const parts = db._raw().prepare("SELECT id, host_user_id FROM social_events WHERE parent_id = ? AND COALESCE(status, 'open') = 'open'").all(c.event_id);
      for (const p of parts) {
        if (p.host_user_id === u.id) continue;
        const inv = db._raw().prepare('SELECT ei.id FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?').get(p.id, u.phone);
        const planops = require('../../planops');
        if (c.type === 'guest_added' && !inv) {
          const cid = require('../../people').contactFor(p.host_user_id, u);
          if (cid) { planops.invite(p.host_user_id, p.id, [cid], { via: 'part' }).catch((err) => console.error('[parts]', err.message)); n++; }
        } else if (c.type === 'guest_removed' && inv) {
          if (!planops.removeGuest(p.host_user_id, p.id, inv.id, { via: 'part' }).error) n++;
        }
      }
    }
    return n;
  },
};
