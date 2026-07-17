# MEMORY.md — Social ButterflAI

> **Reader:** the OpenClaw agent (build + coordination executor) for the Social ButterflAI project. This file restores project state and the rules the agent must operate under. It is operational, not a pitch. Re-read at session start. Update as decisions land.
>
> **Status tags used below:** `[LOCKED]` = settled decision, act on it. `[DEFAULT]` = reasonable default set by Claude pending owner confirmation — act on it but surface for confirmation. `[OPEN]` = unresolved, do not act unilaterally.

---

## 0. Machine-readable state

```yaml
project: social_butterflai
one_liner: personal social agent for maintaining relationships; agent does logistics, human does emotion
stack:
  backend: node_express
  data: sqlite
  hosting: fly.io
  human_channel: sms_twilio            # CHANGED: Telegram removed as primary; SMS is now the human interface
  agent_to_agent_channel: sqlite_queue_today__federated_protocol_target   # CORRECTED 2026-07-17: MCP was the vision, never built. Reality today = inbound_messages queue (channel=agent_query / agent_reply). Target = federated signed protocol, see docs/REARCHITECTURE.md §2.2
  chain: base                          # encrypted prefs as NFT metadata; wallet integration via ClawBank
channels:
  human_to_own_agent: sms              # voice-to-text on phone keyboard covers "talking" to agent
  agent_to_contact: sms                # invites + non-tier2 coordination
  agent_to_agent: sqlite_message_queue # CORRECTED: inbound_messages, channel=agent_query/agent_reply — NOT mcp. Must not carry private preferences; federation is the target (REARCHITECTURE.md)
agent_topology:
  model: master_agent_plus_ephemeral_per_user_subagents
  identity_keys: [phone_number, mcp_key]   # both map to same user_id
  subagent_lifecycle: spawn_on_demand_warm_60s_then_die_each_interaction_is_fresh_session
  spawn_latency_budget: under_a_minute_target_seconds
  context_access: tools_not_prompt_stuffing   # Option B
  isolation: tools_bound_to_user_id_at_spawn_structural_not_instructional  # this is the no-bleeding guarantee
  no_cross_user_data_in_memory: true
integrations:
  calendar: google_first_oauth_read_write   # agent checks real availability, creates events directly
  calendar_race_conditions: out_of_scope_v1  # user adjusts if they spot a conflict
  venues: suggest_favorites_plus_similar_new  # research-for-the-user
  venue_v1_mechanism: agents_share_favorites_lists_no_cross_user_aggregation_yet
  venue_favorites_storage: unencrypted_per_user_db_not_public
multi_party:
  contact_ingestion: two_gates_ingest_is_not_consent_to_contact_then_per_contact_invite_gate
  contact_ingestion_no_bulk_blast: true
  coordination_model: host_sets_plan_chosen_friends_soft_rsvp_no_quorum
  disclosure_model: pull_not_push                     # friend learns plan only by asking their own agent
  disclosure_gate: only_if_host_already_chose_that_friend_for_this_event  # the safe/unsafe line
  location_time_identity_never_reaches_unchosen_people: true
  ambient_fun_broadcast: deferred_must_be_anonymized_optin_pull_if_ever_built  # gated on Open Q2
private_data_model:
  storage: server_side_encrypted_at_rest_under_kms   # CHANGED: was wallet NFT; NFT did not deliver real revocation
  encryption: aes_256_gcm_per_record_key_wrapped_by_kms
  revocation: trust_based_deletion                   # NOT cryptographic; butterfly holds keys, can read data
  revocation_honesty: must_be_stated_plainly_publicly # do NOT claim "we can't read it"
  why_we_hold_keys: agent_must_act_autonomously_over_sms_without_user_device_online
  controls: [data_minimization, per_class_ttl, access_audit_log, breakglass_only_admin, hard_delete_with_receipt, backup_propagation_window_30d]
  runtime_rule: decrypt_in_ram_only_log_every_access_then_zero  # mitigation, not the guarantee
  verification_roadmap: [security_page, soc2_or_iso27001_intent, bug_bounty]
  wallet_role: identity_and_future_social_budget_only  # NOT a privacy mechanism
  secret_delivery: web_app_only_never_sms
build_state:
  invite_onboarding: needs_rebuild_for_sms  # prior Telegram flow superseded
  tier0_optout: live
  tier1_direct_contact: needs_port_to_sms
  tier2_agent_to_agent: design_only          # enforcement unresolved (Open Q1)
  contact_side_view_edit: committed_to_build # decision locked, not yet built
  wallet_nft_privacy_layer: deprecated              # did not deliver real revocation; replaced by §2 governance
  private_data_governance: spec_complete_not_built  # server-side encrypted + audited; see IMPLEMENTATION.md §2
  clawbank_integration: stubbed              # full wire-up when social-budget feature lands
  web_ui: live                              # dashboard, events, settings, onboarding, referral all shipped
  flai_infrastructure: live                 # ledger, burn meter, lift instrumentation, attendance gate shipped
  test_suite: live_382_passing              # see §7 — tests MUST be maintained with every code change; system-prompt.test.js covers behavioral rules
  ci_cd: live                               # push to main → auto-deploy after tests pass
permission_model:
  source_of_truth: four_flag_edge            # tiers are UI over this
  flags: [can_store, can_infer, can_contact, can_coordinate]
knowledge_provenance: [user_asserted, inferred, passively_accumulated]
confirmed_decisions:
  automation_level: approve_expressive_auto_logistics   # owner-confirmed
  edit_conflict_rule: contact_wins_user_notified        # owner-confirmed
  human_channel: sms_not_telegram                       # owner-confirmed this session
  private_storage: server_side_trust_based_deletion     # owner-confirmed; revocation is trust-based, stated honestly
hard_rules:
  - agent_self_identifies_and_offers_exit_on_every_outbound: true
  - sentiment_requires_human_in_send_path: true
  - no_auto_sent_expressive_messages_user_never_saw: true
  - no_pretending_to_be_human: true
  - contacts_can_view_edit_leave: true
  - private_prefs_encrypted_at_rest_and_access_logged: true   # NOT "never persisted" — butterfly can read; every read audited
  - revocation_is_trust_based_state_this_honestly_never_claim_cannot_read: true
  - exclusion_reasons_never_cross_agent_to_agent_wire: true
  - secrets_never_sent_over_sms: true
  - ingesting_contacts_is_not_consent_to_message_them_per_contact_invite_gate: true
  - plan_disclosure_is_pull_not_push_and_only_to_host_chosen_invitees: true
  - never_reveal_where_someone_will_be_to_anyone_they_did_not_personally_include: true
  - never_claim_sent_unless_tool_returned_sent_true: true      # [LOCKED 2026-06-19] agent fabricated send confirmation — catastrophic trust failure
  - never_invent_contact_rsvp_or_response: true                # contacts have not agreed to anything until they actually reply
  - never_fabricate_plan_details_not_confirmed: true           # only report times/venues/attendees that are actually confirmed
  - always_report_actual_tool_result_not_hoped_outcome: true   # "sent" vs "queued" vs "failed" — be exact
companion_doc: IMPLEMENTATION.md          # detailed build spec for this architecture

---

## 1. What this product is (one paragraph)

Social ButterflAI is a personal social agent that helps people stay meaningfully connected with people they care about. People aren't bad friends because they don't care — they're bad at *maintenance* because life gets busy. ButterflAI absorbs the logistical labor of staying in touch (tracking last contact, suggesting activities, coordinating when/where, reaching out on request) so the human is freed to do the part that matters. **Governing principle the agent must hold: the agent does the logistical labor of friendship so the human can do the emotional labor of friendship.** Outward tagline is "maximize your happiness per dollar spent" — that frames the *activity/logistics* layer only; do **not** let it drive the relationship core toward a transactional model (see §6 risks).

---

## 2. Source of truth: the permission model `[LOCKED]`

The three tiers are **UI only**. The agent's source of truth is a directed `(user → contact)` edge carrying four independent flags:

| Flag | Meaning |
|------|---------|
| `can_store` | persist facts about this contact |
| `can_infer` | derive *new* facts about this contact |
| `can_contact` | message this contact directly |
| `can_coordinate` | talk to this contact's agent (agent-to-agent) |

Tier mapping (presentation layer):
- **Tier 0 — opted out:** all flags false. Hard stop. `[LOCKED, live]`
- **Tier 1 — contact mode:** `can_contact` true; direct via Telegram. `[LOCKED, live]`
- **Tier 2 — full ButterflAI:** `can_coordinate` true; both parties have an agent. `[design_only — enforcement open, see §5]`

**Two flows must stay separate** (do not conflate):
1. **Inbound knowledge** — what the agent *knows about* a contact.
2. **Outbound disclosure** — what the agent *reveals to* a contact when messaging on the user's behalf.
A contact agreeing to be messaged has NOT agreed to be modeled. The agent may know much and disclose little.

**Knowledge provenance** — every stored fact is tagged:
- `user_asserted` — user stated it firsthand. Durable.
- `inferred` — agent derived it. Must be **visible + editable**; never silently acted on.
- `passively_accumulated` — built from signals. **Decays / requires refresh** unless promoted to `user_asserted`.

---

## 3. Consent + privacy rules the agent must enforce

1. **Self-identify + offer exit on EVERY outbound first-contact.** `[LOCKED]` Shape: "Hi, this is [User]'s ButterflAI assistant reaching out for them — reply STOP and I won't message you again." Do not make the agent sound human to seem warmer. This is the single biggest line between this product and a spam/manipulation tool. Non-negotiable.
2. **Contacts can view + edit their own data, now.** `[LOCKED]` Self-service, without routing through the user. Includes downgrade and erase.
3. **Edit-conflict rule:** when a contact edits a fact the user asserted about them (e.g. corrects their own birthday), **the contact's version wins and the user is notified of the change.** `[LOCKED]` Rationale: a person correcting a fact about themselves should outrank the user's guess; notifying the user prevents data silently shifting underneath them.
4. **Symmetric transparency.** Everyone can see what the system knows about them and can leave. This is what makes the network safe to grow.
5. **Agent-to-agent data minimization (Tier 2).** Messages between agents carry only what the immediate coordination needs and are **not retained as profile data** about the other party. Enforcement mechanism is `[OPEN]` — see §5.
6. **Data lifecycle.** `user_asserted` facts may persist; `passively_accumulated` signals decay or require refresh. No indefinite retention of passive signals.
7. **Human channel is SMS (Twilio), not Telegram.** `[LOCKED, this session]` Telegram removed as primary (most users lack it; don't want contacts making bots; SMS fits recurring-scheduling use case). Telegram code retained for possible later international/B2B use. Voice-to-text on the phone covers "talking" to the agent.
8. **Private preferences are stored server-side, encrypted at rest under KMS, with trust-based deletion.** `[LOCKED, this session]` ButterflAI holds the keys and **can technically read** private data — this is a deliberate tradeoff so the agent can act autonomously over SMS without the user's device online to authorize each read. Revocation is therefore **trust-based, not cryptographic.** This MUST be stated honestly in public-facing language — never claim "we can't read your data." Defensibility comes from controls + evidence, not from a guarantee we can't keep: data minimization, per-class TTLs, an access audit log the user can review, break-glass-only admin access, hard deletion with a user-facing receipt and a stated backup-propagation window, and a roadmap to independent audit (SOC 2 / security page / bug bounty). Decrypt in RAM only and log every access; this is mitigation, not the guarantee. The earlier wallet/NFT-as-revocation idea is **deprecated** — it removed the user's copy but not our ability to read, so it wasn't real revocation. Wallet/Base is retained for identity + the future social budget only. Exclusion *reasons* still never cross the agent-to-agent wire. Full build detail in `IMPLEMENTATION.md` §2.

---

## 4. What the agent should / shouldn't do

**Governing test for what the agent may know:** *Would the contact be embarrassed or alarmed to learn the agent knew this?* That sorts most cases.

**SHOULD:**
- Reduce *friction*: track last-contact, surface "it's been a while" nudges, remember user-supplied preferences/dates, suggest activities, coordinate when/where/remind.
- Make inferences **visible and editable** — surface "looks like it's been a while with Marcus — still want him on your list?" rather than silently deprioritizing.
- Hold facts the user knows firsthand and would tell a mutual friend anyway.

**SHOULD NOT:**
- Manufacture sincerity. **No auto-sent expressive messages the user never saw.** This fakes attention without attention — the core creepy failure mode.
- Build or act on a model of the user's social life the user can't see or correct.
- Aggregate across users to profile a contact who never opted in.
- Operationalize something a contact told the user in confidence.
- Infer/act on a contact's emotional state from indirect signals.
- Pretend to be human.

**Automation default — the expressive vs. logistical line:** `[LOCKED]`
> **Logistics may auto-run within user-set rules. Anything carrying sentiment (a message that speaks AS the user, with feeling) requires the user in the send path before send.**
- Recommended default = **approve expressive, auto logistics.**
- **Auto-send expressive within rules** = available as a per-contact opt-in once a user trusts the system; not the default. Rationale: a bad expressive auto-send (friend feels handled by a robot) is high-cost and hard to undo; an extra approval tap is trivial.
- Stricter variant (approve everything) also configurable.

---

## 5. Open questions — do NOT act unilaterally `[OPEN]`

1. **Agent-to-agent minimization — enforcement mechanism.** How to *technically* stop a coordinating agent from retaining the other human's availability/preferences as durable profile data? (ephemeral coordination tokens? protocol-level constraint?) Hardest unsolved Tier-2 problem.
2. **Network-graph consent gap — now also gates venue recommendations.** Even with per-message minimization, Tier-2 coordination across many users implicitly assembles a social graph nobody consented to *as a graph*. **This directly blocks the cross-user venue-aggregation feature** ("people who like similar things also like X") that the owner wants eventually. v1 records favorites per-user and shares them only bilaterally between coordinating agents — fine. Mining favorites across users requires deciding the consent model + honest user-facing disclosure FIRST. Do not build aggregation until then. Likely bounded by what is chosen NOT to retain/aggregate, not a clean technical fix.
3. **Inference governance UI.** Which inferences are surfaced vs suppressed, and how the user accepts/rejects/corrects them.
4. **Decay specifics.** Actual TTLs/refresh cadence for `passively_accumulated`; promotion path to `user_asserted`.
5. **Onboarding friction vs growth.** Strong consent adds friction that suppresses network growth; find the honest balance.
6. **Tagline tension.** Monitor whether "happiness per dollar" pulls product decisions transactional, against the relationship core.

---

## 6. Build state + immediate priorities

**Live:** Tier 0 (opt-out); Node/Express + SQLite on Fly.io.
**Needs rebuild for SMS:** invite/onboarding and Tier 1 (direct contact) — prior Telegram flow is superseded by the SMS architecture (see `IMPLEMENTATION.md`).
**Spec complete, not built:** server-side private-data governance (encrypt-at-rest under KMS, access audit log, TTLs, hard-delete with receipt) — see `IMPLEMENTATION.md` §2; contact-side view/edit/erase (must encode edit-conflict rule = contact wins, user notified).
**Deprecated:** wallet/NFT-as-privacy layer (did not deliver real revocation).
**Stubbed / optional for MVP:** wallet identity + ClawBank integration (wallet/account/LLC/card) — full wire-up when the paid "social budget" feature lands.
**Design only:** Tier 2 agent-to-agent (blocked on enforcement, Open Q1).

**Suggested next actions for the executor** (full ordered list in `IMPLEMENTATION.md` §11):
1. DB migrations: `user_wallets`, `contact_preferences`, `access_audit` (private prefs stored encrypted, NOT in plaintext columns).
2. Twilio inbound/outbound + SMS onboarding state machine; verify self-identify + STOP on every outbound.
3. Encrypt-at-rest under KMS + per-record key wrapping; decrypt-only-on-agent-path gating; access audit log + alerts.
4. Data minimization + per-class TTLs; hard-delete + backup propagation + user-facing deletion receipt.
5. Contact invite + STOP handling + contact-side view/edit.
6. MCP agent-to-agent coordination + politeness (3 rounds / 5 days) + non-retention/purge.
7. `[STUB]` wallet identity + ClawBank + social-budget hooks (optional for MVP).
8. Do NOT build the deprecated preferences NFT or store private data on-chain.
9. Hold Tier-2 live coordination until non-retention enforcement (Open Q1) is decided.

---

## Core UX Principle [LOCKED 2026-06-19]

**The agent asks itself, not the user.**

The user comes to ButterflAI precisely because they don't want to do the legwork. Every time the agent asks the user a question it could answer by checking its own data, it has failed at its core job.

Before generating any reply:
1. Check the state snapshot (open events, invitee statuses, calendar, contact count)
2. Call relevant tools (lookup_contact, get_event_rsvp_status, check_calendar)
3. Only ask the user when no tool or data can resolve the ambiguity

**Wrong:** "I wasn't able to pull RSVP status — can you confirm which event?"
**Right:** Check the open events in the snapshot, read the invitee list, report what it says.

**Wrong:** "Want me to send invites to Sean and Allison?"
**Right:** Check if invites were already sent. Report current status. Offer next action only if genuinely needed.

This principle gates every feature: if a feature requires the user to help the agent find its own data, the feature is broken.

## Hard Rule: Never forward user's raw text to contacts [LOCKED 2026-06-19]

The user's message to ButterflAI is an **instruction**, not outbound content. The agent MUST always compose an appropriate, tactful message for the contact — regardless of how crude or direct the user's instruction was.

**Wrong:** User says "send her an invite to fuck" → agent sends "send her an invite to fuck"
**Right:** User says "send her an invite to fuck" → agent sends "Hey, want to hang after beers tonight? 😊"

The agent is a social proxy. Messages it sends to contacts reflect on the user. Always write as a thoughtful friend would.

Violating this is a dignity and trust failure — worse than fabrication because it actively harms the user's relationships.

## Agent Architecture Vision [LOCKED 2026-06-19]

**Each user's agent must deeply understand them and represent them to the world of agents.**

### What "full context" means for each user agent
- Social graph: friend circles with different intimacy levels and group dynamics
- Preferences: food allergies, dietary restrictions, activity types, budget, vibe preferences
- Availability patterns: typical schedule, blocked times, preferred windows
- City context: neighborhood, usual venues, what's happening locally
- History: who they've seen recently, what they've done, what went well
- Communication style: how they talk to different friend circles

### Agent-to-agent first, user second
When coordination is needed:
1. Host agent queries guest agents for availability, hard constraints (allergies, opt-outs)
2. Guest agents respond on behalf of their users — no user needed for logistics
3. Only escalate to the human when: preference tie-breaking, expressive content, or irreversible decisions
4. Users should feel like things just got handled — not like they're managing a group chat

### Privacy in agent-to-agent communication
- Hard constraints cross freely: "can't eat shellfish", "unavailable after 10pm"
- Soft preferences stay scoped: agents negotiate but don't dump full profiles on each other
- Exclusion reasons never cross the wire
- Each agent advocates for their user's interests, like a good EA

### Build order for this vision
1. **User preferences schema** — food allergies, activity types, budget, neighborhood, vibe
2. **Rich state snapshot** — preferences injected into every agent call, not just events/calendar
3. **MCP agent-to-agent protocol** — structured queries between agents (availability, hard constraints)
4. **City/events awareness** — what's happening locally, integrated into suggestions
5. **Friend circles** — different priority/intimacy groups, agent knows which circle applies
6. **Cadence intelligence** — who hasn't been seen in a while, what's the right nudge

The user should feel like they have a brilliant EA who knows them deeply, handles everything quietly, and only surfaces what actually needs their attention.

---

## 7. Test suite — mandatory reading before any code change `[LOCKED]`

**Location:** `butterflai-repo/web/tests/` — full developer docs at `web/tests/TESTING.md`

**Current state (2026-07-16, updated):** 327 tests passing across 13 files.

### system-prompt.test.js — behavioral rule coverage `[LOCKED]`

**File:** `web/tests/integration/system-prompt.test.js`
**Purpose:** Asserts that every behavioral guardrail and interaction-pattern rule is present in the text the LLM actually receives. Tests call `buildSystemPrompt()` (exported from `agent.js`) and assert on string content — no Anthropic API calls needed.

**Process — mandatory for every new interaction pattern or rule:**
1. Identify the rule (from real usage, a bug postmortem, or a product decision)
2. Encode it clearly in the system prompt in `buildSystemPrompt()` (in `web/agent.js`)
3. Add an assertion in `system-prompt.test.js` that checks for the canonical phrase
4. Run `node --test tests/integration/system-prompt.test.js` — must be green before commit

**Examples of rules already covered (33 assertions as of 2026-07-16):**
- Self-identify + STOP on every first outbound contact
- `send_contact_invite` is ONLY for Tier 0 onboarding — NEVER for social invites → use `create_social_event`
- "invite my [group] to [X]" → `manage_contact_group` → `create_social_event` with all members
- Vague time ("tonight") → ask invitees or host, never invent a time like 7 PM
- Expressive messages need user approval before send; logistics can auto-run
- Contact edit conflict: contact's version wins, user notified
- Plan disclosure is pull-not-push, only to host-chosen invitees
- Exclusion reasons never cross agent-to-agent wire
- FLAI: capability language only, no balance/score shown ever
- One clarifying question max; direct commands execute immediately

**When a new pattern is found in production:**
- Do NOT just fix the code. Also update `system-prompt.test.js` so the fix can't regress.
- The test is the durable memory of "we learned this the hard way."

```
tests/unit/
  cadence.test.js       8 tests  — isNudgeDue(), buildNudgeText() pure logic
  flai.test.js         10 tests  — FLAI ledger, burn hooks, baseline grant, stubs
  lift.test.js          5 tests  — estimators, discovery stub, inputs JSON
  referral.test.js      8 tests  — token idempotency, round-trip, redeem, reward

tests/integration/
  auth.test.js         12 tests  — OTP, JWT, protected route redirects (security)
  api.test.js          11 tests  — health, user, contacts, dashboard, referral
  onboarding.test.js    7 tests  — web signup, referral redemption, setup wizard
  sms-flows.test.js     9 tests  — STOP, START, nudge confirm, attendance batched
  events.test.js       ~80 tests — event dedup, event_type, RSVP, notifications,
                                   management endpoints, public RSVP, nicknames,
                                   profile update, push subscriptions
  rendering.test.js    83 tests  — PWA meta tags (all pages), mobile layout,
                                   manifest.json, sw.js compliance, static assets,
                                   install-prompt.js, update-check.js, auth guards

tests/consent.test.js  12 tests  — consent gate, opt-out, E.164 (legacy, keep)
tests/coordination.test.js 5 tests — agent-to-agent MCP stubs
```

**Run tests:**
```sh
cd butterflai-repo/web
npm test               # all 283 tests — run this before every commit
npm run test:unit      # unit only (~1s)
npm run test:integration  # HTTP tests (~5-10s)
npm run test:eval      # LLM agent evals (slow + costs credits — manual only)
```

**Sandbox constraint:** The sandbox cannot compile `better-sqlite3` from source.
- `better-sqlite3` binary must be fetched via `npx prebuild-install --download` after any `npm install` wipes it.
- Current working version: `12.11.1` (has Node v127 / ABI prebuilts).
- `NODE_ENV=development` is required for devDependencies (supertest) to install.
- Never run bare `npm install --ignore-scripts` without backing up + restoring the binary first.

### Rules the agent MUST follow `[LOCKED]`

1. **Every new route, migration, or feature ships with tests.** No exceptions. If you add a table, add DB helper tests. If you add a route, add an integration test. If you add a tool to the agent, add an eval scenario.

2. **Every bug fix ships with a regression test** that would have caught the bug. Bugs caught by tests in this project: static middleware auth bypass, phone validation, migration 018 duplicate column, updateContact missing nickname in allowlist, conversation_history CHECK constraint blocking system role, referral redirect expectation mismatch.

3. **Run `npm test` before every commit.** CI does this automatically (push to main → tests → deploy), but always verify locally first.

4. **Never delete or skip tests to make the build pass.** Fix the code or fix the test (with a comment explaining why the test expectation changed).

5. **Rendering tests (rendering.test.js) must stay green.** They enforce mobile layout correctness — failures here mean real users on Android/iOS will see broken UI.

6. **After adding a migration, check `ensureEventTables()` in multiparty.js** — if you add columns to `social_events` or `event_invitations`, add them to both the migration AND the `CREATE TABLE IF NOT EXISTS` in `ensureEventTables()` so tests (which run fresh) see the right schema.

4. **When tests fail, fix them before shipping.** Do not comment out, skip, or delete tests to make a build pass. If behavior changed intentionally, update the test AND the TESTING.md docs.

5. **When adding a migration,** add it to the right directory:
   - `db/migrations/` (root) for files `001`–`008` (shared base)
   - `web/db/migrations/` for files `009`+ (web-layer)
   - `db.js` applies both directories in sorted order. Tests and production are identical.

6. **Integration tests use `:memory:` SQLite.** Each test file gets a fresh DB with all migrations applied. Never rely on pre-existing DB state — set up all fixtures in `before()` hooks.

7. **No real external calls in tests.** Always inject `sms._setClient(mockClient)` before tests that trigger SMS. Never set `ANTHROPIC_API_KEY` in unit/integration tests. Eval tests (`test:eval`) are the only place real API calls happen.

### CI/CD pipeline `[LOCKED]`

```
git push (any branch)  →  GitHub Actions runs npm test
git push main          →  tests pass → flyctl deploy --remote-only (auto)
```

**Required GitHub secret:** `FLY_API_TOKEN` (set in repo Settings → Secrets → Actions). Without it the deploy step fails but tests still run.

**Nightly eval job:** `.github/workflows/eval.yml` — runs agent evals against real API. Requires `ANTHROPIC_API_KEY` + Twilio secrets. Trigger manually or it runs at 06:00 UTC.

### When tests need updating

| Situation | What to do |
|---|---|
| Added a new API route | Add a test in `tests/integration/api.test.js` or a new integration file |
| Added a new migration / table | Add DB helper tests in the relevant `tests/unit/` file |
| Added a new SMS pending action type | Add a test case in `tests/integration/sms-flows.test.js` |
| Changed existing behavior | Update the test that covers that behavior; do not delete it |
| Added a new agent tool | Add an eval scenario in `tests/agent-eval.js` |
| Fixed a bug | Add a regression test that would have caught it |
| Added a FLAI burn event | Add it to `tests/unit/flai.test.js` — verify it never throws |

### Hard-learned implementation details `[LOCKED]`

These are specific facts about the current implementation. Do not change them without updating this list.

1. **`agentStatusEl` is module-scope in `chat.html`** (top-level `<script>`, not inside any function). It is declared alongside `messagesEl`, `inputEl`, `typingEl`, etc. Do not move it inside a function — other handlers reference it across scope boundaries.

2. **`buildSystemPrompt(user, stateSnapshot, { sensitiveMode } = {})`** — third argument is a destructured options object. Signature is `(user, stateSnapshot = '', { sensitiveMode = false } = {})`. Do not collapse `sensitiveMode` into a closed-over variable or revert the third param. The test suite in `system-prompt.test.js` calls this directly and depends on the third param being injectable.

3. **`catchUpMessages()` poll floor is `pendingSince - 5`** — subtracts 5 seconds to absorb client/server clock skew. Only renders assistant-role messages when `pendingSince > 0` (filters out user echoes); when no response after 90s, clears `pendingSince` and gives up. Never simplify this to `pendingSince` directly — you'll miss the message edge case.

### Sandbox note (local dev)

The OpenClaw sandbox (Node 22) cannot compile `better-sqlite3` from source — compilation is killed by resource limits. Tests still run because a pre-compiled binary is available at:
```
butterflai/web/node_modules/better-sqlite3/build/Release/better_sqlite3.node
```
Copy it to `butterflai-repo/web/node_modules/better-sqlite3/build/Release/` if the binary goes missing.

GitHub Actions (Node 20, ubuntu-latest) builds everything cleanly from `npm ci` — no workaround needed in CI.

---

## 8. Rearchitecture: coordination + privacy `[LOCKED 2026-07-17]`

Owner locked a rearchitecture of the two weakest subsystems. **Full design: `docs/REARCHITECTURE.md`** (read it before touching coordination or crypto). Summary of locked decisions:

1. **Privacy → confidential compute (TEE).** `[LOCKED 2026-07-17]` Private-data decryption moves into an attested enclave (AWS Nitro / GCP Confidential Space). KMS releases the data key **only** against a matching enclave attestation, so the operator genuinely **cannot** read private data. This *upgrades* §3.8 and the `private_data_model` yaml: the "trust-based, we hold the keys" model was the interim; the target is attestation-gated. Until the enclave ships, §3.8 still describes reality — state it honestly.
2. **Coordination → federated agents + enforced protocol.** `[LOCKED 2026-07-17]` Converge on the typed `butterflai-coord/1.0` protocol; retire the deployed free-text `message_agent` relay. Add per-agent Ed25519 identity (anchored to wallet/Base — this is the retained wallet-identity role, path to ERC-8004), signed messages, and **attestation-gated cross-agent data release**. This is the chosen answer to **Open Q1 (§5.1)** — non-retention is *verified* (a peer releases data only after the requester proves by attestation it runs purging code), not promised. Q1 stays open until built, but the mechanism is decided.
3. **Reasoning model = Anthropic, in the trust set, zero-retention, disclosed.** `[LOCKED 2026-07-17]` The enclave calls Claude for reasoning; Anthropic is a named, disclosed member of the trust set under zero-retention terms, and the enclave minimizes plaintext sent (derived facts, not raw private notes). Public claim names Anthropic; never claim "no one can read it" in v1. Self-hosting the model in-enclave is the north star.
4. **Infra = AWS/GCP for the enclave.** `[LOCKED 2026-07-17]` The Gateway (SMS, web, ciphertext storage, routing) stays on Fly; the sensitive-compute enclave runs on AWS/GCP.
5. **The OpenClaw agent is the system Guardian.** `[LOCKED 2026-07-17]` It uses its heartbeat to continuously run the privacy/coordination tests, verify the purge job deleted, watch the audit log for anomalies, verify enclave attestation health, and flag invariant drift — from **outside** the plaintext boundary (it never holds the enclave key post-Phase-2). See `docs/REARCHITECTURE.md` §2.4.

**Build order:** Phase 0 (no TEE needed) first — make `purge_after` actually delete ✅, close the agent-query context leak ✅, fail closed on missing secrets ✅, and wire the Guardian heartbeat (joint w/ OpenClaw). Then identity+isolation, then the enclave, then attestation-gated federation. Each phase stays deployable.

**Crypto-store finding (2026-07-17):** the two private-data stores are NOT redundant. `crypto.js`→`private_data` = prefs blob under the strong KMS-wrapped per-record scheme (also the calendar-token cipher); `sensitive.js`→`user_private_data` = categorized sensitive facts (health/sexual/legal) under a weaker single derived key. So the most-sensitive data has the weaker crypto. Re-keying `user_private_data` onto the KMS-wrapped scheme is **deferred to Phase 2** (the enclave re-keys everything anyway — doing it now would re-key twice). See `docs/REARCHITECTURE.md` Phase 2 item 10.

> **Canonical docs (2026-07-17):** Shared project docs now live at **repo root** — single source of truth. This file is the merged canonical `MEMORY.md` (combines the former root behavioral sections + the `.claude/` test-suite + rearchitecture sections). The `.claude/` duplicates were removed; `.claude/` now holds only `settings.local.json` (Claude Code config). Session history moved to `docs/sessions/`. `CLAUDE.md` imports project docs from root and reads OpenClaw's identity files from `workspace/`.
>
> **Deferred to a joint session with the OpenClaw agent** (owner-directed, do NOT do unilaterally): rewriting `workspace/AGENTS.md` so OpenClaw reads/writes these root docs (and stops regenerating a separate copy), and removing the now-stale `workspace/MEMORY.md`. Until then, `workspace/` is left untouched and OpenClaw still boots from its own copies.

---
*Update this file as decisions move from `[DEFAULT]`/`[OPEN]` to `[LOCKED]`.*
