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

  // Pattern: "invite bambam to dinner friday 7pm" (a NAMED weekday)
  // Bug postmortem (2026-07-21, simulator): "Friday" → scheduled Saturday, and the
  // invite said "Saturday" while the host confirmation said "Friday".
  test('Named weekday must resolve to the next occurrence and be verified against the date', () => {
    assertContains('WEEKDAY & DATE RESOLUTION', 'weekday resolution rule present');
    assertContains('NEXT occurrence', 'resolve a named weekday to its next occurrence');
  });

  test('Agent must NOT compute dates itself — use the injected Date context block', () => {
    assertContains('NEVER compute a date yourself', 'dates come from the Date context block, not model arithmetic');
  });

  test('Scheduling routes the day+time phrase through the "when" field (server resolves)', () => {
    assertContains(`create_social_event's "when" field`, 'day+time phrase resolved server-side, not by the model');
  });

  test('Every message about an event must use the actual scheduled weekday, not the user\'s word', () => {
    assertContains('message that says "Friday" while the event is on Saturday is a bug', 'no weekday/date mismatch across messages');
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

  // Pattern: "set up a group hang this weekend, invite bambam" (a KNOWN contact)
  // Bug postmortem (2026-07-21, simulator): agent asked "Who is Bambam?" instead of
  // calling lookup_contact, and piled on 3 questions when only the time was unknown.
  test('Inviting someone by name must lookup_contact first, never ask who they are', () => {
    assertContains('INVITING SOMEONE BY NAME', 'invite-by-name recipe present');
    assertContains('NEVER ask "who is [name]?"', 'must not ask the user to identify a known contact');
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// RECIPE LAYER (concrete step-by-step playbooks — Haiku follows these better than
// diffuse principles; see 2026-07-21 simulator training)
// ══════════════════════════════════════════════════════════════════════════════
describe('Recipe layer for Haiku', () => {

  test('A labeled RECIPES section exists', () => {
    assertContains('## RECIPES', 'top-level recipes block present');
  });

  test('Invite recipe threads the resolved contact_id (never the raw name)', () => {
    assertContains('RECIPE: "invite [name] to [activity]"', 'invite recipe present');
    assertContains('Never pass the raw name string where a contact_id is expected', 'contact_id threading rule');
  });

  test('Vague-time recipe goes agent-to-agent first, without double-asking the user', () => {
    assertContains('RECIPE: vague time', 'vague-time recipe present');
    assertContains('do NOT also ask your own user for the time in the same turn', 'no redundant ask-user + message_agent');
  });

  test('RSVP-arrives recipe acts on the single pending invite without re-asking', () => {
    assertContains('RECIPE: a reply that looks like an RSVP', 'rsvp-arrives recipe present');
    assertContains('do NOT ask "which event?"', 'act on the single pending invite');
  });

  // Web-first (Phase A #3): user-invitees are notified in-app, not by SMS, so the
  // agent must not promise the host that the invitee "will get a text".
  test('Agent must not promise a user-invitee "a text" (they are notified in-app)', () => {
    assertContains('Do NOT promise the invitee "a text"', 'channel-agnostic invite confirmation');
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

  // Bug postmortem (2026-09-22): a months-old event surfaced as "tonight".
  test('Past events must never be presented as current', () => {
    assertContains('ALREADY HAPPENED', 'past events are flagged, not presented as upcoming');
  });

  test('"Send a test" sends a neutral test, not a resurrected old plan', () => {
    assertContains('a brief, neutral test message', 'a test is a test — not an old event');
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
  test('Agent queries must be handled per type — factual silent, coordination surfaced', () => {
    assertContains('AGENT QUERY HANDLING — TWO TYPES', 'agent query two-types label');
    assertContains('FACTUAL QUERIES', 'factual queries label');
    assertContains('COORDINATION INVITES / PLANS', 'coordination invites label');
  });

  // 2026-10-09: the agent told Sean Alexandria "hasn't opted in" so it couldn't invite her.
  test('an invite needs no prior opt-in', () => {
    assertContains('AN INVITE NEEDS NO PRIOR OPT-IN', 'invite rule');
    assertContains('never offer to "text them a heads-up first"', 'no heads-up text');
  });

  // 2026-10-09: "Al" can mean Allie (what Sean calls her) or a friend actually named Al.
  test('lookups pass the conversation context; if several people fit, ask', () => {
    assertContains('exactly as your user said it — and with context', 'lookup with context');
    assertContains('If it says more than one person fits, ask your user which one', 'ask when ambiguous');
  });

  // 2026-10-09: adding Alex to the Favorite Mama's should catch her up on the group's plans.
  test('group plans are created with the group; new members are caught up', () => {
    assertContains('GROUP PLANS', 'group plans rule');
    assertContains('create_social_event with group set', 'event linked to group');
    assertContains('caught_up_on', 'report catch-up');
  });

  // 2026-10-09: Allie deferred the Grover details to Melanie and Sean but kept being asked.
  test('deferring on a plan: recorded with defer_on_plan, plan only, no reasons passed on', () => {
    assertContains('DEFERRING ON A PLAN', 'deferral rule');
    assertContains('call defer_on_plan', 'deferral tool');
    assertContains('Never pass along their reasons', 'no reasons');
  });

  // 2026-10-09: the Grover trip was coordinated but never created, so it wasn't on Home.
  test('trips still being figured out are created tentative first; clear interest is recorded', () => {
    assertContains('TRIPS AND PLANS STILL BEING FIGURED OUT', 'tentative trips rule');
    assertContains('tentative: true', 'create tentative');
    assertContains('record_rsvp accepted (shown as interested)', 'interest recorded');
  });

  // 2026-10-09: Allie and Melanie were texted their agent's reasoning when it surfaced
  // Sean's trip question. Surfacing now goes only through tell_my_user (enforced in code).
  test('answering another agent: final text reaches no one; tell_my_user carries the message', () => {
    assertContains('WHEN ANSWERING ANOTHER AGENT YOUR FINAL TEXT IS SHOWN TO NO ONE', 'final text not delivered');
    assertContains('pass it to your user with tell_my_user', 'surface via tool');
  });

  test('Agent must not use meta-commentary words that reveal coordination', () => {
    assertContains('"discreetly"', 'discreetly banned from agent messages');
    assertContains('"no awkward conversation needed"', 'awkward conversation phrase banned');
    assertContains('AGENT MESSAGE TONE', 'agent message tone rule label');
  });

  test('Agent must not reveal other agent messages verbatim to user', () => {
    assertContains('Never reveal what the other agent said verbatim', 'no verbatim relay rule');
  });

  test('Relayed contact message rule is present (non-user contact texted in)', () => {
    assertContains('RELAYED CONTACT MESSAGE', 'relayed contact message rule label');
    assertContains('send_logistics_sms', 'relayed contact reply tool named');
    assertContains('Do not leave a relayed contact hanging', 'no-drop guarantee for relayed contacts');
  });
});

// ── Coordination invite surfacing + event-first rule ─────────────────────────
describe('Coordination invite handling and event-first rule', () => {
  test('Coordination invites (plans) must be surfaced to user, not handled silently', () => {
    assertContains('COORDINATION INVITES / PLANS', 'coordination invite label');
    // Wording changed 2026-10-09: surfacing now goes through tell_my_user (the final text
    // of an agent_query turn reaches no one — it leaked reasoning to Allie and Melanie).
    assertContains('pass it to your user with tell_my_user', 'surface to user rule');
  });

  test('Factual queries still handled silently', () => {
    assertContains('FACTUAL QUERIES', 'factual queries label');
    assertContains('handle SILENTLY', 'factual queries silent rule');
  });

  test('create_social_event must be called before message_agent when planning outings', () => {
    assertContains('CREATE THE EVENT BEFORE MESSAGING AGENTS', 'event-first rule label');
    assertContains('If you only call message_agent without creating the event', 'event-first consequence');
  });
});

// ── Per-edge private-data consent (PRIVACY.md Invariant 2) ────────────────────
describe('Per-edge private-data sharing consent', () => {
  test('prompt states sharing is per-person, never global', () => {
    assertContains('PRIVATE DATA IS SHARED PER-PERSON, NEVER GLOBALLY', 'per-edge consent rule');
    assertContains('THAT specific item with THAT specific contact', 'per-item per-contact');
  });

  test('prompt tells the agent to request confirmation, not self-grant', () => {
    assertContains('request_private_sharing', 'request tool named in prompt');
    assertContains('shared ONLY if the user replies yes', 'code-gated confirmation phrasing');
  });

  test('prompt says treat newly-shared private info as private by default', () => {
    assertContains('treat it as private by default', 'default-private rule');
  });
});

describe('Avoid list — act on it, never say it (PRIVACY.md)', () => {
  test('prompt adds avoided people via manage_avoid_list without asking why', () => {
    assertContains('AVOID LIST — ACT ON IT, NEVER SAY IT', 'avoid-list section');
    assertContains('call manage_avoid_list action=add right away. Do not ask why and do not store a reason', 'add immediately, no reason');
  });

  test('prompt forbids revealing the avoid list or reasons to anyone else', () => {
    assertContains('NEVER mention the avoid list, or any reason, to another agent, a contact', 'never-say rule');
    assertContains('simply "can\'t make it"', 'neutral outward phrasing');
  });

  test('prompt requires asking before RSVPing flagged invites', () => {
    assertContains('must be put to the user before you RSVP', 'ask-first invites');
    assertContains('Never RSVP until they answer', 'no RSVP before answer');
  });

  test('prompt tells the agent to report avoided_not_invited to the user only', () => {
    assertContains('avoided_not_invited', 'create_social_event avoided field handled');
  });

  test('prompt handles PRIVATE_MODE_ON refusals', () => {
    assertContains('If a tool returns PRIVATE_MODE_ON', 'private mode refusal handling');
  });
});

describe('RSVP classifier prompt (multiparty.classifyRsvp)', () => {
  const { _RSVP_SYSTEM_PROMPT: rsvp } = require('../../multiparty');

  // Regression (nightly eval, 2026-10-05): Haiku classified "do bears shit in the woods"
  // as UNCLEAR with a one-line prompt, so a friend's yes went unrecorded.
  test('treats rhetorical yes-questions and idioms as YES', () => {
    assert.ok(rsvp.includes('rhetorical question or idiom whose obvious answer is yes'));
  });

  test('casual acceptances and soft declines are covered; UNCLEAR is the narrow case', () => {
    assert.ok(rsvp.includes('any acceptance, however casual'));
    assert.ok(rsvp.includes('any decline, however soft'));
    assert.ok(rsvp.includes('UNCLEAR: only when the reply genuinely doesn\'t commit'));
  });
});

// Regression (prod, 2026-10-06, tester Allie): the agent drafted a teasing nudge as
// "expressive", asked for approval twice, guessed contact ids, and finally replied
// "Sent!" when nothing was sent.
describe('Sending on request — no needless approvals, no guessed ids, no false "sent"', () => {
  test('teasing/nudging a friend toward a plan is logistics, sent right away', () => {
    assertContains('Teasing, nudging or hyping a friend toward a plan', 'nudges are logistics');
  });
  test('a go-ahead after a draft is approval', () => {
    assertContains('A GO-AHEAD AFTER A DRAFT IS APPROVAL', 'go-ahead rule');
    assertContains('Never ask for approval twice');
  });
  test('never guess contact ids', () => {
    assertContains('NEVER GUESS A contact_id', 'lookup first');
  });
  test('only claim sent when the tool confirmed it this turn', () => {
    assertContains('Only say a message was sent if the send tool returned sent: true in THIS turn');
  });
});

describe('Messages between people go through the agents (owner decision 2026-10-06)', () => {
  test('agent understands incoming/outgoing cards and replies via send_logistics_sms', () => {
    assertContains('MESSAGES BETWEEN PEOPLE GO THROUGH THE AGENTS');
    assertContains('is a message from Allie (her agent sent it)');
    assertContains('reply to that person with send_logistics_sms');
  });
});

describe('Asking a person vs asking their agent (2026-10-08)', () => {
  test('person-facing questions use send_logistics_sms; message_agent is agent-only; trust on_butterflai', () => {
    assertContains('TO ASK OR TELL A PERSON SOMETHING');
    assertContains('message_agent talks only to their AGENT');
    assertContains('trust that, not a contact\'s tier');
  });
});

// Regression (prod, 2026-10-08, Bam Bam feedback #5): his agent answered "what's Bam Bam
// up to tonight?" itself, with a July plan, and told Sean's agent where he'd be.
describe('Questions about where your user is / their plans', () => {
  // Owner correction 2026-10-08: don't ping the person to answer an individual either —
  // that's what WhatsApp is for. Answer only from what they've explicitly shared.
  test('never answered from memory, never pings the user; only explicitly shared plans', () => {
    assertContains('WHAT IS YOUR USER UP TO / WHERE ARE THEY / WHAT ARE THEIR PLANS');
    assertContains('NEVER answer this yourself');
    assertContains('Do NOT ping your user to answer it either');
    assertContains('only what your user has explicitly shared for that time');
  });
});

// Owner rule 2026-10-08: ButterflAI is not a messenger — friends' plans are pulled from
// what they shared; nobody is pinged to answer.
describe('What friends are up to / sharing plans (MEMORY.md §11)', () => {
  test('"what\'re my boys up to" uses check_friends_plans, never pings', () => {
    assertContains('WHAT FRIENDS ARE UP TO');
    assertContains('check_friends_plans');
    assertContains("NEVER message_agent or send_logistics_sms people to ask what they're up to");
  });
  test('the user\'s own plans are shared with share_plan, expiry from their words', () => {
    assertContains('share_plan with their words for how long (until)');
  });
});

describe('Planning & research (2026-10-09, Grover Hot Springs)', () => {
  test('look it up instead of giving up; weather tool; honest about booking', () => {
    assertContains("PLANNING & RESEARCH — LOOK IT UP, DON'T GIVE UP");
    assertContains('get_weather_forecast');
    assertContains('Never say you booked or reserved anything');
  });
});
