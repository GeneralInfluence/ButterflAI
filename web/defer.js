/**
 * defer.js — "I'll go with whatever they decide" on a plan (owner, 2026-10-09).
 *
 * Allie told her ButterflAI she didn't care about the Grover details — it's Melanie's
 * birthday, Melanie and Sean should decide — but it kept passing her questions, and
 * Sean's feed kept "waiting on Allie". Owner decisions:
 *  - Plan only: a deferral covers that one plan; the next plan asks normally.
 *  - No questions about it reach her. Her ButterflAI answers them itself with a fixed
 *    line ("Allie's happy with whatever Melanie and Sean decide") — never her reasons.
 *  - She gets an FYI (not a question) on big changes: date, place, locked in, cancelled.
 *  - She can take it back.
 * Enforced here, in code: questions about that plan are answered without calling the
 * model, and the host's agent gets her standing answer without messaging her agent.
 */
'use strict';

const db = require('./db');
const sse = require('./sse');

const now = () => Math.floor(Date.now() / 1000);
const first = (name) => String(name || 'They').trim().split(/\s+/)[0];

function parseNames(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a.filter(Boolean).map(String) : []; } catch (_) { return []; }
}
// "Melanie", "Melanie and Sean", "Melanie, Sean and Bam Bam"
function joinNames(names) {
  return names.length <= 1 ? (names[0] || 'the others') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** This user's invitation to an event, if any (matched by phone — one row per host). */
function invitationFor(eventId, userId) {
  const user = db.getUser(userId);
  if (!user?.phone || !eventId) return null;
  return db._raw().prepare(`
    SELECT ei.* FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
    WHERE ei.event_id = ? AND c.phone = ?`).get(eventId, user.phone) || null;
}

/** The deferral, if this user deferred on this event: { names, answer } — else null. */
function deferralFor(eventId, userId) {
  const inv = invitationFor(eventId, userId);
  if (!inv?.defers_to) return null;
  const names = parseNames(inv.defers_to);
  const user = db.getUser(userId);
  return { invitation_id: inv.id, names, answer: `${first(user?.name)}'s happy with whatever ${joinNames(names)} decide${names.length === 1 ? 's' : ''} — no need to ask.` };
}

// Answer one question to `userId` with their standing answer (same path as reply_agent).
function answerWithDeferral(question, userId, answer) {
  db.sendAgentMessage({ fromUserId: userId, toUserId: question.from_user, threadId: question.thread_id,
    kind: 'reply', topic: question.topic, body: answer });
  db.markAgentMessageProcessed(question.id);
  const asker = db.getUser(question.from_user);
  if (asker) {
    db.storeInboundMessage({ from_phone: asker.phone, from_type: 'user', from_id: asker.id, channel: 'agent_reply',
      text: `[Agent reply from ${db.getUser(userId)?.name || 'their'}'s agent | thread=${question.thread_id} | topic=${question.topic}] ${answer}` });
  }
}

/**
 * The user defers on a plan they're invited to (or takes it back with undo).
 * Marks them in, records who decides, and answers any open questions about that plan.
 */
function deferOnPlan(userId, { invitation_id, defer_to, undo = false }) {
  const user = db.getUser(userId);
  const inv = invitation_id && db._raw().prepare(`
    SELECT ei.*, c.phone, se.host_user_id, se.title FROM event_invitations ei
    JOIN contacts c ON c.id = ei.contact_id JOIN social_events se ON se.id = ei.event_id
    WHERE ei.id = ?`).get(invitation_id);
  if (!inv || !user?.phone || inv.phone !== user.phone) {
    return { error: 'INVITATION_NOT_FOUND', message: 'Use an inv_id from "You have been invited to" in your state.' };
  }
  if (undo) {
    db._raw().prepare('UPDATE event_invitations SET defers_to = NULL, deferred_at = NULL WHERE id = ?').run(inv.id);
    return { ok: true, undone: true, note: `Questions about "${inv.title}" will come to your user again.` };
  }
  // Names only (first names) — never a reason.
  const names = [...new Set((Array.isArray(defer_to) ? defer_to : [defer_to]).map((n) => first(n)).filter(Boolean))].slice(0, 5);
  if (!names.length) return { error: 'DEFER_TO_REQUIRED', message: 'Who does your user go with? e.g. ["Melanie", "Sean"]' };
  db._raw().prepare(`UPDATE event_invitations SET status = 'accepted', responded_at = COALESCE(responded_at, ?),
    defers_to = ?, deferred_at = ?, needs_owner_decision = 0 WHERE id = ?`).run(now(), JSON.stringify(names), now(), inv.id);
  const d = deferralFor(inv.event_id, userId);
  // Open questions about this plan, from anyone, get the standing answer now.
  const open = db._raw().prepare(`SELECT * FROM agent_messages WHERE to_user = ? AND kind = 'query' AND processed = 0 AND thread_id = ?`)
    .all(userId, inv.event_id);
  for (const q of open) answerWithDeferral(q, userId, d.answer);
  return { ok: true, deferred_to: names, answered_open_questions: open.length,
    note: `Done. Questions about "${inv.title}" get "${d.answer}" without bothering your user; they'll only get an FYI if the date, place or plan changes.` };
}

/**
 * An agent_query about a plan this user deferred on: answer it in code (no model call,
 * nothing shown to the user). Returns true if handled.
 */
function handleQuery(msg, userId) {
  const id = /\bthread=([\w-]+)/.exec(msg.text || '')?.[1];
  const q = id && db._raw().prepare('SELECT * FROM agent_messages WHERE id = ? AND to_user = ?').get(id, userId);
  if (!q || !q.thread_id) return false;
  const d = deferralFor(q.thread_id, userId);
  if (!d) return false;
  // Queued before they deferred? deferOnPlan already answered it — just drop it.
  if (!q.processed) answerWithDeferral(q, userId, d.answer);
  return true;
}

/**
 * FYI (not a question) to everyone who deferred on this event, when something big
 * changes. `change` is a short phrase built in code, e.g. "the date moved to Sat, Oct 31".
 */
function notifyDeferred(eventId, change) {
  const ev = db._raw().prepare('SELECT title, host_user_id FROM social_events WHERE id = ?').get(eventId);
  if (!ev) return 0;
  const host = db.getUser(ev.host_user_id);
  const rows = db._raw().prepare(`SELECT c.phone FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
    WHERE ei.event_id = ? AND ei.defers_to IS NOT NULL`).all(eventId);
  let sent = 0;
  for (const r of rows) {
    const u = db.getUserByPhone(r.phone);
    if (!u) continue;
    const text = `ℹ️ FYI from ${first(host?.name)}'s ButterflAI — ${ev.title}: ${change}. Nothing you need to do.`;
    const { v4: uuidv4 } = require('uuid');
    db._raw().prepare(`INSERT INTO conversation_history (id, user_id, role, text, kind, event_id) VALUES (?, ?, 'assistant', ?, 'notice', ?)`)
      .run(uuidv4(), u.id, text, eventId);
    const online = sse.push(u.id, { role: 'assistant', kind: 'notice', text, ts: now() });
    // Texted only per the usual rule (deliver.notifySelf): never while they're in the app.
    require('./deliver').notifySelf(u, text, { online }).catch(() => {});
    sent++;
  }
  return sent;
}

module.exports = { deferralFor, deferOnPlan, handleQuery, notifyDeferred, invitationFor, joinNames, parseNames };
