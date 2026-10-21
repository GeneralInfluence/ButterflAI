/**
 * idea-to-plan.test.js — 🐛 #45 and #47 (Sean, 2026-10-20).
 * #45: "you just made me think about connecting with her beforehand … asking me questions on something that
 * you suggested. You should know why you suggested it and that should be part of the context and it should
 * be a new event that's being created".
 * #47: "I liked the idea and wanted to run with it … I didn't want to have coffee with her specifically. I
 * just wanted to talk to her before her birthday weekend so I need to be able to get into things and edit
 * things in more detail before anything becomes final".
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'idea-to-plan-test';
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

describe('🐛 #45 / #47: Make it a plan from an idea', () => {
  test('you edit it first; the agent is told why it suggested it, that your words win, and that it\'s a new plan', async () => {
    const { cookie, user } = await login('Sean IP', '+12025350001');
    const id = uuidv4();
    db._raw().prepare(`INSERT INTO spells (id, user_id, kind, title, why, expires_at) VALUES (?, ?, 'reconnect', 'Coffee with Melanie before her birthday weekend?', 'You two have a big weekend coming — a quick catch-up first', ?)`)
      .run(id, user.id, Math.floor(Date.now() / 1000) + 86400);
    const r = await request.post('/api/plans/new').set('Cookie', cookie).send({ text: 'Talk with Melanie before her birthday weekend', spell_id: id });
    assert.equal(r.status, 200);
    assert.equal(db._raw().prepare('SELECT status FROM spells WHERE id = ?').get(id).status, 'planned', 'the idea counts as planned');
    let seen = null;
    agent._setAnthropic({ messages: { create: async (req) => {
      if (!seen) seen = req.messages.at(-1).content;
      return { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Made it.' }] };
    } } });
    await agent.tick();
    assert.match(seen, /^Talk with Melanie before her birthday weekend/);
    assert.match(seen, /This plan comes from an idea YOU \(ButterflAI\) suggested to them in Explore: "Coffee with Melanie before her birthday weekend\?" — you suggested it because: You two have a big weekend coming/);
    assert.match(seen, /don't ask them what they meant/);
    assert.match(seen, /THEIR words win/);
    assert.match(seen, /It's a NEW plan of its own/);
    assert.match(seen, /they can say no or suggest something else/);
  });
  test('someone else\'s idea id is ignored', async () => {
    const { cookie, user } = await login('Sean IP2', '+12025350002');
    const other = (await login('Other IP2', '+12025350003')).user;
    const id = uuidv4();
    db._raw().prepare(`INSERT INTO spells (id, user_id, kind, title, why, expires_at) VALUES (?, ?, 'reconnect', 'Theirs', 'x', ?)`).run(id, other.id, Math.floor(Date.now() / 1000) + 86400);
    await request.post('/api/plans/new').set('Cookie', cookie).send({ text: 'A plan', spell_id: id });
    assert.equal(db._raw().prepare('SELECT spell_id FROM inbound_messages WHERE from_id = ?').get(user.id).spell_id, null);
    assert.equal(db._raw().prepare('SELECT status FROM spells WHERE id = ?').get(id).status, 'new');
  });
  test('Explore opens ＋ New plan filled in with the idea, to change before it\'s made', () => {
    const explore = fs.readFileSync(path.join(__dirname, '../../public/app/explore.html'), 'utf8');
    const fb = fs.readFileSync(path.join(__dirname, '../../public/feedback.js'), 'utf8');
    assert.ok(explore.includes("window.bflyNewPlan(String(it.title || '')"));
    assert.ok(fb.includes('window.bflyNewPlan = ') && fb.includes('change anything before it’s made') && fb.includes('spell_id: fromSpell'));
  });
});
