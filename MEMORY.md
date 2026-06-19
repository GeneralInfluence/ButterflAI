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
  agent_to_agent_channel: mcp
  chain: base                          # encrypted prefs as NFT metadata; wallet integration via ClawBank
channels:
  human_to_own_agent: sms              # voice-to-text on phone keyboard covers "talking" to agent
  agent_to_contact: sms                # invites + non-tier2 coordination
  agent_to_agent: mcp                  # never carries private preferences
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
*Update this file as decisions move from `[DEFAULT]`/`[OPEN]` to `[LOCKED]`.*

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
