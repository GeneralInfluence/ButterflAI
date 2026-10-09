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

// Someone "uses the app" if they opened it in the last ACTIVE_DAYS days.
const ACTIVE_DAYS = 14;
function isActive(user) {
  return !!user?.last_active_at && user.last_active_at >= now() - ACTIVE_DAYS * 86400;
}
function canPushTo(userId) {
  try { return (db.getPushSubscriptions(userId) || []).length > 0; } catch (_) { return false; }
}

function recordDelivery({ fromId, toUser, body, status, smsDueAt = null, seenAt = null, smsSentAt = null }) {
  const id = uuidv4();
  db._raw().prepare(`
    INSERT INTO deliveries (id, from_user_id, to_user_id, to_phone, body, status, sms_due_at, seen_at, sms_sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, fromId, toUser.id, toUser.phone, body, status, smsDueAt, seenAt, smsSentAt);
  return id;
}

/**
 * Deliver `message` from `fromUser` to their contact. Throws sms errors
 * (ConsentRequired, RecipientOptedOut) only for the SMS-only path, as before.
 *
 * Texted RIGHT AWAY (rules, not judgment — 2026-10-09, Melanie hadn't opened the app
 * since June and "text her now" still went in-app with a 2-minute wait):
 *  - forceText: the user asked for a text
 *  - the recipient can't see it in the app: not active in ACTIVE_DAYS and no push
 * The recipient still gets the card in their chat either way.
 */
async function deliverToContact({ fromUser, contact, message, forceText = false }) {
  const body = stripSender(fromUser, message);
  const recipient = contact.phone ? db.getUserByPhone(contact.phone) : null;

  if (recipient && recipient.id !== fromUser.id) {
    const online = addCard(recipient.id, 'incoming', `💬 From ${firstName(fromUser)}'s ButterflAI: ${body}`);
    const canPush = canPushTo(recipient.id);
    const textNow = forceText || (!online && !isActive(recipient) && !canPush);

    if (textNow) {
      try {
        await sms.send(recipient.phone, withSender(fromUser, body));
        const id = recordDelivery({ fromId: fromUser.id, toUser: recipient, body, status: 'texted', smsSentAt: now() });
        senderCard(fromUser, contact, body, 'sms');
        return {
          action_status: 'MESSAGE_SENT', sent: true, delivered_via: 'sms', delivery_id: id, contact_name: contact.name,
          note: forceText ? `Texted to ${contact.name} now, as asked.` : `Texted to ${contact.name} now — they haven't been using the app, so they wouldn't see it there.`,
        };
      } catch (err) {
        // Opted out of texts / no consent: fall back to in-app only.
        console.error(`[deliver] immediate text failed user=${recipient.id}:`, err.message);
        if (forceText) {
          senderCard(fromUser, contact, body, 'app');
          return { action_status: 'MESSAGE_SENT', sent: true, delivered_via: 'app', contact_name: contact.name,
            note: `Couldn't text ${contact.name} (${err.name === 'RecipientOptedOut' ? 'they opted out of texts' : 'texts not allowed'}), so it's in their ButterflAI app only.` };
        }
      }
    }

    try {
      await push.notifyUser(db, recipient.id, { title: `${firstName(fromUser)}'s ButterflAI`, body, url: '/app/chat' });
    } catch (err) {
      console.error(`[deliver] push failed user=${recipient.id}:`, err.message);
    }
    const id = recordDelivery({
      fromId: fromUser.id, toUser: recipient, body,
      status: online ? 'seen' : 'pending',
      smsDueAt: online ? null : now() + (canPush ? SMS_FALLBACK_PUSH_SECS : SMS_FALLBACK_NO_PUSH_SECS),
      seenAt: online ? now() : null,
    });
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

/**
 * An update from the user's OWN agent that it sent on its own (an RSVP came in, another
 * agent replied…). It's already in their chat; text it only if they won't see it there.
 * (Feedback #6, 2026-10-09: Sean was texted these while looking at the web app.)
 * `online` = their chat was open when it was pushed.
 */
async function notifySelf(user, text, { online = false } = {}) {
  if (online || !user?.phone) return { via: 'app' };
  const canPush = canPushTo(user.id);
  if (!isActive(user) && !canPush) {
    try {
      await sms.send(user.phone, text);
      recordDelivery({ fromId: user.id, toUser: user, body: text, status: 'texted', smsSentAt: now() });
      return { via: 'sms' };
    } catch (err) {
      console.error(`[deliver] self text failed user=${user.id}:`, err.message);
      return { via: 'app' };
    }
  }
  try { await push.notifyUser(db, user.id, { title: 'ButterflAI', body: text, url: '/app/chat' }); } catch (_) {}
  recordDelivery({ fromId: user.id, toUser: user, body: text, status: 'pending',
    smsDueAt: now() + (canPush ? SMS_FALLBACK_PUSH_SECS : SMS_FALLBACK_NO_PUSH_SECS) });
  return { via: 'app' };
}

/** The user opened the app: everything delivered to them so far counts as seen. */
function markSeen(userId) {
  return db._raw().prepare(`
    UPDATE deliveries SET status = 'seen', seen_at = ? WHERE to_user_id = ? AND status = 'pending'
  `).run(now(), userId).changes;
}

/**
 * Text anything still unseen past its fallback time — ONE text per sender→recipient,
 * combining their pending messages (Melanie got four separate texts, 2026-10-09).
 * Returns how many texts went out.
 */
async function tickFallback() {
  const due = db._raw().prepare(`
    SELECT DISTINCT from_user_id, to_user_id FROM deliveries WHERE status = 'pending' AND sms_due_at <= ?
  `).all(now());
  let texted = 0;
  for (const pair of due) {
    const rows = db._raw().prepare(`
      SELECT * FROM deliveries WHERE status = 'pending' AND from_user_id = ? AND to_user_id = ?
      ORDER BY created_at`).all(pair.from_user_id, pair.to_user_id);
    // Claim them first so a slow send can't be picked up twice.
    const claim = db._raw().prepare(`UPDATE deliveries SET status = 'texting' WHERE id = ? AND status = 'pending'`);
    const mine = rows.filter((d) => claim.run(d.id).changes);
    if (!mine.length) continue;
    const self = pair.from_user_id === pair.to_user_id;
    const joined = mine.map((d) => d.body).join('\n\n');
    const text = self ? joined : withSender(db.getUser(pair.from_user_id), joined);
    const mark = db._raw().prepare(`UPDATE deliveries SET status = ?, sms_sent_at = ? WHERE id = ?`);
    try {
      await sms.send(mine[0].to_phone, text);
      for (const d of mine) mark.run('texted', now(), d.id);
      texted++;
    } catch (err) {
      console.error(`[deliver] SMS fallback failed to=${pair.to_user_id}:`, err.message);
      for (const d of mine) mark.run('sms_failed', null, d.id);
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
  SMS_FALLBACK_PUSH_SECS, SMS_FALLBACK_NO_PUSH_SECS, ACTIVE_DAYS,
  withSender, deliverToContact, notifySelf, markSeen, tickFallback, startFallbackLoop,
};
