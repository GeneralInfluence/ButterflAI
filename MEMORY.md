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
  agent_to_contact: app_first_sms_fallback   # 2026-10-06: ButterflAI users get it in-app (+push), SMS only if unseen; non-users SMS. See §10
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
  test_suite: live_1055_passing              # see §7 — tests MUST be maintained with every code change; system-prompt.test.js covers behavioral rules
  ci_cd: live                               # push to main → auto-deploy after tests pass
  anthropic_auth: keyless_wif_in_prod       # 2026-10-02: Fly OIDC → Anthropic Workload Identity Federation; no API key anywhere in prod. See §9
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
  - never_say_someone_isnt_in_contacts_or_ask_their_number_without_lookup: true   # [2026-10-09] three turns of "I need Alex's number" without looking; enforced in code (ACTION_CLAIMS)
  - relaying_a_users_answer_keeps_its_meaning: true           # [2026-10-09] Melanie's "how much is a cabin? probably need to reschedule" → "she'd rather reschedule"; questions/hedges checked in code before reply_agent/message_agent
  - an_invite_to_someone_new_needs_no_prior_opt_in: true      # [2026-10-09] the first-contact invite (self-ID + STOP) IS the opt-in; one per person per 30 days; opt-outs respected
  - never_claim_done_unless_a_tool_did_it_this_turn: true      # [2026-10-09] "Added Bam Bam to the group" with no tool call; enforced in code (agent.js ACTION_CLAIMS)
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

1b. **Every behavior change is applied retroactively, in perpetuity** (owner, 2026-10-10: "when we make updates to this app, we need to be retrospective about its applications"). Ship it with a task in `web/retro.js` that brings existing users' data in line — runs once per user who existed before it, from the coord loop. `internal` tasks fix our own data directly; `propose` tasks (anything that creates things or reaches people) only *offer* it to the user in chat. If no retro is needed, say why in the commit message. Test: `tests/integration/retro.test.js`.

1b-i. Retro tasks run for everyone who uses ButterflAI: finished sign-up **or** has talked to their agent (2026-10-13 — Bam Bam's account still said "new" and every task had skipped him).

1c. **Every 🐛 becomes a test** (owner, 2026-10-13: "each caterpillar should become a new test"). Each feedback report saves an anonymized case (`feedbackcase.js`, `feedback.case_json`: the plan as seen, its change history, ripples, the conversation; people as stand-ins Aspen/Birch/…, no phones/ids/links) that outlives the plan. Turn it into a test: `/admin/feedback` → Copy test fixture → `web/tests/fixtures/feedback/<id>.json` with `expect` (replayed by `feedback-cases.test.js`), or a test in `tests/integration` for agent behavior. A report can't be marked Fixed without its test (`test_ref`). The 11 reports from before cases existed are linked to their tests (migration 056; `feedback-backlog.test.js` checks every named test exists) — #2 and #11 needed new fixes: WRITE IT FOR THEM (draft from the gist, don't ask what to say) and `merge_plans` refuses plans the user didn't name (`planNamedIn`).

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

## 9. Anthropic auth: keyless (Workload Identity Federation) `[LOCKED 2026-10-02]`

Prod has **no Anthropic API key**. The Fly machine mints a short-lived OIDC token, the SDK exchanges it for a ~10-min Anthropic access token, and refreshes on its own. The old key was deleted from the Console on 2026-10-02.

- **Single construction point:** `web/anthropic-client.js` → `createAnthropicClient()`. Never `new Anthropic(...)` anywhere else. Order: `ANTHROPIC_API_KEY` (wins if set — local dev, sim, rollback) → token file → GitHub Actions OIDC → Fly OIDC (`/.fly/api` socket). No credentials = explicit error; it **never** falls back to a local `ant` login, so tests cannot make billed calls.
- **Prod config (Fly secrets, IDs only — not secret):** `ANTHROPIC_FEDERATION_RULE_ID=fdrl_012XnXFhZaZ82JSBtoBdzLgL`, `ANTHROPIC_ORGANIZATION_ID=2b9d76fb-b200-4924-ad27-939f48a28915`, `ANTHROPIC_SERVICE_ACCOUNT_ID=svac_01SKgsRBbdK756yhvZYQijo7`, `ANTHROPIC_WORKSPACE_ID=wrkspc_013UDMFnQxx3ereyaBV8DtML`.
- **Fly issuer is `https://oidc.fly.io/sean-gonzalez`** — NOT the `personal` slug `flyctl orgs list` shows. Token `sub` = `sean-gonzalez:butterflai:<machine>`; rule matches `subject_prefix sean-gonzalez:butterflai:*` + `audience https://api.anthropic.com`.
- **Health signal:** agent startup log ends `auth=federation:fly`. `auth=api_key` means a key crept back in; `agent loop disabled` means auth is broken.
- **Rollback:** create a new key in the Console, `flyctl secrets set -a butterflai ANTHROPIC_API_KEY=...` (key takes precedence immediately).
- **Failed exchanges** return an opaque 401; the reason is in Console → Workload identity → authentication history.
- **SDK:** `@anthropic-ai/sdk` 0.131 (upgraded from 0.26 for this).
- **Trust-model note:** this removes the stored Anthropic credential (leak risk); it does not change who can read private data (§3.8 / §8 still describe that). The Phase 2 enclave on AWS/GCP should use the same keyless pattern (both are native WIF providers).
- **Nightly eval (GitHub Actions):** rule `fdrl_011AWBXihUa91RsZqKtRS4dg` (subject `repo:GeneralInfluence/ButterflAI:ref:refs/heads/main`, NO event restriction — scheduled and manual runs must match), service account `svac_01NgzQ2uo7hWjtLD5V4wLTK1`. Repo *variables* (not secrets): `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID` (the workspace ID is required — the exchange 401s without it). Green 24/24 on 2026-10-05. Before that it had never had credentials: the silent RSVP keyword fallback disguised it as "RSVP got unclear" failures; the eval now exits loudly with no credentials and `classifyRsvp` logs failed calls.

## 10. Reaching people: in the app first, SMS as fallback `[LOCKED 2026-10-06]`

Owner decision after the first friends test (Sean got an unattributed text from Allie's agent):

- **Things go through the agents.** Agents message people on their user's behalf. There is
  no person-to-person chat in ButterflAI; real conversation stays in people's own texting.
- **People always know who a message is from.** Every message names the sender:
  "💬 From Allie's ButterflAI: …" in the app, "Allie's ButterflAI: …" by text. The sender
  sees "📤 To Sean (in ButterflAI / by text): …" in their own chat.
- **SMS only if the recipient couldn't reasonably have seen it in the app** (cost +
  noise): delivered in-app with a push; texted if unseen after 30 min; never texted if
  they're in the app or open it first. Non-users: SMS immediately (only channel). An SMS
  opt-out doesn't block in-app delivery.
- **Texted right away instead (rules in code, 2026-10-09 — Melanie hadn't opened the app
  since June):** when the user asks for a text ("text her now", "send him a text", "by
  SMS" — matched on their own words) or when the recipient **doesn't have ButterflAI
  notifications on** and isn't in the app right now (owner rule 2026-10-09 — replaced the
  earlier "inactive 14 days" test). Several unseen messages from one sender go out as ONE
  fallback text.
- **The app asks people to turn notifications on** (`web/public/notify-prompt.js`, on
  Chat/Home/Events/People): shown when this browser isn't subscribed for the logged-in
  account; one tap to enable; iPhone not on the Home Screen gets Add-to-Home-Screen steps;
  blocked permission gets how-to-allow steps; "Not now" hides it 3 days on that device.
- **The user's own agent** (acting on its own: RSVPs, other agents' replies) follows the
  same rule: in their chat if they're there; push + 30-min SMS fallback if notifications
  are on; texted right away if not — never an automatic text while they're looking at the
  app (feedback #6).
- **Answering another agent, the final text reaches no one** (rule in code, 2026-10-09 —
  Allie and Melanie were texted their agent's reasoning about Sean's Grover trip). Only
  `reply_agent` (to the other agent) and `tell_my_user` (a clean message to the user,
  once per turn, blocked if the asker is on their avoid list) reach anybody. The incoming
  "[Agent query …]" is not stored in the user's chat.
- **Links:** the agent may only use the real app links (`web/links.js`). Messages to
  others with a made-up ButterflAI address or a "[…]" placeholder are refused before
  sending; wrong addresses in replies to the user are corrected.
- Code: `web/deliver.js` (`deliverToContact`, `markSeen`, `tickFallback`), table
  `deliveries`, `conversation_history.kind`. Tests: `tests/integration/deliver.test.js`.
- Considered and rejected: becoming a WhatsApp-style messenger (agent would sit in every
  private conversation; people won't move real chats). Adopted the per-message attribution
  instead; a per-person history view is a possible later addition.

## 11. Shared plans, quiet interest, and the Home feed `[LOCKED 2026-10-08]`

Owner decisions after Bam Bam's feedback (his agent revealed a stale July plan when Sean's
agent asked what he was up to — and my fix then had it ping him, which the owner rejected):

- **ButterflAI is not a messenger.** It never pushes people to respond to individuals —
  that's what WhatsApp/texting is for. A per-friend opt-in for direct pings may come later
  (not built; default off).
- **People share plans when they want to, not when asked** — by telling their agent
  (`share_plan`) or one tap on Home ("Free tonight", "Free this weekend", "Laying low
  tonight", or free text). How long a plan holds comes from their wording ("tonight",
  "this weekend", "until friday", "for 3 days"); the agent passes the phrase and
  `datetime.resolveUntil` does the math (default end of tonight = 4am; cap 30 days).
- **"What're my boys up to tonight?"** (`check_friends_plans`, group-aware) answers ONLY
  from what each friend shared with the asker; nobody is pinged. Asking leaves a **quiet
  interest signal** ("Sean's up for something tonight") in each friend's Home feed.
- **Visibility (pull-not-push):** a plan is visible only to the sharer's own contacts, or
  one named contact group; never to anyone on the sharer's avoid list. No interest signal
  reaches someone who avoids the asker. Expired plans/signals are hard-deleted.
- **Home tab = the feed**, ranked: invites waiting on you → your events in the next 24h →
  friends' plans → friends up for something → later events; your own active plans on top.
  Removed: overdue check-ins, coming up. "Invite a friend" lives in Settings.
- **Feed ranking (owner, 2026-10-09): what needs YOU to make progress first, then how
  soon.** Order: invites / questions from friends' ButterflAIs / "lock in the plan" →
  next 24h → friends' plans / interest → questions you're waiting on → later events.
  Looks 60 days ahead (trips are planned weeks out).
- **Tentative events (2026-10-09, the Grover trip):** a trip or plan still being figured out
  is created `tentative` (migration 035) before anyone is messaged — `message_agent` with
  topic "coordination" is refused without its `event_id` (code). Friends clearly in are
  `record_rsvp accepted` ("Interested") → on their ButterflAI calendar; the host sees who's
  interested / not answered; when all have answered, "lock in the plan" (update_event
  tentative: false).
- **Group plans (owner, 2026-10-09 — adding Alex to the Favorite Mama's):** a plan can
  belong to a contact group (`social_events.group_id`, migration 038; `create_social_event`
  `group`). Adding someone to the group — in chat or the app — **always** invites them to the
  group's upcoming plans (tentative too) and sends **one** catch-up (`web/groups.js`): dates,
  place, the host's "plan so far" notes, who's in — never the group's discussion. Users get it
  in-app (usual delivery rules); non-users get one first-contact text with self-ID + STOP.
  Invites go through `inviteContacts` (quiet), so opt-outs and avoid lists apply.
  **Inferred, not declared** (owner: "I don't want to have to say make this a group plan"):
  a plan whose invitees include every member of one group is that group's plan (in code,
  `groups.groupCoveredBy`), including plans made before — they're linked when someone joins.
- **Contacts stay in sync with Google (2026-10-09 — "Alex is already in my contacts"):** the
  first import was one-time and kept nothing; contacts added later were invisible, and
  Google contacts without a phone were dropped. Now the Google grant is stored encrypted
  (`contact_sync_tokens`, migration 039, crypto.js), contacts re-sync daily and whenever
  `lookup_contact` has no exact match (≤ every 10 min), name-only contacts are kept, and
  partial matches are flagged so the agent asks instead of picking the wrong "Alex".
  Users connected before this must reconnect Google Contacts once.
- **Names: matched word by word, nicknames known, aliases learned (2026-10-09, owner:
  "the AI should get used to how users talk about their friends over time").** `web/names.js`
  is the one matcher (agent `lookup_contact` + People search): every word must start a name
  word ("Alex Spargo" → Alexandria Spargo); a built-in nickname list (Liz → Elizabeth) is a
  *likely* match — the agent confirms once; when the user then acts on someone found by a
  non-exact name, that name is saved as the contact's alias (`also_known_as`, in code) and
  is an exact match from then on.
  **Context decides between people with the same name** (owner: "Al" is Allie around Grover
  and the Mama's — someday a different Al from work): each time the user acts on someone,
  the name used + context (plan, activity, place, group, what the conversation was about)
  is recorded (`contact_mentions`, migration 040, `web/mentions.js`, owner-only, 45-day
  half-life; same person+name+context within a day = one row; deleted after 180 days by
  the coord-loop purge — passively accumulated data, §3.6). `lookup_contact` takes `context`; when an alias and a real name both fit, the
  one whose past context matches wins; otherwise the agent asks and says why each fits.
  **The group or plan named decides first (2026-10-19 — "Allie and Alex from my Favorite
  Mama's group": Alex is Alexandria Spargo, in that group, but 15 other Alexes outranked her):**
  members of a group named in the context or the user's words, and people in the plan being
  discussed, who fit the name come first; exactly one → that's them ("why": "in your Favorite
  Mama's group"); two or more → ask. Test: `tests/integration/lookup-circle.test.js`.
- **Dates: a named date beats a weekday (2026-10-19):** "Saturday, October 30 evening" was
  saved as Sat Oct 24 — `datetime.parseDate` now reads "October 30", "Oct 30th", "30 October",
  "10/30", "the 30th" (next occurrence) before weekday names.
- **Time TBD and no invented times (🐛 #22, 2026-10-19):** a day without a time is that day,
  "time TBD" (`social_events.time_tbd`, migration 062; `datetime.resolveDateOnly`; all-day on
  calendars) — not "date TBD" and not a made-up 7pm. In code (`agent.noInventedTime`): if the
  user's recent words name no time, a time in `when` is dropped and a clock time in
  scheduled_at becomes just the day. "The 30th" is one day (my retro had made it Oct 30–Nov 1).
- **Adding people to an existing plan:** `update_event invite_contact_ids` (host) — there was no
  way, so the agent texted Allie, Alexandria and Melanie and the plan had no guests. Rule:
  never send_logistics_sms as an invite; don't tell invitees things the user didn't say.
- **One Google connection (2026-10-09, owner: "everything Google should all be one"):**
  `/auth/google` asks for Calendar + Contacts in one consent (old calendar/contacts entry
  points lead there too); the callback stores whatever was granted and syncs contacts.
  Settings shows real status (`/api/user/connections`: Google Calendar ✓ · Contacts ✓,
  last synced; Apple) and has "Sync contacts now" — it used to always say "Connect Google
  Calendar", even when connected.
- **Deferring on a plan (owner, 2026-10-09 — Allie: "it's Melanie's birthday, not mine"):**
  an invitee can say they'll go with whatever certain people decide (`defer_on_plan`,
  migration 037, `web/defer.js`). **Plan only.** They're in; questions about that plan are
  answered in code with a fixed line ("Allie's happy with whatever Melanie and Sean decide")
  — no model call, nothing shown to them, never their reasons; `message_agent` to them
  about it returns that answer without messaging their agent. They get an **FYI (not a
  question)** when the date, place, lock-in or cancellation changes. Host's card shows
  "Allie: whatever you & Melanie decide", never "waiting on". `undo` to be asked again.
- **Chat by discussion (2026-10-09):** chat messages carry the event they're about
  (`conversation_history.event_id`, migration 036, `web/topics.js`): tagged in code when a
  turn's tools work on one event, otherwise a small Haiku match against the user's current
  events; older messages are sorted in once when a discussion is first opened. Home event
  cards and Events → 💬 Discussion open `/app/chat?event=<id>` (host/invitee only, 403
  otherwise).
  **Plan pills (owner: "this makes it different than WhatsApp — it's not about people and
  groups, it's about events"):** along the top of chat, "All" + one pill per plan (upcoming,
  or discussed in the last 30 days; most recently active first; tentative marked —
  `/api/chat/discussions`). A message sent inside a pill carries that plan
  (`inbound_messages.event_id`, migration 041): the agent gets a "Current discussion" section
  and the turn is filed there.
- **Every conversation is about a plan (owner, 2026-10-09): a new one, an existing one, or
  combining two.** Owner choices: related housekeeping attaches to its plan, else a
  **General** pill; a plan is **created on first mention, no date needed** (`date_tbd`,
  migration 043 — placeholder kept ~45 days ahead by `multiparty.rollDateTbd`, every display
  says "date TBD"); **combining asks first**. In code: a user message outside a pill that no
  tool tied to a plan is routed (`topics.route`: existing / NEW / general); NEW → the agent
  is told to create the plan before replying. `merge_plans` only proposes on the first call
  and runs only when called again in a later message (after the user said yes);
  `multiparty.mergeEvents` moves invitations (more committed status wins), discussion, agent
  threads, mentions, and fills group/notes/date gaps; the other plan is cancelled.
- **Calendar by stage (owner, 2026-10-12):** every plan is on the calendar, colored by stage —
  Idea (no date: "Undated" strip above the grid), Proposed (tentative: amber stripes, on each
  proposed date range), Invited (waiting on you: outline), Confirmed (solid purple), Past
  (faded); multi-day plans span their days; pending invites included. Proposed dates =
  `social_events.proposed_dates` (migration 045, `[{from,to}]`, ≤5 options, ≤14 days each,
  `multiparty.normalizeProposals`); the agent must use dates the user mentioned. Retro:
  undated plans get dates found in their discussion *offered* as proposed dates.
- **Home = Feeling · Creating · Happenings (owner, 2026-10-12).** "What are you up to?" →
  **Feeling**; the plans' shared lists are called **Creating** (Home section between them —
  items assigned to you, soonest plan first; the bar in a plan's chat; Events cards); "Your
  feed" → **Happenings**.
  **All three at a glance (owner, 2026-10-13):** each section is a compact block — title,
  one summary line beside it (`home.homeSummary`, served in `/api/feed` `summary`; purple
  when something needs you), one preview item (your active share + the one-tap shares; your
  next to-do; the top happening) — and › opens it full screen (`/app/dashboard#creating`;
  back closes it): Feeling = share box, your shares, friends' shares/interest; Creating =
  grouped by plan + suggestions; Happenings = the whole ranked feed.
- **The plan is ONE object (owner, 2026-10-12: "operate on single objects, not spaghetti").**
  `web/plan.js` `planFor(eventId, viewerId)` computes a plan once — stage, dates (tbd /
  proposed / set / open + label), days covered, people (in / waiting / out / deferring), who
  was asked and hasn't answered, Creating progress, the viewer's next step; `plansFor(user)`
  lists them; `/api/plans` serves them. The calendar and Home's plan cards read these (the
  page no longer has its own stage logic); "waiting on…" exists only on a plan's card.
  **One plan per name:** `create_social_event` refuses a name the host already has open
  (`PLAN_EXISTS` → update_event) — Sean's plans were created twice, sending the group
  duplicate invites. Retro (internal): duplicates folded into the original; old questions
  tied to no plan closed. Still to move onto plan.js: the agent's own snapshot of events.
- **Every reply is checked for an action that should have happened (owner, 2026-10-12: "we
  need to check the AI responses every time").** `web/actioncheck.js`, after each user turn:
  user message + reply + what tools actually did (+ the plan's stored details when the turn
  is about a plan) → actions asked for / decided / promised / claimed but not done → sent back
  to the agent once to do before replying. Replaced the plan-only check in the loop. Latest
  decision wins (superseded details never count). Also: `update_event cancel` (there was no
  way to cancel a plan, so "delete Grover" ran `delete_desires` and removed 4 desires);
  `delete_desires` now refuses unless the user is talking about desires. Home's Creating shows
  yours, then unassigned ("anyone can take it"), then suggestions waiting per plan.
- **Say it, store it (2026-10-12):** the agent told Sean dates/place ("Oct 23–24 at Carson
  City Hot Springs", "Done", "Let me create both events…") and saved nothing. Now after a
  turn about a plan the user hosts, `plansync.missingDetails` compares what was decided with
  what's stored; anything missing goes back to the agent to save before replying. Claims of
  creating/changing/cancelling a plan need a tool that did it (ACTION_CLAIMS). Retro: details
  decided in older discussions are offered to the host.
- **Plan to-dos (owner, 2026-10-12):** each plan has a to-do list (`event_todos`, migration
  046, `web/todos.js`). Owner choices: **everyone in the plan** (host + invitees) sees and
  changes it; items can be assigned to someone in the plan; **ButterflAI suggests, people
  keep** (`suggested` until kept; never counted in progress). Seen: a to-do bar at the top of
  the plan's chat (check off, keep/dismiss suggestions, add), Home (to-dos assigned to you,
  "needs you"), Events cards (progress + list), and the agent (`manage_todos`). Access is
  checked in `todos.js` for every read/write. Retro: existing plans get suggestions offered.
- **Agent-to-agent:** "what is your user up to" is never answered from memory and never
  triggers a ping; agents answer only from what the user explicitly shared. Every agent
  question is about a plan (§20).
- Code: `web/feeling.js` (shares, interest), `web/home.js` (Home feed + summary) — split from
  the old `plans.js` 2026-10-13 so "plans" means only real plans; `datetime.resolveUntil`,
  migration 033, `/api/feed`, `/api/plans`.
  Tests: `tests/integration/plans-feed.test.js`.

## 14. Feedback from any screen `[2026-10-12]`

Owner: expand the chat 👎 to every screen — one tap captures the app's current state and a
screenshot, then asks what they didn't like. `web/public/feedback.js` (on chat, Home, Events,
People, Settings): a 👎 tab on the right edge → html2canvas screenshot of the visible screen
(served from `/vendor/html2canvas.min.js`, not a CDN) + `window.bflyFeedbackState()` (each
page reports what it shows) + version/device → "What didn't you like, or what should change?"
(screenshot previewed, can be left out) → `/api/feedback` (4 MB limit for this route only).
The server attaches the plan object when a plan is on screen. Admin: `/admin/feedback` shows
the screenshot and state. Migration 047. Screenshots/state purged after 90 days (PRIVACY.md).

## 13. Reflection: looking back, checking in `[LOCKED 2026-10-09]`

Owner, after Melanie's "how much is a cabin? probably need to reschedule" was passed on as a
decision: honest mistakes will keep happening; in-turn guards catch known patterns, and the
agent should also **reflect** — once a conversation goes quiet, look back and, if it may have
got something wrong, ask: "I said this — maybe you meant that?"

- `web/reflect.js`, run from the coord loop. A stretch where the agent acted for its user
  (sent / passed something on) is reviewed once it's been quiet 45 min — never 9pm–8am
  (user's time), each stretch once, at most one follow-up a day.
- A short Haiku review compares what the user said, what was sent for them, and what came
  back: meaning changed, a question dropped, a hedge hardened, something it couldn't know.
- Only if confident (≥ 0.7) it asks — a friendly check-in **in the app** (push, never SMS).
  A correction is fixed with the other side (prompt: REFLECTION FOLLOW-UPS).
- `reflections` table (migration 042): outcome for everyone; what it noticed only for
  opted-in test users → `/admin/feedback` → Reflections tab.

## 14. One plan object: read in plan.js, change in planops.js `[LOCKED 2026-10-12]`

Owner: "operate on single objects, not stringing things together with spaghetti logic" (after
duplicate plans reached friends and Home kept a stale "Waiting on…").

- **Read:** `web/plan.js` `planFor(eventId, viewer)` / `plansFor(user)` — stage (idea · proposed ·
  invited · confirmed · past · cancelled), dates + label + calendar days, people, who's in /
  waiting / deferring, open questions about THIS plan, Creating progress, the viewer's next step.
  Home feed, calendar, Events list, chat pills and the agent's state snapshot all read it.
  Don't re-derive stage or dates anywhere else.
- **Change:** `web/planops.js` `create / update / invite / merge` — the agent's tools, the app's
  routes, group catch-ups and retros all go through it. One plan per name per host; names 1–80
  chars; a chosen date clears proposed options; options with no date = date TBD; FYI to deferrers
  on date / place / lock-in / cancel; host re-checked. Every change is logged to `plan_changes`
  (migration 048: who, via agent|app|retro, field, old → new) — `planops.history(eventId)`.
- **Feedback on every screen:** `web/public/feedback.js` (🐛 tab, sheet labelled "Ideas & bugs", screenshot + the screen's state
  + the plan object when it's about a plan) → `/admin/feedback`. Screenshots/state kept 90 days.
- Tests: `tests/integration/planops.test.js`, `plan-object.test.js`, `feedback-screens.test.js`.

## 15. Ripples: every change to a plan cascades `[LOCKED 2026-10-13]`

Owner: "every change to an event should cascade through the entire system" — an RSVP updates
the guest list, the plan's Creating list, which agents are insiders, and anyone avoiding the
person who said yes.

- **One door:** every plan change, including guest answers, deferring, removing a guest and
  hiding an invite, goes through `planops.js` (`respond`, `recordRsvp`, `publicRsvp`,
  `deferOn`, `removeGuest`, `dismiss`, `askOwner`). Only `planops.js` and `multiparty.js`
  (the storage layer it calls) write `social_events` / `event_invitations` — a test fails
  otherwise.
- **Ripples:** planops records each change in `plan_ripples` (migration 049) in the same
  transaction, then `ripples/index.js` runs the reactions in `ripples/reactions/` once per
  operation; a failed reaction is retried from the coord loop. Kinds of change:
  `ripples.TYPES` (created, renamed, dates/place/details changed, locked_in, cancelled,
  merged, guest_added / responded / removed, deferred, invite_hidden).
- **Reactions:** `host-notice` (one rule for every way an answer arrives), `deferrers-fyi`,
  `creating` (a no or removal frees their to-dos and tells the host), `avoid-heads-up` (a yes →
  anyone still deciding who avoids that person is told privately in the app — "Julie said yes
  to X. Still going?" — and paused until they answer; says who, never why; the person who said
  yes and the host learn nothing).
- **The matrix** (`ripples/matrix.js`): every kind of change × every part of the system (guest
  list, Creating, plan circle, avoid lists, host, deferrers, screens, chat, calendar, change
  log) names a reaction or why nothing is needed. Adding a kind of change or a part fails
  `tests/integration/ripples.test.js` until its row/column is filled in.
- **Plan circle (owner, 2026-10-13):** the host and everyone who said yes (deferring counts)
  are insiders of that plan (`plan.inCircle`, computed live). Answering another agent, the
  agent is told in code whether the question is from INSIDE a plan (gets the plan's details;
  settles logistics without asking its user) or OUTSIDE (hard constraints + what the user
  shared only).
- Screens read `plan.js` live, so they need no reaction.
- **New guests see Creating (owner, 2026-10-13):** the `creating` reaction on `guest_added`
  sends a ButterflAI user one notice in the plan's chat listing its to-dos (who has what,
  what's open) when there are any.
- **Google Calendar mirrors ButterflAI (owner, 2026-10-13):** `calmirror.js` + the `calendar`
  reaction. Every plan someone is in shows on their connected Google Calendar as ButterflAI
  shows it — set date = one timed entry (tentative/free while tentative or not answered,
  "(invited)"); proposed dates = one all-day "(proposed)" entry per option; date TBD = none;
  cancelled/declined/removed/hidden = removed — and follows every change. `calendar_mirror`
  (migration 050) keeps each person's Google event ids; written right away, retried from the
  coord loop; only what changed is rewritten. Settings → Connections turns it off (removes the
  entries). `confirm_coordination_invite` no longer makes its own copy; `create_calendar_event`
  is only for things that aren't plans. **Apple Calendar is mirrored too** (2026-10-13): iCloud CalDAV
  (`calendar-apple.mirrorUpsert/mirrorDelete`, iCalendar built by `toIcs`, stable UID per entry);
  calmirror uses whichever calendar the person connected (one per person). Retro: existing plans
  go onto connected calendars (Google, then Apple), people told once.
- Retro: to-dos still assigned to people who are out are freed (internal); an avoided person's
  existing yes sends the heads-up now (propose).

## 16. Attendance, lift and cadences read plans `[2026-10-13]`

Event-map contradiction #2: the "Did you make it?" check-in, lift and FLAI read the old
`activities` table, which nothing writes, so none of it ever ran for real plans. Now:
- `cadence.plansToConfirm`: plans you hosted or said yes to, with a real date, that ended
  12h–7 days ago, not asked before. Asked in the app (Home card with Yes / No / Skip + a push);
  texted (Y / N / skip, pending_action) only if you have no notifications on (§10).
- `attendance.js` is the one answer path (app `POST /api/attendance/:id` and text replies):
  records it, measures lift, and a Yes resets your cadences with the people who were there
  ("it's been a while" nudges count the plan).
- `lift.js` measures plans; a plan's cadence is found through the people in it (`cadenceFor`).
- `/api/dashboard/upcoming` reads plans. The `activities` helpers in db.js remain only for the
  retained Telegram bot.

## 17. Social desires are plans `[LOCKED 2026-10-13]`

Owner: "make them plans" (event-map contradiction #3 — desires negotiated a time between
agents and ended "scheduled" with no plan anywhere). `web/desireplans.js`:
- `parse_desires` → each **social** desire becomes plans right away, one per time it should
  happen (frequency, max 3): idea stage, tentative, the desire's window as proposed dates
  (≤14 days), named from its kind ("Meal out with a friend or two — week of Oct 13"); people
  the user named are invited. Recurring templates: each spawned instance gets its plan.
  Linked in `desire_plans` (migration 051). The agent is told and never creates a second one.
- Negotiation agreeing a time (`coordination.humanApproved`) sets the next undated plan's date
  and invites who agreed — through planops, so it ripples (calendar, Creating, …).
- Deleting desires cancels their plans nobody has said yes to.
- Solo and protective desires ("work out", "chill night") stay holds for the user's own agent.
- Fixed with it: the `coord_desires` view never had the v2 columns (horizon, candidate_*),
  so recurring desires and named people were silently invisible to the coord loop.
- No retro: prod had no desires.

## 18. One "same plan" rule, and cancelled plans really go `[2026-10-13]`

Event-map #7:
- The 6-hour same-title check in `multiparty.createEvent` is gone; planops' one-plan-per-name
  (`plan.existingByName`) is the only rule.
- The nightly date-TBD roll is `planops.rollDateTbd` (every plan write in planops).
- `[LOCKED 2026-10-13 — owner: "Undo and merged makes sense. 90 days makes sense."]`
  **Cancelled plans are deleted 90 days after cancellation**
  (`social_events.cancelled_at`, migration 052; `planops.purgeCancelled` from the coord-loop
  purge): the plan, its invitations, to-dos, change log, ripples, check-ins, calendar rows and
  links. People's chat messages stay but no longer point at it. Plans cancelled before this
  count from 2026-10-13.

## 19. Shares become plans `[2026-10-13]`

Event-map #5: "Free tonight" lived beside plans and could never turn into one.
`feeling.planFromShare` (`POST /api/shares/:id/plan`, Home buttons): your own share → your
plan (quick shares get a name: "Something tonight", "Something this weekend", "Night in"),
nobody invited yet; a friend's share you can see → a plan you host with them invited
("At Sully's from 9 — with Allie"), through planops (avoid lists, opt-outs, ripples). Proposed
dates: today → the day the share ends. Same person + same share → the same plan
(`share_plans`, migration 053); Home then shows "Open plan". Shares themselves stay
lightweight and expire as before. Agent rule: SHARES BECOME PLANS.

## 20. Every agent question is about a plan; answers land on it `[LOCKED 2026-10-13]`

Owner: "The whole idea is to maximize fun while minimizing communication between people."
Only "coordination" questions needed a plan, and a continued thread replaced the plan id —
in prod none of 15 agent messages were on a plan (event-map #6).
- `message_agent` requires the plan's `event_id` for every topic (create it first, tentative,
  no date needed); the plan is always the thread; replies stay on it.
- `reply_agent` records the answer on the plan (`plan_answers`, migration 054, `answers.js`)
  for the asker only — what the other agent chose to send. Shown on the plan ("Friends'
  ButterflAIs said" in the summary and the agent's Open events).
- **Ask once, in code:** asking the same person the same topic about the same plan returns
  the earlier answer (`NOT_SENT_ALREADY_ANSWERED`) or says it's still waiting
  (`NOT_SENT_ALREADY_ASKED`); `ask_again: true` only when a new answer is truly needed.
- With the plan circle, insiders settle a plan's logistics between agents; people hear only
  what needs them.
- Retro: earlier questions between two people in exactly one plan are linked to it (their
  replies become answers); unanswered ones that can't be linked, or are over a week old, closed.

## 21. The Oct 23–25 weekend regressions `[2026-10-13]`

Sean: "all the events for the weekend of October 23-25 were deleted, Bam Bam was shown as
interested when he said he was going, Melanie said she wants a massage and was asked if that's
a solo thing. This app is falling apart!!" Nothing was deleted — causes and fixes:
- **Home showed one Happening** (my "one preview" default) and undated plans sorted at random,
  so Melanie's weekend was hidden behind Liam's party. Home now shows everything that needs you
  plus plans in the next two weeks (up to 4); proposed plans sort by their first proposed day.
- **Going vs interested:** `event_invitations.going` (migration 057). A yes is "interested" on
  a tentative plan unless they said they're going ("I'm going", "count me in", "I'll be there"
  — tool `going`, or their words, in code). Shown everywhere; the summary offers "I'm going".
- **Massage:** what a user says inside a plan's discussion is about that plan — offer to add it
  to Creating / tell the host, never ask "solo?" (prompt rule).
- **Host RSVP notice** used an undated plan's placeholder time ("Tue, Nov 24, 12:18 PM") —
  now the plan's dates label.
- **"Set up plans from earlier chats"** only knew plans the person hosts → offered Bam Bam
  "Grover", the weekend he was already in. Now includes plans they're invited to; a correction
  went to anyone who got such an offer.
- I now check screens in a real (headless) phone browser before shipping UI changes.
- 🐛 #13–15 (same evening): the phone-only bottom padding on Events and Settings was overridden
  by a later `main` rule (24px) — the calendar's last row hid behind the bottom bar (now `body
  main`, and a test checks every screen). The calendar day you tap travels into the plan's
  discussion (`?day=`, `inbound_messages.context_day`, migration 058) and the agent is told
  ("They opened it from Friday… record it with that day") — Melanie's Friday massage was saved
  as Saturday. Owner: "the tests should ensure the massage is on Friday" → to-dos have a `day`
  (migration 059), set in code from the day the user was looking at unless their own words name
  another (`todoDay`); an idea raised in a plan's discussion must be recorded, not asked about
  (IDEA_WORDS guard + rule); the after-reply check sees the Creating list. Tested with Melanie's
  exact words (scripted) AND nightly with the real model (`tests/eval-massage-friday.js`, part of
  `npm run test:eval`; 10/10 locally, 5 runs nightly). The case anonymizer no longer treats words like "user" in "New user" as a name.

## 22. A change stays inside the plan being discussed; undo from the log `[LOCKED 2026-10-13]`

Sean: "updates to Liam's birthday affected Melanie's birthday. We have some sort of
architecture issue." In Liam's party's discussion ("noon till closing… kids won't last") the
agent also rewrote Melanie's weekend — dropped "Friday: massage" and her proposed dates, set a
wrong date — because nothing tied a change to the plan being discussed.
- **Scope, in code** (`agent.js` `planOutOfScope`, checked in `executeTool` for every
  plan-writing tool: update_event, manage_todos, merge_plans, record_rsvp): in a plan's
  discussion, changing a DIFFERENT plan returns `OTHER_PLAN` unless the user's own words name
  it (`planNamedIn`). Outside any plan (All) there's no restriction. Prompt: ONE PLAN AT A TIME.
- **Undo** (`planops.revert(actor, eventId, { at })`): every change logs its old value, so a
  plan can be put back to just before any logged moment — logged (`via: undo`) and rippled.
  Used once to repair Melanie's weekend (retro, matched to that exact change).
- Tests: `tests/integration/plan-scope.test.js` (Sean's exact message).
- **What the reply says must be what's stored** (Sean: "how do we ensure this going forward
  without me having to use my admin ability?" — the agent said Liam's party was "locked in"
  and left it tentative, 2h instead of ~3h): ACTION_CLAIMS now checks outcomes, not just that
  a tool ran — "locked in / confirmed" needs the plan's `tentative = 0`; a length in the
  user's words ("3 hours", "till 6") needs `duration_mins` saved when the time is set. Each
  kind of false claim gets its own nudge.
- **Hosts fix their own plans in the app** (plan summary): 🔒 Lock it in (when the date is
  set), Recent changes ("ButterflAI changed the notes · 2m ago", `/api/events/:id/changes`),
  ↩︎ Undo last change (`/api/events/:id/undo` → `planops.undoLast`). PATCH also takes
  `tentative`, `duration_mins`.

## 23. Understood first: a message is read into actions before the reply `[LOCKED 2026-10-19]`

Owner, after Melanie's 🐛 #19 ("expecting list of massage places" — she got "who are the other 2
people? what time?"): "we need to somehow map people's conversation into actions in a more
consistent way." Until now the reply model read, chose tools and replied in one go, and code
caught known misreadings afterwards — every new misreading got through until it had a guard.
- **`web/understand.js`, before every user turn** (not private mode, not agent queries): a short
  Haiku read turns the message into typed actions, each quoting the user's own words —
  `add_todo`, `rsvp` (going / interested / declined), `set_details` (host), `lock_in` (host),
  `find_options`, `message`, `cancel`.
- **Code decides each one:** no quote from their words → dropped; a plan they're not in, or a
  different plan than the discussion without naming it (`planNamedIn`) → dropped; host-only
  changes from a guest → the reply offers to pass it on; confidence ≥ 0.75 → done in code
  through `todos` / `planops` (via `understood`, so it ripples and logs); 0.5–0.75 with a
  question → exactly one question with the choices; lower → dropped.
- **The reply model is told** what was done ("don't do these again; confirm them") and what's
  left for it. `find_options` → it must search and list 3–5 options with links before any
  question (in code: no `web_search` in the turn → sent back once). The reply model adding the
  same to-do again in other words is refused.
- **Chips:** what was done shows under the user's message ("✓ Massage · Fri → Creating · Undo";
  answers get "Change": Going / Interested / Not going). `POST /api/understood/:id/undo`.
  Every read is kept in `understood` (migration 060) with its decision; an undo or change is a
  labelled correction (`/api/admin/understood`) → new case in `tests/eval-understand.js`
  (real model, nightly). Rows hold people's words: deleted after 90 days.
- The older after-the-fact checks (ACTION_CLAIMS, the idea guard, actioncheck, plansync) stay
  for now; they see what understand did as tool calls. Retire them as the eval shows the read
  is reliable.
- Retro (propose): anyone who asked for places/options in the last week and got no links is
  offered them in that plan's discussion.
- Tests: `tests/integration/understand.test.js` (scripted), `tests/eval-understand.js` (real).

## 24. Plans are made together: roles, suggestions, items with a team `[LOCKED 2026-10-19]`

🐛 #20 (Melanie's massages became their own plan; Sean's agent: "I can't, Melanie's hosting
it"), then owner: "guests suggest, hosts and co-hosts decide"; "the person the plan is for
should become a co-host automatically"; items: "people can suggest a thing and they would
automatically become that lead, but anybody can decide to try to do something about it. And
once they start taking action, they can make that edit … people shouldn't be able to
accidentally edit stuff that they're not focusing on."
- **Roles** (`plan.roleOf`, `event_invitations.role`, migration 061): **host** (everything;
  only one who cancels, picks co-hosts, changes visibility/group); **co-host** (the host's
  edits — `plan.canEdit`); **guest** (their own answer/going; any other change they make —
  app, agent, understand — becomes a **suggestion**). The person a plan is for is a co-host
  automatically (`plan.forWhom`: "Melanie's …" → Melanie; `planops.autoCohost` on invite);
  the host adds/removes co-hosts (`set_cohost`, `POST /api/events/:id/cohost`, plan summary).
- **Suggestions** (`web/suggestions.js`, `plan_suggestions`): sent to the host + co-hosts (an
  item's lead + team for item changes), in-app "💡 Bam suggests …"; Accept / No in the plan's
  chat and summary, or `decide_suggestion`; accepted = applied as the decider (logged, rippled);
  the suggester is told; they can take it back. Combining plans a guest is in → a suggestion.
- **Creating items** have a **lead** (whoever added it; ButterflAI's suggestions have none until
  kept) and a **team** (`todo_team`: "I'm on it"). Details: when_text, place, status (idea /
  options / chosen / booked), notes. Only the team edits; others' edits are suggestions to the
  team unless they take it on (`join`). Removing: team, host/co-hosts. A repeat of an open
  item is refused and pointed at the existing one; understand.js `update_item` adds details to
  an existing item instead of a new one.
- Co-hosts and hosts get an FYI when someone else changes their plan (`co-creator-fyi`);
  Recent changes say who. Nudges ("Pick dates", "Lock in") stay with the host.
- Retro: co-hosts for the people plans are for; leads for items; Massages folded into Melanie's
  weekend (#20); its five massage items → one "Massages" (Fri before 3pm, Melanie leads, Sean
  on it); repeated items removed. Tests: `tests/integration/co-create.test.js`.

## 25. Connections that stop working are reported `[LOCKED 2026-10-19]`

Owner: "I want to be told when the grants or any other types of connections expire so that way
they can be fixed or reconnected." Sean's Google grant (Calendar + Contacts, one consent)
expired Oct 16 — **Google ends grants after 7 days while the OAuth app is in "Testing"** — and
for three days plans quietly stopped reaching his calendar. The real fix is publishing the
Google OAuth app (Cloud Console → OAuth consent screen → Publish; verification for the
Calendar/Contacts scopes) — owner's action.
- `web/connections.js` (`connection_health`, migration 063): keys `google`, `apple`. Every use
  reports: an auth failure (invalid_grant, 401, refused credentials — not network blips) →
  `broken`; success / a new grant / a new Apple password → `ok` (which also retries the
  calendar entries that failed and re-syncs every plan). Hooked into calmirror, contacts sync,
  `calendar.storeTokens`, `calendar-apple.saveAppleCredentials`.
- **Daily check** (coord loop, every ~20h per connection): forces a Google token refresh /
  iCloud login even when nothing is using it.
- **Told once** when it breaks — in the app (notice + push), by text if they have no
  notifications — what stopped and the Settings link; one reminder after 3 days; no more.
- Settings → Connections shows "⚠️ Stopped working since … — Reconnect Google / Reconnect".
- Tests: `tests/integration/connections.test.js`.

## 26. Rate limits are per person `[2026-10-19]`

The app went "completely unresponsive": every request reached us from Fly's proxy address, so
the whole app shared ONE allowance (100 requests / 15 min; OTP 10, signup 8). Once used up,
everyone got 429 and the chat's 2-second retries kept it used up. Now limits key on
`Fly-Client-IP` (`server.clientKey`), the general limit is 3000 / 15 min (an open chat polls and
streams), /health and /api/version are never limited, and the chat's stream reconnect backs
off 2s → 60s. Test: `tests/integration/rate-limit.test.js`.

## 12. Research & planning tools `[2026-10-09]`

- **Web search + reading pages:** Claude's built-in `web_search_20250305` / `web_fetch_20250910`
  (server tools; basic versions are ZDR-eligible — matches §8.3). Search $10/1,000 + tokens
  (~2¢ per search on Haiku incl. results); fetch is token cost only and can only open URLs
  already in the conversation or search results. Max 5 each per request. Not offered when
  answering another agent (agent_query). The old Brave-backed `web_search` (never had a key)
  and the server-side `fetch_url` (could fetch arbitrary URLs from our server) were removed.
  Brave is cheaper ($5/1,000 with $5/mo free credit) if volume grows.
- **Weather:** `get_weather_forecast` (`web/weather.js`, Open-Meteo, free, no key): 16-day
  daily highs/lows °F, precip, conditions, freezing nights; weekdays labelled in code.
- **Booking:** the agent can't book or pay. It gives the official link + exact details and
  offers reminders; it must never claim it booked. Paying/booking on a user's behalf = the
  future "social budget" (IMPLEMENTATION.md §3), needs its own design + per-booking approval.

---
*Update this file as decisions move from `[DEFAULT]`/`[OPEN]` to `[LOCKED]`.*
