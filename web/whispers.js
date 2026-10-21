/**
 * whispers.js — 💌 a message to a friend without your name on it (owner, 2026-10-21, after Allie asked her agent to
 * "anonymously tell Sean he's a dork": "The agents are supposed to be able to speak to each other anonymously. And say
 * that something's generally happening or there's a general rumor.").
 *
 * Every other message says who it's from (MEMORY §10). A whisper is the one exception, with the owner's choices:
 *  - only between people who have each other saved (never from a stranger);
 *  - on unless the receiver turns whispers off (Settings), and they can mute whoever sent one without learning who;
 *  - checked to be kind or playful first — an unkind one isn't sent, and the sender is told;
 *  - at most 2 a day to the same person, 5 a day in all;
 *  - shown in the app only ("💌 Someone close to you says: …", never a text); the receiver can answer it through
 *    their ButterflAI, still without knowing who it was;
 *  - ButterflAI keeps who sent each one (so abuse can be stopped); the sender is told that.
 * Avoid lists apply both ways — and say only "couldn't be sent", never why.
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { createAnthropicClient, DEFAULT_MODEL } = require('./anthropic-client');

const PER_PAIR_DAY = 2;
const PER_DAY = 5;
const now = () => Math.floor(Date.now() / 1000);
const clean = (t, n = 500) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);

let _client = null;
let _enabled = process.env.NODE_ENV !== 'test';
function _setClient(c) { _client = c; _enabled = !!c; }
function client() {
  if (!_enabled) return null;
  if (!_client) { try { _client = createAnthropicClient(); } catch (_) { _enabled = false; return null; } }
  return _client;
}

/** Kind or playful? (fails closed: no check, no whisper) */
async function kind(text) {
  const c = client();
  if (!c) return { ok: false, why: 'CHECK_UNAVAILABLE' };
  try {
    const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: 60, messages: [{ role: 'user', content:
      `An anonymous note one friend wants to send another through an app: "${clean(text)}"\nIs it kind, warm or playful teasing between friends (OK), or could it hurt, scare, threaten, shame, harass or reveal something private about someone (NOT OK)? Reply with one word: OK or NOT_OK.` }] });
    const t = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').toUpperCase();
    return /NOT_OK/.test(t) ? { ok: false, why: 'UNKIND' } : /\bOK\b/.test(t) ? { ok: true } : { ok: false, why: 'CHECK_UNAVAILABLE' };
  } catch (_) { return { ok: false, why: 'CHECK_UNAVAILABLE' }; }
}

function savedEach(a, b) {
  const has = (o, u) => !!(u?.phone && db._raw().prepare('SELECT 1 FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(o.id, u.phone));
  return has(a, b) && has(b, a);
}
function avoided(a, b) {
  try {
    const avoid = require('./avoid');
    const list = (u) => avoid.listAvoid(u.id, { accessor: 'whispers', context: 'whisper (never shown)' });
    return !!(avoid.findByPhone(list(a), b.phone) || avoid.findByPhone(list(b), a.phone));
  } catch (_) { return true; }
}
const isOff = (userId) => !!db._raw().prepare('SELECT off FROM whisper_settings WHERE user_id = ?').get(userId)?.off;
const muted = (userId, fromId) => !!db._raw().prepare('SELECT 1 FROM whisper_mutes WHERE user_id = ? AND muted_from = ?').get(userId, fromId);

function deliver(toId, text, url = '/app/chat') {
  db._raw().prepare("INSERT INTO conversation_history (id, user_id, role, text, kind) VALUES (?, ?, 'assistant', ?, 'whisper')").run(uuidv4(), toId, text);
  const online = require('./sse').push(toId, { role: 'assistant', kind: 'whisper', text, ts: now() });
  if (!online) require('./push').notifyUser(db, toId, { title: 'ButterflAI', body: text, url }).catch(() => {});
}

/** Send a whisper to one of your contacts. */
async function send(fromId, contactId, text) {
  const from = db.getUser(fromId);
  const c = db._raw().prepare('SELECT * FROM contacts WHERE id = ? AND invited_by_user_id = ?').get(contactId, fromId);
  const to = c?.phone ? db.getUserByPhone(c.phone) : null;
  const body = clean(text);
  if (!body) return { error: 'EMPTY' };
  if (!c) return { error: 'NOT_FOUND' };
  if (!to) return { error: 'NOT_ON_BUTTERFLAI', message: `${c.name} isn't on ButterflAI — a whisper only reaches someone in the app.` };
  if (!savedEach(from, to)) return { error: 'NOT_CLOSE', message: `Whispers go only between people who have each other saved — ${c.name} doesn't have your number saved in ButterflAI.` };
  if (isOff(to.id) || muted(to.id, fromId) || avoided(from, to)) return { error: 'NOT_SENT', message: 'That whisper couldn’t be sent.' };
  const t = now() - 86400;
  if (db._raw().prepare("SELECT count(*) n FROM whispers WHERE from_user = ? AND to_user = ? AND status = 'sent' AND created_at > ?").get(fromId, to.id, t).n >= PER_PAIR_DAY) return { error: 'ENOUGH', message: `That's enough whispers to ${c.name} for today.` };
  if (db._raw().prepare("SELECT count(*) n FROM whispers WHERE from_user = ? AND status = 'sent' AND created_at > ?").get(fromId, t).n >= PER_DAY) return { error: 'ENOUGH', message: 'That’s enough whispers for today.' };
  const k = await kind(body);
  if (!k.ok) {
    db._raw().prepare("INSERT INTO whispers (id, from_user, to_user, text, status) VALUES (?, ?, ?, ?, 'blocked')").run(uuidv4(), fromId, to.id, body);
    return k.why === 'UNKIND'
      ? { error: 'UNKIND', message: 'Not sent — whispers are for kind or playful things. Say it with your name, or say something nicer.' }
      : { error: 'TRY_LATER', message: 'Couldn’t check that whisper right now — try again in a bit.' };
  }
  const id = uuidv4();
  db._raw().prepare('INSERT INTO whispers (id, from_user, to_user, text) VALUES (?, ?, ?, ?)').run(id, fromId, to.id, body);
  deliver(to.id, `💌 Someone close to you says: “${body}” (Answer it by telling me — they won’t learn it’s you either way.)`);
  return { ok: true, action_status: 'WHISPER_SENT', whisper_id: id,
    note: `Sent without your name — ${c.name} sees "Someone close to you says…". ButterflAI keeps who sent it, so it can stop anyone using whispers to be mean.` };
}

/** Answer the latest whisper you got (3 days) — or one by id. The sender learns who answered; you never learn who sent it. */
async function reply(userId, text, { whisperId = null } = {}) {
  const w = whisperId
    ? db._raw().prepare("SELECT * FROM whispers WHERE id = ? AND to_user = ? AND status = 'sent'").get(whisperId, userId)
    : db._raw().prepare("SELECT * FROM whispers WHERE to_user = ? AND status = 'sent' AND created_at > ? ORDER BY created_at DESC LIMIT 1").get(userId, now() - 3 * 86400);
  if (!w) return { error: 'NO_WHISPER', message: 'No whisper to answer.' };
  const body = clean(text);
  if (!body) return { error: 'EMPTY' };
  const me = db.getUser(userId);
  const name = require('./people').nameFor(w.from_user, userId, { first: true });
  db._raw().prepare("INSERT INTO whispers (id, from_user, to_user, text, reply_to, status) VALUES (?, ?, ?, ?, ?, 'reply')").run(uuidv4(), userId, w.from_user, body, w.id);
  deliver(w.from_user, `💌 ${name} answered your whisper (“${clean(w.text, 80)}”): “${body}”`);
  void me;
  return { ok: true, action_status: 'REPLY_SENT', note: 'Answered — they’ll see it’s from you; you still won’t know who sent the whisper.' };
}

/** Mute whoever sent your latest whisper (without learning who). */
function muteLatest(userId) {
  const w = db._raw().prepare("SELECT from_user FROM whispers WHERE to_user = ? AND status = 'sent' ORDER BY created_at DESC LIMIT 1").get(userId);
  if (!w) return { error: 'NO_WHISPER' };
  db._raw().prepare('INSERT OR IGNORE INTO whisper_mutes (user_id, muted_from) VALUES (?, ?)').run(userId, w.from_user);
  return { ok: true, message: 'Muted — no more whispers from whoever sent that one. (You still won’t know who.)' };
}
function settings(userId) {
  return { off: isOff(userId), muted: db._raw().prepare('SELECT count(*) n FROM whisper_mutes WHERE user_id = ?').get(userId).n };
}
function setOff(userId, off) {
  db._raw().prepare('INSERT INTO whisper_settings (user_id, off) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET off = excluded.off').run(userId, off ? 1 : 0);
  return settings(userId);
}
function unmuteAll(userId) { db._raw().prepare('DELETE FROM whisper_mutes WHERE user_id = ?').run(userId); return settings(userId); }

module.exports = { send, reply, muteLatest, settings, setOff, unmuteAll, kind, PER_PAIR_DAY, PER_DAY, _setClient };
