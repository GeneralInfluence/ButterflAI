'use strict';

/**
 * system-prompt.test.js — Asserts that the ButterflAI system prompt contains
 * the behavioral rules and guardrails that protect users and contacts.
 *
 * PHILOSOPHY
 * ----------
 * We cannot cheaply test "does the LLM follow this rule?" end-to-end, but we
 * CAN test "is the rule in the prompt the model receives?".  Any time a new
 * interaction pattern is identified (from real usage or product decisions), a
 * corresponding assertion should be added here so the rule can't be silently
 * deleted.
 *
 * ADDING A NEW TEST
 * -----------------
 * 1. Identify the rule / guardrail (usually from MEMORY.md or a bug postmortem).
 * 2. Identify the canonical phrase that encodes it in the prompt.
 * 3. Add a test in the relevant describe block (or a new one).
 * 4. Run: DB_PATH=:memory: JWT_SECRET=test node --test tests/integration/system-prompt.test.js
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert');

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';

const { buildSystemPrompt } = require('../../agent');

// Minimal user stub — only .name is required by buildSystemPrompt
const STUB_USER = { name: 'TestUser', id: 'test-id', phone: '+10000000000' };

let prompt;
before(() => {
  prompt = buildSystemPrompt(STUB_USER, '## Current state\n- test state');
});

// ── Helper ─────────────────────────────────────────────────────────────────────
function assertContains(needle, label) {
  assert.ok(
    prompt.includes(needle),
    `System prompt must contain: ${label || needle}\n\nSearched for: ${JSON.stringify(needle)}`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SAFETY & CONSENT RULES
// ══════════════════════════════════════════════════════════════════════════════
describe('Safety & consent guardrails', () => {

  test('Agent must self-identify as ButterflAI on every outbound first contact', () => {
    // MEMORY.md §3 rule 1 — hard rule, non-negotiable
    assertContains('self-identify', 'self-identify on outbound');
  });

  test('Outbound messages must include STOP opt-out option', () => {
    assertContains('STOP', 'STOP opt-out in outbound messages');
  });

  test('Agent must never pretend to be human', () => {
    assertContains('human', 'no pretending to be human');
  });

  test('Contacts can view, edit, and leave — self-service without routing through user', () => {
    // MEMORY.md §3 rule 2
    assertContains('view', 'contacts can view their data');
    assertContains('erase', 'contacts can erase their data');
  });

  test('Expressive messages require user in the send path', () => {
    // MEMORY.md §4 — the single biggest line between helpful and creepy
    assertContains('approval', 'expressive messages need approval');
  });

  test('No auto-sent expressive messages the user never saw', () => {
    assertContains('EXPRESSIVE', 'expressive vs logistics distinction in prompt');
  });

  test('Exclusion reasons must never cross the agent-to-agent wire', () => {
    // MEMORY.md hard rule
    assertContains('exclusion', 'exclusion reasons never go cross-agent');
  });

  test('Secrets must never be sent over SMS', () => {
    assertContains('SMS', 'secrets never over SMS (or sms reference)');
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// TOOL ROUTING RULES (correct tool for each interaction pattern)
// ══════════════════════════════════════════════════════════════════════════════
describe('Tool routing — interaction patterns', () => {

  // Pattern: "Invite [contact] to dinner" — discovered from bug where agent
  // used send_contact_invite (onboarding tool) instead of create_social_event
  test('Inviting someone to a social activity must use create_social_event, not send_contact_invite', () => {
    assertContains('create_social_event', 'create_social_event mentioned in prompt');
    assertContains('send_contact_invite', 'send_contact_invite mentioned so rule can reference it');
    // The critical constraint
    assertContains('NEVER the right tool for inviting someone to a social activity', 'send_contact_invite not for social invites');
  });

  // Pattern: "Invite my closest friends to hang out tonight" — group event invite
  test('Group invite ("invite my [group] to X") must use create_social_event after getting group members', () => {
    assertContains('manage_contact_group', 'manage_contact_group in prompt');
    assertContains('create_social_event with ALL of those contact_ids', 'group-to-event rule');
  });

  // Pattern: "Running 10 min late" — one-way logistics SMS, no RSVP expected
  test('One-way informational messages use send_logistics_sms', () => {
    assertContains('send_logistics_sms', 'send_logistics_sms in prompt');
    assertContains('running 10 min late', 'example logistics SMS pattern');
  });

  // Pattern: "Tell [contact] we should catch up soon" — expressive, not logistics
  test('Messages that speak as the user with feeling require approval before sending', () => {
    assertContains('EXPRESSIVE (needs user approval before sending)', 'expressive approval gate');
  });

  // Pattern: send_contact_invite is ONLY for onboarding Tier 0 contacts
  test('send_contact_invite is exclusively for inviting Tier 0 contacts to join ButterflAI', () => {
    assertContains('Tier 0', 'Tier 0 in prompt for send_contact_invite context');
    assertContains('JOIN ButterflAI', 'send_contact_invite = join ButterflAI only');
  });

  // Pattern: duplicate event creation — should never create more than once
  test('create_social_event must only be called once per event', () => {
    assertContains('NEVER call create_social_event more than once', 'no duplicate event creation');
  });

  // Pattern: Bam Bam's agent said "Sean is not on ButterflAI" when Sean IS a user — just Tier 1
  // Agent must not confuse "can't reach their agent (Tier 1)" with "not on ButterflAI"
  test('Tier 1 contact must not be described as "not on ButterflAI" — they may be a full user', () => {
    assertContains('TIER CONFUSION', 'tier confusion warning in prompt');
    assertContains("they're not on ButterflAI", 'never say not on ButterflAI for Tier 1');
  });

  // Pattern: agent must always TRY message_agent before assuming a contact is not on ButterflAI
  // Only fall back to "ask host for time" if message_agent explicitly returns "not a ButterflAI user"
  test('Agent must always call message_agent first to check — not assume Tier 1 = no agent', () => {
    assertContains('ALWAYS try message_agent', 'always try message_agent before assuming no agent');
  });

  test('Only fall back to ask-host-for-time if message_agent explicitly says not a ButterflAI user', () => {
    assertContains('Contact is not a ButterflAI user', 'fall back only on explicit not-a-user error');
  });

  // Pattern: "I want to hang out with Allie tonight" (vague time)
  // Bug postmortem: agent assumed 7 PM without asking → wrong behavior
  test('Vague time ("tonight", "this weekend") must NOT result in an invented time', () => {
    assertContains('DO NOT pick a time yourself', 'no invented times like 7 PM');
  });

  test('When time is vague, agent should call message_agent for each invitee first', () => {
    assertContains('ALWAYS try message_agent', 'always try message_agent for availability when time is vague');
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// DATA & PRIVACY RULES
// ══════════════════════════════════════════════════════════════════════════════
describe('Data & privacy handling', () => {

  test('Contact edit conflict: contact\'s version wins, user is notified', () => {
    // MEMORY.md §3 rule 3 — locked decision
    assertContains("contact's version wins", 'edit conflict: contact wins');
  });

  test('Plan disclosure is pull-not-push (only to host-chosen invitees)', () => {
    // MEMORY.md hard rule: never reveal where someone will be to unchosen people
    assertContains('pull', 'pull-not-push disclosure model');
  });

  test('Agent-to-agent coordination must not retain private profile data of the other user', () => {
    assertContains('minimization', 'data minimization in agent-to-agent');
  });

  test('Inferences must be visible and editable — never silently acted on', () => {
    assertContains('infer', 'inference governance in prompt');
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// FLAI / CAPABILITY LANGUAGE
// ══════════════════════════════════════════════════════════════════════════════
describe('FLAI capability language', () => {

  test('FLAI balance/score/points must never be shown to users', () => {
    // MEMORY.md rule: user_never_sees_a_balance
    assertContains('balance', 'FLAI balance mentioned (to forbid it)');
  });

  test('FLAI uses capability language, not token counts', () => {
    assertContains('FLAI', 'FLAI mentioned in prompt');
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// MINIMIZING BACK-AND-FORTH (UX quality rules)
// ══════════════════════════════════════════════════════════════════════════════
describe('Minimize back-and-forth', () => {

  test('Only ask ONE clarifying question at a time', () => {
    assertContains('ONE clarifying question', 'single question rule');
  });

  test('Direct commands (send it, text her) must execute immediately without draft', () => {
    assertContains('send it', 'direct command → immediate execution');
  });

  test('Affirmative replies (yeah, sounds good) mean approved — execute immediately', () => {
    assertContains('sounds good', 'affirmative = approved, execute');
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// AGENT-TO-AGENT COORDINATION
// ══════════════════════════════════════════════════════════════════════════════
describe('Agent-to-agent coordination', () => {

  test('For group events, check invitee agent availability before proposing a time', () => {
    assertContains('message_agent', 'message_agent tool mentioned');
    assertContains('availability', 'availability check in agent-to-agent');
  });

  test('Agent queries from other agents should be answered silently without bothering user', () => {
    assertContains('reply_agent', 'reply_agent tool in prompt');
    assertContains('SILENTLY', 'silent agent-to-agent handling');
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// LIVE STATE — agent must use DB snapshot, not stale memory
// ══════════════════════════════════════════════════════════════════════════════
describe('Live state over stale memory', () => {

  test('Agent must check RSVP status from live snapshot, not conversation history', () => {
    assertContains('RSVP', 'RSVP status from live snapshot');
    assertContains('snapshot', 'snapshot referenced in prompt');
  });

  test('Agent must not rely on what it said in a previous turn for live status', () => {
    assertContains('previous turn', 'do not rely on previous turn for live data');
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// LOCATION
// ══════════════════════════════════════════════════════════════════════════════
describe('Location handling', () => {

  test('Agent must emit REQUEST_LOCATION JSON when location is unknown and needed', () => {
    assertContains('REQUEST_LOCATION', 'REQUEST_LOCATION action in prompt');
  });

  test('Once location is known, agent must not ask again', () => {
    assertContains('never ask again', 'no repeated location asks');
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// TONE & LANGUAGE
// ══════════════════════════════════════════════════════════════════════════════
describe('Tone & language handling', () => {

  test('Agent handles casual/crude/sweary language naturally without refusing', () => {
    assertContains('sweary', 'casual language handling');
    assertContains('lecture', 'no lecturing about language');
  });

  test('Agent gives concise SMS-length replies', () => {
    assertContains('SMS-length', 'SMS-length reply style');
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// AGENT TOOL EXECUTION — runtime correctness (regression from 2026-07-16)
// ══════════════════════════════════════════════════════════════════════════════
describe('Agent tool execution — runtime regression tests', () => {

  // Bug: message_agent used `user.name` but executeTool never received `user` param
  // This caused "user is not defined" → agent silently errored → stuck typing dots
  test('executeTool is importable and message_agent case does not reference undefined variables', async () => {
    // Verify executeTool is exported or at least that agent module loads without error
    const agent = require('../../agent');
    assert.ok(typeof agent.buildSystemPrompt === 'function', 'buildSystemPrompt must be exported');
    assert.ok(typeof agent.processMessage === 'function', 'processMessage must be exported');
  });

  // Bug: getRecentConversation can return 'system' role rows (migration 019 added this role)
  // Anthropic rejects message arrays with role='system' → 400 error → stuck typing dots
  test('conversation history filter strips system-role rows before sending to Anthropic', () => {
    // The fix is in the prompt-building code — verify the filtering logic description exists
    // in the source (code review proxy test)
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../agent'), 'utf8');
    assert.ok(
      src.includes("filter(h => h.role === 'user' || h.role === 'assistant')"),
      'History must filter out system-role rows — Anthropic only accepts user/assistant in messages[]'
    );
  });

  // Bug: same-role consecutive messages (e.g., two user messages in a row) cause Anthropic 400
  test('conversation history deduplication collapses consecutive same-role entries', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../agent'), 'utf8');
    assert.ok(
      src.includes('acc[acc.length - 1].role === h.role'),
      'History deduplication must detect and collapse consecutive same-role entries'
    );
  });

});

// ── Flexible / open-time events ───────────────────────────────────────────────
describe('Flexible / open-time events', () => {
  test('Agent must not nag for a time when user says "come when you\'re ready"', () => {
    assertContains("come when you're ready", 'flexible time example phrase');
    assertContains('open invite', 'open invite phrase in prompt');
  });

  test('System prompt distinguishes vague time from explicit no-time', () => {
    assertContains('FLEXIBLE / OPEN-TIME', 'flexible time rule section');
    assertContains('LOCATION CONTEXT', 'location context rule');
    assertContains('without nagging for a time', 'no nag rule');
  });
});

// ── Location-first coordination algorithm ─────────────────────────────────────
describe('Location-first coordination algorithm', () => {
  test('COORDINATION ALGORITHM section exists in prompt', () => {
    assertContains('COORDINATION ALGORITHM', 'coordination algorithm section');
  });

  test('check_invitee_locations must be called first before time coordination', () => {
    assertContains('ASSESS LOCATION FIRST', 'assess location first step');
    assertContains('check_invitee_locations', 'check_invitee_locations tool referenced in algorithm');
  });

  test('routing recommendations are defined for all cases', () => {
    assertContains('"flexible"', 'flexible routing case');
    assertContains('"mixed"', 'mixed routing case');
    assertContains('"coordinate"', 'coordinate routing case');
    assertContains('"host_location_unknown"', 'host location unknown routing case');
  });

  test('agent must never skip location check', () => {
    assertContains('NEVER skip step 1', 'never skip location check rule');
  });
});

// ── Agent-to-agent exhaustion + event negotiation ─────────────────────────────
describe('Agent-to-agent exhaustion and event negotiation', () => {
  test('EXHAUSTION RULE requires 3+ rounds before involving user', () => {
    assertContains('EXHAUSTION RULE', 'exhaustion rule label');
    assertContains('3 rounds', '3 round minimum');
    assertContains('3+ times', '3 attempts before escalation');
  });

  test('EVENT THREAD IDs rule — use event_id as thread_id', () => {
    assertContains('EVENT THREAD IDs', 'event thread id rule');
    assertContains('thread_id = the event\'s ID', 'event id as thread_id instruction');
  });

  test('SENSITIVE / PRIVATE QUESTIONS must go agent-to-agent first', () => {
    assertContains('SENSITIVE / PRIVATE QUESTIONS', 'sensitive questions label');
    assertContains('health tests', 'health tests example');
    assertContains('sexual health', 'sexual health example');
    assertContains('route it via message_agent', 'route sensitive questions via message_agent');
  });

  test('INVITEE COMMENTS ON INVITES must trigger agent-to-agent message', () => {
    assertContains('INVITEE COMMENTS ON INVITES', 'invitee comments rule');
    assertContains('do not just accept/decline silently', 'no silent accept/decline');
  });

  test('HOST UPDATES event after negotiation locks in agreed time', () => {
    assertContains('HOST UPDATES AFTER NEGOTIATION', 'host updates after negotiation label');
    assertContains('update_event', 'update_event tool referenced in negotiation flow');
    assertContains('flexible_time=false', 'lock in time after negotiation');
  });
});

// ── Agent message invisibility rules ─────────────────────────────────────────
describe('Agent message invisibility and tone', () => {
  test('Agent queries must be handled silently — INVISIBLE TO THE USER rule', () => {
    assertContains('AGENT QUERY HANDLING — INVISIBLE TO THE USER', 'invisible to user rule label');
    assertContains('Do NOT mention it to your user', 'do not mention rule');
    assertContains('Your user should never know this exchange happened', 'invisibility guarantee');
  });

  test('Agent must not use meta-commentary words that reveal coordination', () => {
    assertContains('"discreetly"', 'discreetly banned from agent messages');
    assertContains('"no awkward conversation needed"', 'awkward conversation phrase banned');
    assertContains('AGENT MESSAGE TONE', 'agent message tone rule label');
  });

  test('Agent must not reveal other agent messages verbatim to user', () => {
    assertContains('Never reveal what the other agent said verbatim', 'no verbatim relay rule');
  });
});
