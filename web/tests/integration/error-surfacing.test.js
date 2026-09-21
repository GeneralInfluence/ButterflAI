/**
 * error-surfacing.test.js — Phase A #6: no silent failures.
 *
 * When an agent turn throws (e.g. the model is unreachable), the user must get a
 * visible reply on THEIR channel — never silence — and the message must be marked
 * processed so it doesn't retry forever. This drives the real tick() error path with
 * a model client forced to fail.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.ANTHROPIC_API_KEY;

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
const sent = [];
sms._setClient({ messages: { create({ to, body }) { sent.push({ to, body }); return Promise.resolve({ sid: 'SM' + sent.length }); } } });

const db    = require('../../db');
const agent = require('../../agent');
// Force every model call to fail, deterministically — simulates an outage / bad key.
agent._setAnthropic({ messages: { create() { return Promise.reject(new Error('simulated model outage')); } } });

function mkUser(phone, name) {
  const id = uuidv4();
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/New_York')`).run(id, name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}

describe('error surfacing — no silent failures', () => {
  test('a failed SMS turn replies with a visible snag and marks the message processed', async () => {
    const u = mkUser('+12025558801', 'Snag User');
    db.storeInboundMessage({ from_phone: u.phone, from_type: 'user', from_id: u.id, channel: 'sms', text: 'plan something' });

    const before = sent.length;
    await agent.tick();

    const replies = sent.slice(before).filter(m => m.to === u.phone);
    assert.ok(replies.length >= 1, 'user must get an error reply, not silence');
    assert.match(replies[0].body, /snag|try again/i, 'reply should be a visible error');

    const stillPending = db.getPendingInboundMessages().some(m => m.from_id === u.id);
    assert.equal(stillPending, false, 'message must be marked processed (no infinite retry)');
  });

  test('an agent-to-agent turn that fails stays log-only (no SMS to anyone)', async () => {
    const u = mkUser('+12025558802', 'A2A User');
    db.storeInboundMessage({ from_phone: u.phone, from_type: 'user', from_id: u.id, channel: 'agent', text: '[notification] update' });

    const before = sent.length;
    await agent.tick();

    assert.equal(sent.slice(before).length, 0, 'internal-coordination failures must not text the user');
    assert.equal(db.getPendingInboundMessages().some(m => m.from_id === u.id), false, 'still marked processed');
  });
});
