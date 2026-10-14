/**
 * Tell the host when someone answers their invite. One rule for every way an answer
 * arrives (the app, the guest's own agent, a text reply, the public page) — they used to
 * notify three different ways. The host's chat gets a system line so their agent knows,
 * and their agent is asked to pass it on (it follows the usual delivery rules).
 * Not when: the host recorded it themselves; the guest's avoid list declined automatically
 * (the invite itself sent the identical notice, so it can't be told apart from a manual
 * decline — PRIVACY.md Invariant 8); a stranger declined a public event (noise).
 */
'use strict';

const db = require('../../db');

module.exports = {
  name: 'host-notice',
  on: ['guest_responded'],
  run(changes) {
    let told = 0;
    for (const c of changes) {
      const d = c.data;
      if (d.by === 'host' || d.by === 'avoid_list' || d.status === d.previous) continue;
      if (d.source === 'public' && d.status !== 'accepted') continue;
      const e = db._raw().prepare('SELECT id, title, scheduled_at, host_user_id FROM social_events WHERE id = ?').get(c.event_id);
      if (!e) continue;
      const text = d.by === 'public' ? `${d.name || 'A guest'} is attending ${e.title}.`
        : `${d.name || 'A guest'} ${d.status === 'accepted' ? 'accepted' : 'declined'} the invite to ${e.title}.`;
      db.appendConversation(e.host_user_id, 'system', `[System notification] ${text}`);
      const guest = d.phone ? db.getUserByPhone(d.phone) : null;
      require('../../multiparty').queueHostRsvpNotice(e, guest || { phone: d.phone, name: d.name }, d.status);
      told++;
    }
    return told;
  },
};
