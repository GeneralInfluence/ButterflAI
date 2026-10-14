/**
 * answers.js — what friends' ButterflAIs said about a plan, kept on the plan.
 *
 * Owner, 2026-10-13: every agent-to-agent question is about a plan, and the point is to
 * "maximize fun while minimizing communication between people". So an answer is recorded
 * on the plan for the agent that asked (reply_agent), shown on the plan, and checked before
 * anyone asks again (message_agent). Visible only to the person whose agent asked — it is
 * what the other agent chose to tell them, nothing more.
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const first = (s) => String(s || '').trim().split(/\s+/)[0] || 'Someone';

function record({ eventId, askerId, answererId, topic, question, answer }) {
  if (!eventId || !db._raw().prepare('SELECT 1 FROM social_events WHERE id = ?').get(eventId)) return null;
  const id = uuidv4();
  db._raw().prepare(`INSERT INTO plan_answers (id, event_id, asker_user_id, answerer_user_id, topic, question, answer) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, eventId, askerId, answererId, topic || null, String(question || '').slice(0, 500), String(answer).slice(0, 1000));
  return id;
}

/** The latest answer from each person on each topic, for the viewer's own questions. */
function forPlan(eventId, viewerId) {
  const rows = db._raw().prepare(`SELECT pa.*, u.name AS who FROM plan_answers pa JOIN users u ON u.id = pa.answerer_user_id
    WHERE pa.event_id = ? AND pa.asker_user_id = ? ORDER BY pa.created_at DESC`).all(eventId, viewerId);
  const seen = new Set();
  return rows.filter((r) => { const k = `${r.answerer_user_id}|${r.topic}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((r) => ({ who: first(r.who), topic: r.topic, question: r.question, answer: r.answer, at: r.created_at }));
}

/** An earlier answer from this person, about this plan and topic, to this asker. */
function previous(eventId, askerId, answererId, topic) {
  return db._raw().prepare(`SELECT answer, created_at FROM plan_answers WHERE event_id = ? AND asker_user_id = ? AND answerer_user_id = ? AND topic IS ?
    ORDER BY created_at DESC LIMIT 1`).get(eventId, askerId, answererId, topic || null) || null;
}

/** A question to this person about this plan and topic still waiting for an answer. */
function waiting(eventId, askerId, answererId, topic) {
  return db._raw().prepare(`SELECT id, body FROM agent_messages WHERE thread_id = ? AND from_user = ? AND to_user = ? AND kind = 'query'
    AND processed = 0 AND topic IS ? ORDER BY created_at DESC LIMIT 1`).get(eventId, askerId, answererId, topic || null) || null;
}

module.exports = { record, forPlan, previous, waiting };
