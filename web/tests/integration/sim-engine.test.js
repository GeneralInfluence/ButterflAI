/**
 * sim-engine.test.js — verifies the multi-agent simulator engine (tools/sim.js)
 * without a real Anthropic key, by injecting a scripted Claude client via
 * agent._setAnthropic. Proves: seed → routeInboundSms → drain loop →
 * processMessage → captured SMS, and that an agent→agent cascade (message_agent
 * queues a peer inbound that the drain then processes) plays out end to end.
 */

'use strict';

process.env.DB_PATH  = ':memory:';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
delete process.env.ANTHROPIC_API_KEY;   // prove the engine runs on the injected client alone

const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db    = require('../../db');
const sms   = require('../../sms');
const agent = require('../../agent');
const sim   = require('../../tools/sim');   // sets DB_PATH, installs stub client + tool observer

// Capture outbound SMS (overrides the sim's printing client).
let outbox = [];
function captureSms() {
  sms._setClient({ messages: { create({ to, body }) { outbox.push({ to, body }); return Promise.resolve({ sid: 'test' }); } } });
}

// Silence the sim's tool-call transcript during tests.
agent._setToolObserver(() => {});

describe('sim engine', () => {
  before(() => { sim.seed(); captureSms(); });
  beforeEach(() => { outbox = []; });

  test('single agent turn: human message → drained → captured SMS reply', async () => {
    agent._setAnthropic({
      messages: { create: async () => ({ id: 'r1', content: [{ type: 'text', text: 'hey Aphilos!' }], stop_reason: 'end_turn' }) },
    });

    await sim.injectHuman('aphilos', 'hello');

    const toAphilos = outbox.filter(m => m.to === sim.USERS.aphilos.phone);
    assert.ok(toAphilos.some(m => /hey Aphilos/.test(m.body)), 'agent reply reached Aphilos via captured SMS');
    assert.equal(db.getPendingInboundMessages().length, 0, 'drain fully consumed the queue');
  });

  test('agent→agent cascade: message_agent queues a peer inbound that the drain processes', async () => {
    // Aphilos must resolve BamBam as a contact for message_agent.
    const bambamContact = db.getContactsByUser(sim.USERS.aphilos.id).find(c => c.phone === sim.USERS.bambam.phone);
    assert.ok(bambamContact, 'seed created Aphilos→BamBam contact');

    // Scripted Claude: on Aphilos's FIRST turn (no tool_result yet) emit message_agent;
    // every follow-up / the peer's turn just ends with text.
    agent._setAnthropic({
      messages: {
        create: async ({ system, messages }) => {
          const isAphilos = /Aphilos/.test(system || '');
          const hasToolResult = (messages || []).some(
            m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result')
          );
          if (isAphilos && !hasToolResult) {
            return {
              id: 'r-tool',
              content: [{ type: 'tool_use', id: 't1', name: 'message_agent',
                          input: { contact_id: bambamContact.id, topic: 'ping', message: 'ping from Aphilos' } }],
              stop_reason: 'tool_use',
            };
          }
          return { id: 'r-end', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
        },
      },
    });

    await sim.injectHuman('aphilos', 'ping bambam');

    // The tool ran → an agent_messages row from Aphilos to BamBam exists.
    const a2a = db._raw().prepare(
      `SELECT * FROM agent_messages WHERE from_user = ? AND to_user = ?`
    ).all(sim.USERS.aphilos.id, sim.USERS.bambam.id);
    assert.ok(a2a.length >= 1, 'message_agent queued a peer message (cascade started)');

    // The drain consumed BamBam's queued agent_query too — queue ends empty.
    assert.equal(db.getPendingInboundMessages().length, 0, 'drain consumed the full cascade');

    // Aphilos got a human-facing SMS after the tool result.
    assert.ok(outbox.some(m => m.to === sim.USERS.aphilos.phone), 'Aphilos received a reply SMS');
  });
});
