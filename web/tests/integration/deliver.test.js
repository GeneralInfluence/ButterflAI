/**
 * deliver.test.js — agents message people in the app first; SMS only as a fallback.
 *
 * Owner decision (2026-10-06): things go through the agents; people must know who a
 * message is from; SMS (costs money) only if the recipient couldn't reasonably have seen
 * it in the app. Prompted by Sean getting an unattributed text from Allie's agent.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'deliver-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
const texts = [];
sms._setClient({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' + texts.length }; } } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const deliver = require('../../deliver');
const sse = require('../../sse');

function mkUser(phone, name) {
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/New_York')`)
    .run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const contactOf = (owner, p) => db.upsertContact({ invited_by_user_id: owner.id, name: p.name, phone: p.phone, tier: 1 });
const history = (u) => db._raw().prepare('SELECT role, text, kind FROM conversation_history WHERE user_id = ? ORDER BY rowid').all(u.id);
const delivery = (id) => db._raw().prepare('SELECT * FROM deliveries WHERE id = ?').get(id);
const ago = (secs) => (id) => db._raw().prepare('UPDATE deliveries SET sms_due_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - secs, id);

async function cookieFor(phone) {
  await request.post('/auth/otp/send').send({ phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(phone);
  return (await request.post('/auth/otp/verify').send({ phone, code })).headers['set-cookie'][0];
}

describe('message to a ButterflAI user', () => {
  let allie, sean, seanAtAllie;
  before(() => {
    allie = mkUser('+12025559401', 'Allie McLaine');
    sean = mkUser('+12025559402', 'Sean Gonzalez');
    seanAtAllie = contactOf(allie, sean);
    // Sean uses the app (opened it today). Since 2026-10-09, someone who hasn't used the
    // app in 14 days and can't get push is texted right away instead — tested below.
    db._raw().prepare('UPDATE users SET last_active_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), sean.id);
    sean = db.getUser(sean.id);
  });

  test('arrives in the app as a labelled card, not a text; sender gets a "To" card', async () => {
    texts.length = 0;
    const r = await agent.executeTool('send_logistics_sms', { contact_id: seanAtAllie, message: "Let's go have some fun tonight!" }, allie.id, allie.phone);
    assert.equal(r.sent, true);
    assert.equal(r.delivered_via, 'app');
    assert.equal(texts.length, 0, 'no SMS');
    assert.deepEqual(history(sean).at(-1), { role: 'assistant', text: "💬 From Allie's ButterflAI: Let's go have some fun tonight!", kind: 'incoming' });
    assert.deepEqual(history(allie).at(-1), { role: 'assistant', text: "📤 To Sean Gonzalez (in ButterflAI): Let's go have some fun tonight!", kind: 'outgoing' });
    assert.equal(delivery(r.delivery_id).status, 'pending');
  });

  test('no push subscription: texted (with sender) if unseen after the short wait', async () => {
    texts.length = 0;
    const r = await deliver.deliverToContact({ fromUser: allie, contact: db.getContact(seanAtAllie), message: 'Wings at 8?' });
    const d = delivery(r.delivery_id);
    assert.ok(d.sms_due_at - d.created_at <= deliver.SMS_FALLBACK_NO_PUSH_SECS + 1);
    assert.equal(await deliver.tickFallback(), 0, 'not due yet → nothing texted');
    ago(1)(r.delivery_id);
    await deliver.tickFallback();
    // Since 2026-10-09 pending messages from the same sender go out as ONE text, so the
    // earlier unseen message (previous test) is combined into this one.
    const toSean = texts.filter((t) => t.to === sean.phone);
    assert.equal(toSean.length, 1, 'one combined text');
    assert.ok(toSean[0].body.startsWith("Allie's ButterflAI: ") && toSean[0].body.endsWith('Wings at 8?'));
    assert.equal(delivery(r.delivery_id).status, 'texted');
  });

  test('with push notifications: waits the long window', async () => {
    db._raw().prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)`)
      .run(uuidv4(), sean.id, 'https://push.example/x', 'p', 'a');
    const r = await deliver.deliverToContact({ fromUser: allie, contact: db.getContact(seanAtAllie), message: 'Still on?' });
    const d = delivery(r.delivery_id);
    assert.ok(d.sms_due_at - d.created_at >= deliver.SMS_FALLBACK_PUSH_SECS - 1);
  });

  test('opening the chat marks it seen — never texted', async () => {
    texts.length = 0;
    const r = await deliver.deliverToContact({ fromUser: allie, contact: db.getContact(seanAtAllie), message: 'See you there' });
    const cookie = await cookieFor(sean.phone);
    const view = await request.get('/api/chat/messages').set('Cookie', cookie);
    assert.ok(view.body.messages.some((m) => m.kind === 'incoming' && m.text.includes('See you there')), 'card returned with its kind');
    assert.equal(delivery(r.delivery_id).status, 'seen');
    ago(1)(r.delivery_id);
    await deliver.tickFallback();
    assert.ok(!texts.some((t) => t.body.includes('See you there')));
  });

  test('recipient live in the app at delivery: seen immediately, no SMS scheduled', async () => {
    const res = { setHeader() {}, flushHeaders() {}, write() { return true; }, on() {}, end() {} };
    sse.register(sean.id, res);
    try {
      const r = await deliver.deliverToContact({ fromUser: allie, contact: db.getContact(seanAtAllie), message: 'Live one' });
      assert.equal(r.recipient_online, true);
      assert.equal(delivery(r.delivery_id).status, 'seen');
      assert.equal(delivery(r.delivery_id).sms_due_at, null);
    } finally { sse.unregister(sean.id); }
  });

  test('an SMS opt-out does not block in-app delivery', async () => {
    db.recordOptOut ? db.recordOptOut(sean.phone) : db._raw().prepare(`INSERT INTO sms_optouts (phone) VALUES (?)`).run(sean.phone);
    const r = await agent.executeTool('send_logistics_sms', { contact_id: seanAtAllie, message: 'In-app still works' }, allie.id, allie.phone);
    assert.equal(r.delivered_via, 'app');
  });
});

describe('message to someone not on ButterflAI', () => {
  test('texted right away, with the sender named', async () => {
    const host = mkUser('+12025559410', 'Nate Host');
    const friendPhone = '+12025559411';
    db.writeConsent(friendPhone, 'INVITE_PAGE');
    const friend = contactOf(host, { name: 'Pat Friend', phone: friendPhone });
    texts.length = 0;
    const r = await agent.executeTool('send_logistics_sms', { contact_id: friend, message: 'Trivia Thursday?' }, host.id, host.phone);
    assert.equal(r.delivered_via, 'sms');
    assert.deepEqual(texts.map((t) => [t.to, t.body]), [[friendPhone, "Nate's ButterflAI: Trivia Thursday?"]]);
    assert.equal(history(host).at(-1).text, '📤 To Pat Friend (by text): Trivia Thursday?');
  });
});

// Rules added 2026-10-09 (Melanie: inactive since June; "text her now"; four separate
// texts; Sean texted about his own agent's updates while in the web app — feedback #6).
describe('texting rules (2026-10-09)', () => {
  const setActive = (u, secsAgo) => db._raw().prepare('UPDATE users SET last_active_at = ? WHERE id = ?').run(secsAgo == null ? null : Math.floor(Date.now() / 1000) - secsAgo, u.id);

  test('recipient not using the app and no push → texted right away (card still in their chat)', async () => {
    const sean2 = mkUser('+12025559420', 'Sean Two');
    const melanie = mkUser('+12025559421', 'Melanie Noel');
    setActive(melanie, 200 * 86400);
    texts.length = 0;
    const r = await deliver.deliverToContact({ fromUser: sean2, contact: db.getContact(contactOf(sean2, melanie)), message: 'Log in at https://butterflai.social/app/login' });
    assert.equal(r.delivered_via, 'sms');
    assert.deepEqual(texts.map((t) => t.body), ["Sean's ButterflAI: Log in at https://butterflai.social/app/login"]);
    assert.equal(history(melanie).at(-1).kind, 'incoming');
  });

  test('"text her now" (forceText) → texted immediately even if she uses the app', async () => {
    const a = mkUser('+12025559422', 'Asker');
    const b = mkUser('+12025559423', 'Active Bee');
    setActive(b, 60);
    texts.length = 0;
    const r = await deliver.deliverToContact({ fromUser: a, contact: db.getContact(contactOf(a, b)), message: 'Call me', forceText: true });
    assert.equal(r.delivered_via, 'sms');
    assert.equal(texts.length, 1);
  });

  test("the agent honours the user's own words: 'Text her now' → sent by text", async () => {
    const u = mkUser('+12025559424', 'Worder');
    const her = mkUser('+12025559425', 'Herself');
    setActive(her, 60);
    const herId = contactOf(u, her);
    let i = 0;
    agent._setAnthropic({ messages: { create: async () => (i++ === 0
      ? { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'send_logistics_sms', input: { contact_id: herId, message: 'Here is the login: https://butterflai.social/app/login' } }] }
      : { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Texted her.' }] }) } });
    texts.length = 0;
    db.storeInboundMessage({ from_phone: u.phone, from_type: 'user', from_id: u.id, channel: 'webchat', text: 'Text her now' });
    await agent.tick();
    assert.ok(texts.some((t) => t.to === her.phone && t.body.includes('/app/login')), 'texted, not in-app-with-wait');
  });

  test("the agent's own updates: no text while you're in the app; pending fallback otherwise", async () => {
    const u = mkUser('+12025559426', 'Selfy');
    setActive(u, 60);
    texts.length = 0;
    assert.deepEqual(await deliver.notifySelf(u, 'Allie is in!', { online: true }), { via: 'app' });
    assert.equal(texts.length, 0);
    await deliver.notifySelf(db.getUser(u.id), 'Allie is in!', { online: false });
    assert.equal(texts.length, 0, 'active user → wait in the app, not an immediate text');
    const pending = db._raw().prepare(`SELECT * FROM deliveries WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'`).get(u.id, u.id);
    assert.ok(pending, 'fallback scheduled');
    db._raw().prepare('UPDATE deliveries SET sms_due_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, pending.id);
    await deliver.tickFallback();
    assert.deepEqual(texts.map((t) => t.body), ['Allie is in!'], 'own updates have no "X\'s ButterflAI" prefix');
  });
});
