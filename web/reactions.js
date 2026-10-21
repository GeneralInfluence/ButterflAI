'use strict';
/**
 * ❤️ Reactions on chat messages (🐛 #81 — Sean: "It's awesome that Alex responded and said she's going. I'd like to
 * be able to just heart something or do an emoji reaction").
 *
 * A message that's about one person — a friend's ButterflAI message, a friend's yes — can take a reaction. It reaches
 * that person once, in the app only (no text): "❤️ Sean loved your yes for Rocky Horror Picture Show". The person
 * tapped it themselves, so it's theirs to send (MEMORY.md §4). Changing your reaction changes the chip; it isn't sent
 * again. Not delivered to someone who has the reactor on their avoid list (and the reactor isn't told).
 */
const db = require('./db');
const sse = require('./sse');

const EMOJI = ['❤️', '👍', '😂', '🎉', '😮'];
const VERB = { '❤️': 'loved', '👍': 'liked', '😂': 'laughed at', '🎉': 'celebrated', '😮': 'was wowed by' };
const now = () => Math.floor(Date.now() / 1000);

function markAbout(historyId, aboutUserId, what) {
  if (!historyId || !aboutUserId) return;
  db._raw().prepare('UPDATE conversation_history SET about_user_id = ?, about_what = ? WHERE id = ?')
    .run(aboutUserId, what ? String(what).slice(0, 200) : null, historyId);
}

function avoids(ownerId, phone) {
  try { const a = require('./avoid'); return !!a.findByPhone(a.listAvoid(ownerId), phone); } catch (_) { return false; }
}

/** React to one of your own chat messages. emoji '' takes the reaction off. */
function react(userId, historyId, emoji) {
  const m = db._raw().prepare('SELECT id, user_id, about_user_id, about_what, event_id FROM conversation_history WHERE id = ?').get(historyId);
  if (!m || m.user_id !== userId) return { error: 'NOT_FOUND' };
  if (!m.about_user_id) return { error: 'NOBODY_TO_REACH', message: 'This message isn’t from or about anyone to react to.' };
  if (!emoji) { db._raw().prepare('DELETE FROM message_reactions WHERE history_id = ? AND user_id = ?').run(historyId, userId); return { ok: true, reaction: null }; }
  if (!EMOJI.includes(emoji)) return { error: 'BAD_EMOJI', message: `One of ${EMOJI.join(' ')}` };
  const had = db._raw().prepare('SELECT sent_at FROM message_reactions WHERE history_id = ? AND user_id = ?').get(historyId, userId);
  db._raw().prepare(`INSERT INTO message_reactions (history_id, user_id, emoji) VALUES (?, ?, ?)
    ON CONFLICT(history_id, user_id) DO UPDATE SET emoji = excluded.emoji`).run(historyId, userId, emoji);
  let sent = !!had?.sent_at;
  if (!sent) {
    const me = db.getUser(userId);
    const them = db.getUser(m.about_user_id);
    if (me && them && them.id !== me.id && !avoids(them.id, me.phone)) {
      const name = require('./people').nameFor(them.id, me.id, { first: true });
      const text = `${emoji} ${name} ${VERB[emoji]} ${m.about_what || 'your message'}`;
      const id = db.appendConversation(them.id, 'assistant', text, null, 'notice');
      if (m.event_id) db._raw().prepare('UPDATE conversation_history SET event_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM social_events WHERE id = ?)').run(m.event_id, id, m.event_id);
      sse.push(them.id, { id, role: 'assistant', kind: 'notice', text, ts: now() });
    }
    db._raw().prepare('UPDATE message_reactions SET sent_at = ? WHERE history_id = ? AND user_id = ?').run(now(), historyId, userId);
    sent = true;
  }
  return { ok: true, reaction: emoji };
}

/** Reactions on a set of the viewer's messages: Map historyId → emoji. */
function forMessages(userId, ids) {
  const out = new Map();
  if (!ids.length) return out;
  for (const r of db._raw().prepare(`SELECT history_id, emoji FROM message_reactions WHERE user_id = ? AND history_id IN (${ids.map(() => '?').join(',')})`).all(userId, ...ids)) out.set(r.history_id, r.emoji);
  return out;
}

module.exports = { EMOJI, markAbout, react, forMessages };
