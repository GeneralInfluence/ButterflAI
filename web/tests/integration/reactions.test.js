/**
 * reactions.test.js — 🐛 #81 (Sean, 2026-10-21): "It's awesome that Alex responded and said she's going. I'd like to be
 * able to just heart something or do an emoji reaction." A message from or about a friend can take a reaction; it
 * reaches them once, in the app.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'reactions-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const supertest = require('supertest');

require('../../sms')._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const deliver = require('../../deliver');
const reactions = require('../../reactions');

let n = 0;
function mkUser(name) {
  const phone = `+1202540${String(1000 + n++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', 1700000000)").run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
const notices = (u) => db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND kind = 'notice' ORDER BY rowid").all(u.id).map((r) => r.text);

describe('🐛 #81: ❤️ reactions', () => {
  test('Alex says yes → Sean\'s ButterflAI tells him → Sean ❤️s it → Alex gets "❤️ Sean loved your yes for Rocky Horror Picture Show", once', async () => {
    const sean = mkUser('Sean Gonzalez'); const alex = mkUser('Alexandria Spargo');
    db.upsertContact({ invited_by_user_id: alex.id, name: 'Sean', phone: sean.phone, tier: 1 });
    require('../../multiparty').queueHostRsvpNotice({ id: null, title: 'Rocky Horror Picture Show', scheduled_at: Math.floor(Date.now() / 1000) + 86400, host_user_id: sean.id }, alex, 'accepted');
    agent._setAnthropic({ messages: { create: async () => ({ id: 'r', stop_reason: 'end_turn', content: [{ type: 'text', text: '✅ Alexandria is going to Rocky Horror Picture Show!' }] }) } });
    await agent.tick();
    const cookie = await cookieFor(sean);
    const msgs = (await request.get('/api/chat/messages').set('Cookie', cookie)).body.messages;
    const m = msgs.find((x) => /Alexandria is going/.test(x.text));
    assert.equal(m.can_react, true);
    assert.equal(msgs.find((x) => x.role === 'user')?.can_react, undefined);
    const r = await request.post(`/api/chat/messages/${m.id}/react`).set('Cookie', cookie).send({ emoji: '❤️' });
    assert.equal(r.body.reaction, '❤️');
    assert.deepEqual(notices(alex), ['❤️ Sean loved your yes for Rocky Horror Picture Show']);
    await request.post(`/api/chat/messages/${m.id}/react`).set('Cookie', cookie).send({ emoji: '🎉' });
    assert.equal(notices(alex).length, 1, 'changing it isn\'t sent again');
    const again = (await request.get('/api/chat/messages').set('Cookie', cookie)).body.messages.find((x) => x.id === m.id);
    assert.equal(again.reaction, '🎉');
  });
  test('a message from a friend\'s ButterflAI can be reacted to; it reaches the sender', async () => {
    const allie = mkUser('Allie R'); const sean = mkUser('Sean R');
    const cid = db.upsertContact({ invited_by_user_id: allie.id, name: 'Sean', phone: sean.phone, tier: 1 });
    db.upsertContact({ invited_by_user_id: sean.id, name: 'Allie', phone: allie.phone, tier: 1 });
    await deliver.deliverToContact({ fromUser: allie, contact: db.getContact(cid), message: 'Want to grab lunch Thursday?' });
    const row = db._raw().prepare("SELECT id FROM conversation_history WHERE user_id = ? AND kind = 'incoming'").get(sean.id);
    assert.equal(reactions.react(sean.id, row.id, '👍').ok, true);
    assert.deepEqual(notices(allie), ['👍 Sean liked your message: “Want to grab lunch Thursday?”']);
  });
  test('only your own messages, only ones about someone, only these emoji; avoid lists stop it quietly', () => {
    const a = mkUser('A R'); const b = mkUser('B R');
    const id = db.appendConversation(a.id, 'assistant', 'hi');
    assert.equal(reactions.react(a.id, id, '❤️').error, 'NOBODY_TO_REACH');
    reactions.markAbout(id, b.id, 'your message');
    assert.equal(reactions.react(b.id, id, '❤️').error, 'NOT_FOUND');
    assert.equal(reactions.react(a.id, id, '💩').error, 'BAD_EMOJI');
    require('../../avoid').addAvoid(b.id, db.upsertContact({ invited_by_user_id: b.id, name: 'A', phone: a.phone, tier: 1 }));
    assert.equal(reactions.react(a.id, id, '❤️').ok, true);
    assert.deepEqual(notices(b), [], 'someone who avoids you never hears it');
  });
  test('chat shows a ♡ on those messages', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../public/app/chat.html'), 'utf8');
    assert.match(html, /const REACTIONS = \['❤️', '👍', '😂', '🎉', '😮'\]/);
    assert.match(html, /react\.can_react && react\.id\) renderReaction/);
  });
  test('retro: recent messages from friends can take a ❤️ too (sender found from the delivery)', async () => {
    const allie = mkUser('Allie O'); const sean = mkUser('Sean O');
    const t = Math.floor(Date.now() / 1000) - 3600;
    const id = uuidv4();
    db._raw().prepare("INSERT INTO conversation_history (id, user_id, role, text, kind, created_at) VALUES (?, ?, 'assistant', ?, 'incoming', ?)").run(id, sean.id, "💬 From Allie's ButterflAI: Lunch at noon?", t);
    db._raw().prepare("INSERT INTO deliveries (id, from_user_id, to_user_id, to_phone, body, status, created_at) VALUES (?, ?, ?, ?, 'Lunch at noon?', 'seen', ?)").run(uuidv4(), allie.id, sean.id, sean.phone, t);
    assert.equal(await require('../../retro').TASKS.find((x) => x.id === '2026-10-22-reactions-on-recent-messages').run(sean), 'marked 1');
    assert.equal(reactions.react(sean.id, id, '❤️').ok, true);
    assert.deepEqual(notices(allie), ['❤️ Sean loved your message: “Lunch at noon?”']);
  });
});
