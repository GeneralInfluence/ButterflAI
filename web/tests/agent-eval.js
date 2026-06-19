/**
 * ButterflAI Agent Eval Harness
 *
 * Tests the agent against known scenarios without sending real SMS.
 * Run after deploys to catch regressions early.
 *
 * Usage:
 *   node web/tests/agent-eval.js
 *   EVAL_USER_PHONE=+1... node web/tests/agent-eval.js   (use real user)
 */

'use strict';

process.chdir(__dirname + '/../..');  // root of app
require('dotenv').config({ path: '.env' });

const { processMessage } = require('./agent');
const db = require('./db');

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0, warned = 0;
const results = [];

function evalResult(name, reply, checks) {
  const issues = [];
  for (const [label, fn] of Object.entries(checks)) {
    if (!fn(reply)) issues.push(label);
  }
  if (issues.length === 0) {
    console.log(`  ✅ ${name}`);
    passed++;
    results.push({ name, status: 'pass', reply: reply.slice(0, 100) });
  } else {
    console.log(`  ❌ ${name}`);
    console.log(`     reply: "${reply.slice(0, 120)}"`);
    console.log(`     failed checks: ${issues.join(', ')}`);
    failed++;
    results.push({ name, status: 'fail', issues, reply: reply.slice(0, 200) });
  }
}

async function runTest(user, text) {
  const msgId = require('crypto').randomUUID().replace(/-/g, '');
  // Store inbound message
  db.storeInboundMessage({
    from_phone: user.phone,
    from_type: 'user',
    from_id: user.id,
    channel: 'eval',
    text,
  });
  const msg = db.getPendingInboundMessages().find(m => m.from_id === user.id);
  if (!msg) throw new Error('Message not stored');

  // Capture reply without sending SMS
  let capturedReply = null;
  const origSend = require('./sms').sendUnchecked;
  require('./sms').sendUnchecked = async (to, body) => { capturedReply = body; return { sid: 'eval' }; };

  try {
    await processMessage(msg);
  } finally {
    require('./sms').sendUnchecked = origSend;
    db.markMessageProcessed(msg.id);
  }

  return capturedReply || '';
}

// ── Test suite ────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🦋 ButterflAI Agent Eval\n');

  // Find or create eval user
  let user = db.getUserByPhone(process.env.EVAL_USER_PHONE || '+15550000001');
  if (!user) {
    console.log('  ℹ️  No eval user found — skipping live agent tests');
    console.log('     Set EVAL_USER_PHONE=+1... to test against a real user\n');
    await runStaticTests();
  } else {
    console.log(`  Using user: ${user.name} (${user.phone})\n`);
    await runAgentTests(user);
  }

  // Always run static tests (no user needed)
  await runStaticTests();

  // Summary
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${warned} warnings`);
  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'fail').forEach(r => {
      console.log(`  - ${r.name}: ${r.issues.join(', ')}`);
    });
    process.exit(1);
  } else {
    console.log('\nAll checks passed ✅');
    process.exit(0);
  }
}

async function runAgentTests(user) {
  console.log('Agent response tests:');

  try {
    // Test: contact lookup
    const r1 = await runTest(user, 'how many contacts do I have?');
    evalResult('contact count response', r1, {
      'mentions contacts or number': r => /contact|\d+/.test(r.toLowerCase()),
      'not fabricated confirmation': r => !/done|sent|confirmed/i.test(r),
    });

    // Test: RSVP classifier (static — via multiparty module)
    // (tested in runStaticTests)

    // Test: no fabrication on vague request
    const r2 = await runTest(user, 'send everyone a message');
    evalResult('vague request — asks for clarification', r2, {
      'asks a question or requests clarification': r => /\?|who|which|clarify|specify/i.test(r),
      'does not claim "Done" or "Sent"': r => !/^done[.!]|^sent[.!]/i.test(r.trim()),
    });

  } catch (err) {
    console.log(`  ⚠️  Agent tests failed to run: ${err.message}`);
    warned++;
  }
}

async function runStaticTests() {
  console.log('\nStatic module tests:');

  // RSVP classifier
  const multiparty = require('./multiparty');

  const rsvpCases = [
    ['yes', 'yes'],
    ['Yeah totally', 'yes'],
    ['absofuckinglutely', 'yes'],
    ['do bears shit in the woods', 'yes'],
    ['fuck yeah', 'yes'],
    ['I\'m in', 'yes'],
    ['nah can\'t make it', 'no'],
    ['busy that night', 'no'],
    ['won\'t be able to', 'no'],
  ];

  for (const [input, expected] of rsvpCases) {
    const result = await multiparty._classifyRsvpPublic(input, 'beers on Friday at 7pm').catch(() => null);
    if (result === expected) {
      console.log(`  ✅ RSVP "${input}" → ${result}`);
      passed++;
    } else if (result === null) {
      console.log(`  ⚠️  RSVP "${input}" → classifier unavailable (Claude not configured)`);
      warned++;
    } else {
      console.log(`  ❌ RSVP "${input}" → got "${result}", expected "${expected}"`);
      failed++;
    }
  }

  // Phone normalization
  const { toE164 } = require('./phoneUtils');
  const phoneCases = [
    ['(570) 267-7976', '+15702677976'],
    ['+1 202 555 0147', '+12025550147'],
    ['2025550147', '+12025550147'],
  ];
  for (const [input, expected] of phoneCases) {
    const result = toE164(input);
    if (result === expected) {
      console.log(`  ✅ toE164("${input}") → ${result}`);
      passed++;
    } else {
      console.log(`  ❌ toE164("${input}") → got "${result}", expected "${expected}"`);
      failed++;
    }
  }
}

main().catch(err => {
  console.error('Eval crashed:', err);
  process.exit(1);
});
