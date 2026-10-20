/**
 * new-plan.test.js — 🐛 #34 (Sean, 2026-10-20): "I don't see an easy way to create a new event …
 * next to the feedback caterpillar … a plus … so I can create something new without having to go
 * to the chat and have a long discussion, and … there should be some prompt to the AI where it
 * understands that I've hit that button and I'm trying to do that specific kind of task."
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'new-plan-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');
const fs = require('node:fs'), path = require('node:path');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');

async function login(name, phone) {
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')").run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  await request.post('/auth/otp/send').send({ phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(phone);
  return { cookie: (await request.post('/auth/otp/verify').send({ phone, code })).headers['set-cookie'][0], user: db.getUserByPhone(phone) };
}

describe('🐛 #34: ＋ New plan', () => {
  test('the agent is told the user tapped ＋ New plan, and creates it — no routing guess, no long discussion', async () => {
    const { cookie, user } = await login('Sean NP', '+12025330001');
    const r = await request.post('/api/plans/new').set('Cookie', cookie).send({ text: 'Dinner with Allie next Friday' });
    assert.equal(r.status, 200);
    const row = db._raw().prepare("SELECT intent, channel FROM inbound_messages WHERE from_id = ? ORDER BY rowid DESC").get(user.id);
    assert.deepEqual([row.intent, row.channel], ['new_plan', 'webchat']);
    let seen = null;
    agent._setAnthropic({ messages: { create: async (req) => {
      if (!seen) {
        seen = req.messages.at(-1).content;
        return { id: 'a', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'create_social_event', input: { title: 'Dinner with Allie', activity_type: 'dinner', tentative: true } }] };
      }
      return { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Made "Dinner with Allie" — date TBD.' }] };
    } } });
    await agent.tick();
    assert.match(seen, /^Dinner with Allie next Friday\n\n\[ButterflAI — not from the user\] Your user tapped ＋ New plan/);
    assert.ok(db._raw().prepare("SELECT 1 FROM social_events WHERE host_user_id = ? AND title = 'Dinner with Allie'").get(user.id));
    const d = (await request.get('/api/chat/discussions').set('Cookie', cookie)).body.discussions.find((x) => x.title === 'Dinner with Allie');
    assert.ok(d.mine && d.created_at > 0, 'the chat can find the plan it just made');
  });
  test('empty text is refused; signed-out is refused', async () => {
    const { cookie } = await login('Sean NP2', '+12025330002');
    assert.equal((await request.post('/api/plans/new').set('Cookie', cookie).send({ text: '  ' })).status, 400);
    assert.notEqual((await request.post('/api/plans/new').send({ text: 'x' })).status, 200);
  });
  test('＋ sits with 🐛 in one pill on every screen; the sheet has starters; the chat opens the new plan', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../public/feedback.js'), 'utf8');
    assert.ok(js.includes("side.append(plus, tab);") && js.includes("plus.textContent = '＋'") && js.includes("<h3>What's the plan?</h3>"));
    assert.ok(js.includes("fetch('/api/plans/new'") && js.includes("location.href = '/app/chat?new='"));
    const chat = fs.readFileSync(path.join(__dirname, '../../public/app/chat.html'), 'utf8');
    assert.ok(chat.includes("d.mine && d.created_at >= newPlanSince - 5") && chat.includes("location.replace('/app/chat?event=' + encodeURIComponent(fresh.event_id))"));
  });
});
