/**
 * The plan's Creating list follows who's in. Someone who says no (or is removed) is no
 * longer someone to-dos can be assigned to: their open to-dos go back to "anyone can take
 * it", and the host is told which ones. Someone who says yes can be assigned to-dos right
 * away — todos.members() reads the guest list live, so that needs no write here.
 * A new guest with ButterflAI sees the list (owner, 2026-10-13: "new guest should see the
 * todos"): one notice in the plan's chat with what's being made, who has what, and what's
 * open — when there's anything on it.
 */
'use strict';

const db = require('../../db');
const { inApp, first } = require('../notice');

// The plan's kept to-dos, shown to someone who just joined it.
function showList(c) {
  const d = c.data;
  if (!d.phone || d.status === 'declined') return;
  const u = db.getUserByPhone(d.phone);
  const e = db._raw().prepare('SELECT title, host_user_id FROM social_events WHERE id = ?').get(c.event_id);
  if (!u || !e || u.id === e.host_user_id) return;
  const items = db._raw().prepare('SELECT text, assignee_name, assignee_phone, done_at FROM event_todos WHERE event_id = ? AND suggested = 0 ORDER BY done_at IS NOT NULL, created_at')
    .all(c.event_id);
  if (!items.length) return;
  const line = (t) => `${t.done_at ? '✓' : '☐'} ${t.text}${t.done_at ? '' : t.assignee_phone === u.phone ? ' (you)' : t.assignee_name ? ` (${first(t.assignee_name)})` : ' — anyone can take it'}`;
  const open = items.filter((t) => !t.done_at).length;
  inApp(u.id, c.event_id, `✨ Creating for ${e.title} — ${open} to do${items.length > open ? `, ${items.length - open} done` : ''}:\n${items.slice(0, 12).map(line).join('\n')}\nTake one or add your own in this plan's chat.`);
}

module.exports = {
  name: 'creating',
  on: ['guest_added', 'guest_responded', 'guest_removed'],
  run(changes) {
    let freed = 0;
    for (const c of changes.filter((x) => x.type === 'guest_added')) showList(c);
    for (const c of changes.filter((x) => x.type !== 'guest_added')) {
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
