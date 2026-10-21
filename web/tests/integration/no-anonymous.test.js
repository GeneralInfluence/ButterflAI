/**
 * no-anonymous.test.js — 🐛 #59 (2026-10-21). Allie: "Anonymously tell Sean he's a dork" → "Send it but don't let
 * him know it's from me"; her agent sent "Heard a rumor you're a dork 😏" and said "Sent". Sean got it as "From
 * Allie's ButterflAI" — every message names who it's from (MEMORY §10, locked) — so the promise of anonymity was
 * false. Now a message asked to be anonymous isn't sent, and the agent says why.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'no-anon-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
require('../../server');
const db = require('../../db');
const agent = require('../../agent');

let n = 0;
function mkUser(name) {
  const phone = `+1202536${String(1000 + n++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')").run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}

describe('🐛 #59: no anonymous messages', () => {
  test('Allie\'s exact words: not sent, the agent is told why, Sean gets nothing', async () => {
    const allie = mkUser('Allie A'); const sean = mkUser('Sean A');
    const cid = db.upsertContact({ invited_by_user_id: allie.id, name: 'Sean', phone: sean.phone, tier: 1 });
    db.appendConversation(allie.id, 'user', 'Anonymously tell Sean he’s a dork');
    db.appendConversation(allie.id, 'assistant', 'Want me to send it?');
    db.storeInboundMessage({ from_phone: allie.phone, from_type: 'user', from_id: allie.id, channel: 'webchat', text: 'Send it but don’t let him know it’s from me' });
    const results = [];
    let k = 0;
    agent._setAnthropic({ messages: { create: async (req) => {
      const last = req.messages.at(-1);
      if (Array.isArray(last.content)) for (const b of last.content) if (b.type === 'tool_result') results.push(String(b.content));
      return k++ === 0
        ? { id: 'a', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'send_logistics_sms', input: { contact_id: cid, message: 'Heard a rumor you\'re a dork 😏' } }] }
        : { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'It would show it’s from you — send it that way?' }] };
    } } });
    await agent.tick();
    // Since whispers (owner, 2026-10-21): an ordinary message still never goes out unnamed — the agent is pointed to send_whisper.
    assert.match(results.join(' '), /USE_SEND_WHISPER/);
    assert.match(results.join(' '), /From Allie's ButterflAI/);
    assert.equal(db._raw().prepare("SELECT count(*) n FROM conversation_history WHERE user_id = ? AND kind = 'incoming'").get(sean.id).n, 0, 'nothing reached Sean');
  });
  test('the rule is in the prompt; ordinary messages still go', () => {
    const p = agent.buildSystemPrompt({ id: 'x', name: 'Allie', phone: '+1' }, '');
    assert.match(p, /WHISPERS \(anonymous messages\)/);
    assert.match(p, /use send_whisper \(never send_logistics_sms or message_agent\)/);
  });
});

// 💌 Whispers (owner, 2026-10-21, after Allie: "The agents are supposed to be able to speak to each other anonymously.
// And say that something's generally happening or there's a general rumor.") — opt-in style, on by default, between
// people who saved each other, checked to be kind, mutable, ButterflAI keeps the sender.
describe('💌 whispers', () => {
  const whispers = require('../../whispers');
  const supertest = require('supertest');
  const request = supertest(require('../../server').app);
  const friends = (a, b) => [db.upsertContact({ invited_by_user_id: a.id, name: b.name, phone: b.phone, tier: 1 }), db.upsertContact({ invited_by_user_id: b.id, name: a.name, phone: a.phone, tier: 1 })];
  const got = (u) => db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND kind = 'whisper' ORDER BY rowid").all(u.id).map((r) => r.text);
  const checker = (verdict) => whispers._setClient({ messages: { create: async () => ({ content: [{ type: 'text', text: verdict }] }) } });
  async function cookieFor(u) {
    await request.post('/auth/otp/send').send({ phone: u.phone });
    const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
    return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
  }

  test('Allie\'s rumor reaches Sean as "Someone close to you says…" — no name anywhere he can see — and Sean can answer it', async () => {
    const allie = mkUser('Allie W'); const sean = mkUser('Sean W');
    const [toSean] = friends(allie, sean);
    checker('OK');
    const r = await whispers.send(allie.id, toSean, 'Heard a rumor you\'re a dork 😏');
    assert.equal(r.action_status, 'WHISPER_SENT');
    assert.match(r.note, /ButterflAI keeps who sent it/);
    const seen = got(sean);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^💌 Someone close to you says: “Heard a rumor you're a dork 😏”/);
    assert.ok(!/Allie/.test(seen[0]));
    const back = await whispers.reply(sean.id, 'Takes one to know one');
    assert.equal(back.action_status, 'REPLY_SENT');
    assert.match(got(allie)[0], /💌 Sean answered your whisper/);
    assert.ok(!got(sean).some((t) => /Allie/.test(t)), 'Sean never learns who');
  });
  test('only kind or playful; only between people who saved each other; not over the limit', async () => {
    const a = mkUser('Ann W'); const b = mkUser('Bo W'); const c = mkUser('Cy W');
    const [toB] = friends(a, b);
    const toC = db.upsertContact({ invited_by_user_id: a.id, name: c.name, phone: c.phone, tier: 1 });   // C hasn't saved A
    checker('NOT_OK');
    assert.equal((await whispers.send(a.id, toB, 'everyone hates you')).error, 'UNKIND');
    assert.equal(got(b).length, 0);
    checker('OK');
    assert.equal((await whispers.send(a.id, toC, 'hi')).error, 'NOT_CLOSE');
    assert.ok((await whispers.send(a.id, toB, 'you rock')).ok);
    assert.ok((await whispers.send(a.id, toB, 'seriously, you rock')).ok);
    assert.equal((await whispers.send(a.id, toB, 'third one')).error, 'ENOUGH');
    whispers._setClient(null);
    assert.equal((await whispers.send(b.id, friends(b, mkUser('Dee W'))[0], 'hey')).error, 'TRY_LATER', 'no check, no whisper');
  });
  test('turned off, muted (without learning who), or on an avoid list: "couldn\'t be sent" — never why', async () => {
    const a = mkUser('Al X'); const b = mkUser('Bea X'); const julie = mkUser('Julie X');
    const [toB] = friends(a, b);
    const [toBfromJ] = friends(julie, b);
    checker('OK');
    const c = await cookieFor(b);
    await request.post('/api/whispers/settings').set('Cookie', c).send({ off: true });
    assert.equal((await whispers.send(a.id, toB, 'hi')).message, 'That whisper couldn’t be sent.');
    await request.post('/api/whispers/settings').set('Cookie', c).send({ off: false });
    assert.ok((await whispers.send(a.id, toB, 'hi there')).ok);
    assert.match(whispers.muteLatest(b.id).message, /You still won’t know who/);
    assert.equal((await whispers.send(a.id, toB, 'again')).error, 'NOT_SENT');
    assert.equal((await request.get('/api/whispers/settings').set('Cookie', c)).body.muted, 1);
    require('../../avoid').addAvoid(b.id, db._raw().prepare('SELECT id FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(b.id, julie.phone).id);
    assert.equal((await whispers.send(julie.id, toBfromJ, 'hey you')).message, 'That whisper couldn’t be sent.');
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/settings.html'), 'utf8');
    assert.ok(html.includes('id="whispers-toggle" checked') && html.includes('Friends can send me whispers'));
  });
});
