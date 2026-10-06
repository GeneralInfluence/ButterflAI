/**
 * deliver.js — get a message from one user's agent to a person, in the app first.
 *
 * Owner decision (2026-10-06): agents message people on their user's behalf; nobody
 * chats person-to-person. People must always know who a message is from, and SMS
 * (it costs money) is used only when the recipient couldn't reasonably have seen the
 * message in the app.
 *
 * To a ButterflAI user:
 *   - a labelled card in their chat ("💬 From Allie's ButterflAI: …") + a push
 *   - in the app right now (live chat connection) → seen, never texted
 *   - otherwise texted if still unseen after SMS_FALLBACK_PUSH_SECS (they can get
 *     push notifications) or SMS_FALLBACK_NO_PUSH_SECS (they can't)
 *   - opening the chat marks everything delivered to them as seen
 * To anyone else: texted straight away (the only channel to them).
 * The sender always gets a "📤 To Sean: …" card showing what went out and how.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const sms = require('./sms');
const sse = require('./sse');
const push = require('./push');

const SMS_FALLBACK_PUSH_SECS = 30 * 60;
const SMS_FALLBACK_NO_PUSH_SECS = 2 * 60;

const now = () => Math.floor(Date.now() / 1000);

function firstName(user) {
  return (user?.nickname || String(user?.name || '').trim().split(/\s+/)[0] || 'A friend').trim();
}

/** "Allie's ButterflAI: <message>" — not doubled if the agent already wrote it. */
function withSender(user, message) {
  const prefix = `${firstName(user)}'s ButterflAI: `;
  const body = String(message || '').trim();
  return body.toLowerCase().startsWith(prefix.toLowerCase()) ? body : prefix + body;
}

function stripSender(user, message) {
  const prefix = `${firstName(user)}'s ButterflAI: `;
  const body = String(message || '').trim();
  return body.toLowerCase().startsWith(prefix.toLowerCase()) ? body.slice(prefix.length) : body;
}

// A chat card in a user's history, pushed live if they're connected.
function addCard(userId, kind, text) {
  db.appendConversation(userId, 'assistant', text, null, kind);
  return sse.push(userId, { role: 'assistant', kind, text, ts: now() });
}

function senderCard(fromUser, contact, body, via) {
  const how = via === 'app' ? 'in ButterflAI' : 'by text';
  addCard(fromUser.id, 'outgoing', `📤 To ${contact.nickname || contact.name} (${how}): ${body}`);
}

/**
 * Deliver `message` from `fromUser` to their contact. Throws sms errors
 * (ConsentRequired, RecipientOptedOut) only for the SMS-only path, as before.
 */
async function deliverToContact({ fromUser, contact, message }) {
  const body = stripSender(fromUser, message);
  const recipient = contact.phone ? db.getUserByPhone(contact.phone) : null;

  if (recipient && recipient.id !== fromUser.id) {
    const online = addCard(recipient.id, 'incoming', `💬 From ${firstName(fromUser)}'s ButterflAI: ${body}`);
    let canPush = false;
    try { canPush = (db.getPushSubscriptions(recipient.id) || []).length > 0; } catch (_) {}
    try {
      await push.notifyUser(db, recipient.id, { title: `${firstName(fromUser)}'s ButterflAI`, body, url: '/app/chat' });
    } catch (err) {
      console.error(`[deliver] push failed user=${recipient.id}:`, err.message);
    }
    const id = uuidv4();
    db._raw().prepare(`
      INSERT INTO deliveries (id, from_user_id, to_user_id, to_phone, body, status, sms_due_at, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, fromUser.id, recipient.id, recipient.phone, body,
      online ? 'seen' : 'pending',
      online ? null : now() + (canPush ? SMS_FALLBACK_PUSH_SECS : SMS_FALLBACK_NO_PUSH_SECS),
      online ? now() : null);
    senderCard(fromUser, contact, body, 'app');
    const wait = canPush ? '30 minutes' : '2 minutes';
    return {
      action_status: 'MESSAGE_SENT', sent: true, delivered_via: 'app', delivery_id: id,
      contact_name: contact.name, recipient_online: online,
      note: online
        ? `${contact.name} is in the app now and has the message.`
        : `Delivered in ${contact.name}'s ButterflAI app. If they haven't opened it within ${wait}, it will be texted to them automatically.`,
    };
  }

  await sms.send(contact.phone, withSender(fromUser, body));
  senderCard(fromUser, contact, body, 'sms');
  return { action_status: 'MESSAGE_SENT', sent: true, delivered_via: 'sms', contact_name: contact.name, to: contact.phone };
}

/** The user opened the app: everything delivered to them so far counts as seen. */
function markSeen(userId) {
  return db._raw().prepare(`
    UPDATE deliveries SET status = 'seen', seen_at = ? WHERE to_user_id = ? AND status = 'pending'
  `).run(now(), userId).changes;
}

/** Text anything still unseen past its fallback time. Returns how many were texted. */
async function tickFallback() {
  const due = db._raw().prepare(`
    SELECT * FROM deliveries WHERE status = 'pending' AND sms_due_at <= ? ORDER BY created_at LIMIT 50
  `).all(now());
  let texted = 0;
  for (const d of due) {
    // Claim it first so a slow send can't be picked up twice.
    const claimed = db._raw().prepare(`UPDATE deliveries SET status = 'texting' WHERE id = ? AND status = 'pending'`).run(d.id).changes;
    if (!claimed) continue;
    const fromUser = db.getUser(d.from_user_id);
    try {
      await sms.send(d.to_phone, withSender(fromUser, d.body));
      db._raw().prepare(`UPDATE deliveries SET status = 'texted', sms_sent_at = ? WHERE id = ?`).run(now(), d.id);
      texted++;
    } catch (err) {
      console.error(`[deliver] SMS fallback failed delivery=${d.id}:`, err.message);
      db._raw().prepare(`UPDATE deliveries SET status = 'sms_failed' WHERE id = ?`).run(d.id);
    }
  }
  if (texted) console.log(`[deliver] texted ${texted} message(s) not seen in the app`);
  return texted;
}

function startFallbackLoop(intervalMs = 60 * 1000) {
  console.log(`[deliver] SMS fallback loop starting (interval=${intervalMs}ms)`);
  return setInterval(() => { tickFallback().catch((err) => console.error('[deliver] tick error:', err.message)); }, intervalMs);
}

module.exports = {
  SMS_FALLBACK_PUSH_SECS, SMS_FALLBACK_NO_PUSH_SECS,
  withSender, deliverToContact, markSeen, tickFallback, startFallbackLoop,
};
