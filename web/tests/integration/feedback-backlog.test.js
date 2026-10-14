/**
 * feedback-backlog.test.js — 🐛 reports from before cases existed, each with the test it
 * needed and didn't have (owner, 2026-10-13: "each caterpillar should become a new test").
 * The other early reports are covered by the tests named in their test_ref.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'feedback-backlog-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

require('../../server');
const db = require('../../db');
const agent = require('../../agent');
const planops = require('../../planops');

let n = 0;
function mkUser(name) {
  const phone = `+1202548${String(8000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const toolUse = (name, input) => ({ id: 'm' + Math.random(), stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't' + Math.random(), name, input }] });
const endText = (text) => ({ id: 'm' + Math.random(), stop_reason: 'end_turn', content: [{ type: 'text', text }] });

// 🐛 #11 (Sean, 2026-10-12): "Why would Liam's birthday party be combined with Melanie's?"
describe('🐛 #11: only combine plans the user named', () => {
  const SAID = "Melanie's birthday weekend and the grover Hot Springs is really just one event decided that we are not going to the hot springs right now and that Saturday go to the Carson City Hot Springs instead";
  test('exact regression: offering to fold in a plan they never mentioned is refused', async () => {
    const sean = mkUser('Sean Merge');
    const mel = await planops.create(sean.id, { title: "Melanie's Birthday Weekend", tentative: true });
    const liam = await planops.create(sean.id, { title: "Liam's Birthday Party", tentative: true });
    const results = [];
    let i = 0;
    const steps = [toolUse('merge_plans', { keep_event_id: mel.eventId, merge_event_id: liam.eventId }), endText('ok')];
    // What the tool returned is what the model gets back next (tool_result).
    agent._setAnthropic({ messages: { create: async (req) => {
      for (const m of req.messages || []) for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type === 'tool_result') { try { results.push(JSON.parse(typeof c.content === 'string' ? c.content : c.content[0].text)); } catch (_) {} }
      }
      return steps[Math.min(i++, steps.length - 1)];
    } } });
    db.storeInboundMessage({ from_phone: sean.phone, from_type: 'user', from_id: sean.id, channel: 'webchat', text: SAID });
    await agent.tick();
    assert.equal(results[0]?.error, 'PLAN_NOT_NAMED');
    assert.match(results[0].message, /Liam's Birthday Party/);
    assert.match(results[0].message, /update the plan they named instead/);
  });

  test('both named → the usual "ask first" proposal', () => {
    assert.equal(agent.planNamedIn(SAID, "Melanie's Birthday Weekend"), true);
    assert.equal(agent.planNamedIn(SAID, 'Grover Hot Springs camping'), true);
    assert.equal(agent.planNamedIn(SAID, "Liam's Birthday Party"), false, '"birthday" alone does not name it');
    assert.equal(agent.planNamedIn('combine it with Mel’s thing', "Melanie's Birthday Weekend"), true, 'a short form of the name counts');
    assert.equal(agent.planNamedIn('grover is the same thing as melanies birthday weekend', "Melanie's Birthday Weekend"), true, 'no apostrophe');
  });
});

// 🐛 #2 (Sean, 2026-10-06): "I just said I want to send her a message that we should hang
// out but you then ask what I want. You should see that already."
describe('🐛 #2: write the message from the gist', () => {
  test('the agent writes it when given the gist, instead of asking what to say', () => {
    const p = agent.buildSystemPrompt({ name: 'X', phone: '+1' }, '');
    assert.ok(p.includes('WRITE IT FOR THEM: when your user gives the gist of a message'));
    assert.ok(p.includes('never ask "what do you want to say?"'));
  });
});

// The early reports are linked to their tests in migration 056 — every test named there
// must exist, so a link can't point at nothing.
describe('the 11 early reports point at real tests', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/056_feedback_backlog_tests.sql'), 'utf8');
  const refs = [...sql.matchAll(/test_ref = '((?:[^']|'')+)'/g)].map((m) => m[1].replace(/''/g, "'"));
  test('11 reports, each linked', () => assert.equal(refs.length, 11));
  for (const ref of refs) {
    for (const part of ref.split(' + ')) {
      test(part, () => {
        const [file, ...names] = part.split(' › ');
        const src = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
        for (const name of names) {
          const want = name.replace(/\s*\(.*\)\s*$/, '').replace(/["“”]/g, '').slice(0, 40);   // "(…)" = description, not the name
          assert.ok(src.replace(/\\"/g, '"').replace(/["“”]/g, '').includes(want), `${file} has "${want}"`);
        }
      });
    }
  }
});
