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
    assert.ok(texts.some((t) => t.to === sean.phone && t.body === "Allie's ButterflAI: Wings at 8?"));
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
