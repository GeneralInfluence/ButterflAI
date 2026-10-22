/**
 * private-paused.test.js — 🐛 #87 (owner, 2026-10-22): "I don't think we can have private information in the app right
 * now … I just don't believe I can promise the information won't leak somehow." → Pause it: ButterflAI takes no
 * sensitive information, says why, and private mode can't be turned on. The code stays for after a security review
 * (PRIVATE_INFO=on — the tests of that code set it). Avoid lists keep working.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'private-paused-test';
delete process.env.PRIVATE_INFO;
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
const sensitive = require('../../sensitive');

let n = 0;
function mkUser(name) {
  const phone = `+1202542${String(1000 + n++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')").run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
const stored = (u) => db._raw().prepare('SELECT count(*) n FROM user_private_data WHERE user_id = ?').get(u.id).n;

describe('🐛 #87: private information is paused', () => {
  test('nothing sensitive is stored; private mode can\'t be turned on', async () => {
    const u = mkUser('Sean Q');
    assert.equal(sensitive.paused(), true);
    assert.equal(sensitive.storePrivateData(u.id, 'health.sti_status', 'negative', 'HEALTH').error, 'PRIVATE_INFO_PAUSED');
    sensitive.setSensitiveMode(u.id, true);
    assert.equal(sensitive.isSensitiveMode(u.id), false);
    const c = await cookieFor(u);
    assert.equal((await request.post('/api/chat/sensitive-mode').set('Cookie', c).send({ on: true })).status, 409);
    assert.deepEqual((await request.get('/api/chat/sensitive-mode').set('Cookie', c)).body, { sensitive_mode: false, paused: true });
    assert.equal(stored(u), 0);
  });
  test('a turn: "my STI results came back negative, remember that" — nothing kept, the agent is told to say why', async () => {
    const u = mkUser('Sean T');
    db._raw().prepare('UPDATE inbound_messages SET processed = 1').run();
    db.storeInboundMessage({ from_phone: u.phone, from_type: 'user', from_id: u.id, channel: 'webchat', text: 'my STI results came back negative, remember that' });
    const results = []; let tools = null; let system = '';
    let k = 0;
    agent._setAnthropic({ messages: { create: async (req) => {
      tools = tools || req.tools.map((t) => t.name); system = req.system;
      const last = req.messages.at(-1);
      if (Array.isArray(last.content)) for (const b of last.content) if (b.type === 'tool_result') results.push(String(b.content));
      return k++ === 0
        ? { id: 'a', stop_reason: 'tool_use', content: [
          { type: 'tool_use', id: 't1', name: 'store_private_data', input: { data_key: 'health.sti_status', value: 'negative', category: 'HEALTH' } },
          { type: 'tool_use', id: 't2', name: 'update_preferences', input: { health_safety_notes: 'STI tests negative' } },
          { type: 'tool_use', id: 't3', name: 'update_preferences', input: { extra_notes: 'STI test results negative' } }] }
        : { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'I can’t promise that stays secure yet, so I don’t keep things like that.' }] };
    } } });
    await agent.tick();
    for (const t of ['store_private_data', 'get_private_preferences', 'request_private_sharing', 'revoke_private_sharing']) assert.ok(!tools.includes(t), `${t} isn't offered`);
    assert.ok(tools.includes('manage_avoid_list'), 'avoid lists still work');
    assert.match(JSON.stringify(system), /PRIVATE INFORMATION IS PAUSED/);
    assert.equal(results.filter((r) => /PRIVATE_INFO_PAUSED/.test(r)).length, 3, results.join('\n'));
    assert.equal(stored(u), 0);
    const prefs = db._raw().prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(u.id);
    assert.ok(!JSON.stringify(prefs || {}).includes('STI'), 'not in plain preferences either');
  });
  test('the app shows it honestly: no 🔒 Private button, Settings says why', () => {
    const chat = fs.readFileSync(path.join(__dirname, '../../public/app/chat.html'), 'utf8');
    assert.match(chat, /if \(d && d\.paused\) \{ const b = document\.getElementById\('private-btn'\); if \(b\) b\.hidden = true; \}/);
    const settings = fs.readFileSync(path.join(__dirname, '../../public/app/settings.html'), 'utf8');
    assert.match(settings, /ButterflAI isn’t keeping sensitive information right now[\s\S]*Avoid list<\/strong> still works/);
    assert.match(settings, /\['health-block', 'sharing-section'\]/);
  });
});
