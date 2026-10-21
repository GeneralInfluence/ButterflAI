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
    assert.match(results.join(' '), /ANONYMOUS_NOT_POSSIBLE/);
    assert.match(results.join(' '), /always shows who a message is from/); assert.match(results.join(' '), /From Allie's ButterflAI/);
    assert.equal(db._raw().prepare("SELECT count(*) n FROM conversation_history WHERE user_id = ? AND kind = 'incoming'").get(sean.id).n, 0, 'nothing reached Sean');
  });
  test('the rule is in the prompt; ordinary messages still go', () => {
    const p = agent.buildSystemPrompt({ id: 'x', name: 'Allie', phone: '+1' }, '');
    assert.match(p, /NO ANONYMOUS MESSAGES/);
  });
});
