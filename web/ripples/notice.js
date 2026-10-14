/**
 * An in-app notice to one user about one plan: their chat (filed under that plan), live
 * if they're in the app, and a push. Never SMS — ripples are FYIs and heads-ups, and
 * texting is for what can't wait (MEMORY.md §10).
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const sse = require('../sse');

function inApp(userId, eventId, text, { url = null } = {}) {
  db._raw().prepare(`INSERT INTO conversation_history (id, user_id, role, text, kind, event_id) VALUES (?, ?, 'assistant', ?, 'notice', ?)`)
    .run(uuidv4(), userId, text, eventId);
  const online = sse.push(userId, { role: 'assistant', kind: 'notice', text, ts: Math.floor(Date.now() / 1000) });
  if (!online) {
    require('../push').notifyUser(db, userId, { title: 'ButterflAI', body: text, url: url || `/app/chat?event=${encodeURIComponent(eventId)}` }).catch(() => {});
  }
  return true;
}

const first = (s) => String(s || '').trim().split(/\s+/)[0] || 'Someone';

module.exports = { inApp, first };
