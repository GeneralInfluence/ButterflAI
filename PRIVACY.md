# PRIVACY.md — Privacy Constitution

> **This document defines absolute behavioral invariants for ButterflAI.**
> Each invariant has a corresponding test in `web/tests/privacy.test.js`.
> No feature may ship that breaks a test in that file.
> No invariant may be weakened without explicit owner sign-off and a git commit message that names this file.

---

## What "sensitive data" means

Sensitive data is any information that, if leaked, could embarrass, harm, or expose a person:

- **HEALTH** — medical conditions, test results (including STI), medications, disabilities, pregnancy
- **SEXUAL** — sexual behavior, orientation (if private to the user), sexual health
- **FINANCIAL** — debt, income struggles, bankruptcy, financial hardship
- **LEGAL** — criminal record, lawsuits, arrests, legal disputes
- **MENTAL_HEALTH** — therapy, psychiatric diagnoses, mental health medications
- **RELATIONSHIP** — affairs, private breakup details, relationship struggles the user hasn't disclosed

General preferences (food, activities, schedule, vibe, budget range) are NOT sensitive.

---

## Invariant 1 — Sensitive data is stored separately and encrypted

**What:** Sensitive data NEVER goes into `user_preferences` (plaintext).
It goes ONLY into `user_private_data` (AES-256-GCM encrypted per record).

**Why:** `user_preferences` is readable for coordination (allergies, diet). Sensitive data must not travel with it.

**Test:** `privacy.test.js` → "sensitive data never stored in user_preferences"

---

## Invariant 2 — Sensitive data is never readable by another user's agent

**What:** No agent-to-agent pathway may return another user's sensitive data.
`get_contact_hard_constraints` returns null for all sensitive fields if `sharing_approved` is not set per-category.
Sensitive data does not appear in any `agent_messages` payload.

**Why:** Even if User B's agent asks for User A's health data, User A must have explicitly approved sharing that category with User B specifically before any data crosses the wire.

**Test:** `privacy.test.js` → "sensitive data never in agent_messages payload" and "get_contact_hard_constraints returns null without consent"

---

## Invariant 3 — Exclusion reasons never leave the user's agent

**What:** Why someone was NOT invited to an event is never serialized into any agent-to-agent message, SMS, or API response visible to another user.

**Why:** "I didn't invite Marcus because he makes things weird" is private social judgment. It must never reach Marcus's agent or anyone else.

**Test:** `privacy.test.js` → "exclusion_reason never appears in agent_messages"

---

## Invariant 4 — API authorization boundaries are enforced at the HTTP layer

**What:** User A cannot read User B's preferences, private data, conversation history, or audit log via any API endpoint, regardless of what they put in the request.

**Why:** Authorization must not depend on the LLM declining to reveal something. It must be enforced in code before the data is ever fetched.

**Test:** `privacy.test.js` → "cross-user data access returns 403"

---

## Invariant 5 — Every first outbound contact self-identifies as ButterflAI

**What:** The first message any agent sends to a contact who has not opted in must identify itself as ButterflAI and offer an opt-out. This is non-negotiable regardless of how "natural" the agent wants to sound.

**Why:** Impersonating a human to initiate contact is deceptive and illegal in many jurisdictions.

**Test:** `privacy.test.js` → "first contact SMS contains self-identification and STOP opt-out"

---

## Invariant 6 — Uncertain sensitivity defaults to private

**What:** When the sensitivity classifier is uncertain, data is treated as sensitive by default. The agent tells the user what it's doing and asks for confirmation. The user may downgrade to general; the agent may not upgrade from general to sensitive without user awareness.

**Why:** A false positive (treating general data as sensitive) is recoverable. A false negative (leaking sensitive data as if it were general) is not.

**Test:** `privacy.test.js` → "classifier uncertainty defaults to sensitive treatment"

---

## Invariant 7 — Sensitive mode flag propagates unconditionally

**What:** When a user activates "sensitive mode" (explicit UI toggle or `/private` command), ALL statements in that conversation session are routed to `user_private_data` regardless of classifier output, until the user turns it off.

**Why:** Users should have a reliable escape hatch. If they say "this is private," it is private, full stop.

**Test:** `privacy.test.js` → "sensitive mode routes all content to private store"

---

## Private-data sharing: per-edge consent `[LOCKED 2026-07-17]`

Consent to share private information is **per user-pair** — a directed edge between two nodes
in the ButterflAI network, for one specific datum. There is no global "share with everyone"
setting. This is the enforcement of Invariant 2 ("approved sharing that category with User B
*specifically*"), generalized to all private data.

**How information becomes private:**
1. The user enters **private mode** (explicit — everything that session is private, Invariant 7), or
2. The **classifier** flags it as possibly sensitive and it is treated as private by default
   until the user says otherwise (Invariant 6).

**When the user is asked to approve a share:** either **immediately after classification**, or
**lazily at coordination time** when that private item would genuinely help (e.g. a dietary or
health constraint for a dinner). The agent asks "share [item] with [contact]?" and only on an
explicit yes records the per-edge approval.

**Enforcement (in code, not prompt):**
- Storage: private data lives encrypted in `user_private_data` with a per-record
  `sharing_approved_to` list of user_ids (`sensitive.js`).
- Grant / revoke: `approveSharing` / `revokeSharing` (owner, dataKey, otherUserId); the agent
  tools `approve_private_sharing` / `revoke_private_sharing` call them only after user consent.
- Read: `readPrivateDataForSharing(owner, dataKey, requester)` returns the value ONLY if the
  requester is in the approved list, and logs every attempt. `get_contact_hard_constraints`
  uses this — it can never return a private datum the owner did not approve for that requester.
- **Deprecated:** the global `health_sharing_approved` boolean no longer gates anything.
  Existing global approvals do NOT grant per-edge access — users re-approve per contact.

**Test:** `tests/unit/health-notes-encryption.test.js` (per-edge share/withhold/revoke, no
cross-user leak) and `privacy.test.js` Invariant 2.

---

## Using private data: act on it, never say it `[DESIGN 2026-10-05 — steps 1–2 built]`

> **Status:** owner decisions locked 2026-10-05 (below). Private-mode hardening and
> `act_on` avoid-lists (for invites) are built; per-person sharing beyond health notes and
> the `context` class are not. See "Current state" for exactly what works.

### Why private data exists at all

Users tell ButterflAI private things ("make sure my STI results don't get out", "I don't
want to hang out with Julie") because they want the agent to **use** them, not just hold
them. A store the agent writes to and never acts on is decoration. The guarantee we make
is about what gets **said**, not what gets **used**:

> **Private data shapes what the user's own agent does. It never appears in what any
> agent says to anyone else — except an individual datum the user approved for a
> specific person (per-edge consent, above).**

This is the existing rule from `IMPLEMENTATION.md` §1 — *agents propose and respond, they
never explain* — applied to all private data. Julie's agent can observe that Sean is "not
available Friday"; it never learns why. A peer may infer a pattern over time; that
inference asymmetry is accepted (same as `IMPLEMENTATION.md` §1). Explicit transmission
is not.

### Plain-text vs private, by use

| | Plain-text preferences (`user_preferences`) | Private data (encrypted store) |
|---|---|---|
| Examples | allergies, diet, availability, vibe, neighborhood | avoid-lists, STI/health, private notes about people |
| In the agent's prompt | always, verbatim | only minimized, derived facts, when a task needs them; every read audit-logged |
| Crosses to other agents | yes, as hard constraints | never — only the *result* of a decision |
| Shown to contacts | as needed for logistics | never, except a per-edge-approved datum |

### Three use classes

Every private datum is stored with one of these classes. The class decides how it may be
used.

1. **`act_on` — act on, never say.** Example: "don't put me in plans with Julie."
   - Code removes the person when resolving candidates, building suggestions, and choosing
     invitees (`multiparty.js`, `coord-loop.js`, `coordination.js`). Deterministic, not a
     prompt instruction — the model never needs to see the reason.
   - Inbound opportunities: an invite/probe from (or centered on) an avoided person gets a
     neutral outcome — answered "not available" / `reject {}`, or surfaced privately to the
     user. Which one is an open question (below).
   - Outbound: only the resulting proposal (a plan without Julie). No reason, no hint, no
     "can't because…".
2. **`share_with_approval` — say only to people the user approved.** Example: STI results.
   - Withheld by default. Disclosed only via `readPrivateDataForSharing` to a user on the
     datum's `sharing_approved_to` list (already built for health notes).
   - The agent asks at the moment sharing would help ("share this with Alex?"), not up
     front, and records the approval for that one person only.
3. **`context` — inform the user's own agent only.** Example: "Marcus is going through a
   breakup."
   - May shape tone, timing, and suggestions *to the user*, and reminders to the user.
   - Never disclosed, never used to message Marcus with sentiment the user didn't see
     (expressive messages still need the user in the send path, `MEMORY.md` §4).

### Enforcement points (in code — the prompt is not an enforcement layer)

- **Storage is structured, not prose.** An avoid-list is `{ class: 'act_on', subject:
  <contact_id>, scope: 'all_social' | <activity> }`, not the user's sentence. Derive and
  discard (`IMPLEMENTATION.md` §2.3): keep the operative rule, drop the confession.
- **Owner read path.** A server-side function returns *derived* facts for planning
  (e.g. "contact 42 is excluded from social plans") and logs the read. The raw value and
  the user's original words are not returned to the model.
- **Filters live where decisions are made:** candidate resolution, invite composition,
  inbound probe/invite handling. Each has a test that an excluded contact never appears in
  any outbound payload, SMS, or `agent_messages` row.
- **Private mode is enforced in code:** while on, tools that write plain-text data
  (`update_preferences`, agent notes) refuse; and the message is not stored in plain text
  in `conversation_history` (a placeholder is stored instead). Closes the gap with
  Invariant 7.
- **No new cross-agent field.** The `butterflai-coord/1.0` payloads stay enum/typed-only;
  `reject` stays `{}`. Use classes add no wire format.

### Current state (updated 2026-10-05)

**Built (steps 1–2):**
- **Private mode is enforced in code.** `update_preferences` and `save_agent_note` return
  `PRIVATE_MODE_ON` while it's on (`agent.js` `PLAINTEXT_WRITE_TOOLS`). The user's SMS/web
  message and that turn's reply are stored only encrypted (`conversation_history.private_*`,
  `text` = placeholder); the queued `inbound_messages` copy is scrubbed; only the owner's
  `GET /api/chat/messages` decrypts. The chat page loads the real state
  (`GET /api/chat/sensitive-mode`) and the banner no longer over-promises.
- **`act_on` avoid lists** (`web/avoid.js`, table `avoid_list`): encrypted payload (only
  `user_id` plaintext), every read in `private_data_access_log`, no expiry, no reason stored.
  Agent tool `manage_avoid_list`; owner routes `/api/user/avoid-list`; Settings UI.
  Enforced in `multiparty.inviteContacts` (the single invite choke point):
  host's avoided contacts are skipped (`avoided` returned → `avoided_not_invited`);
  an invite from an avoided person is auto-declined via the same host notice as a manual
  decline (`queueHostRsvpNotice`) or, with `ask`, flagged `needs_owner_decision` and the
  invitee prompted; any group containing an avoided person (incl. added later) asks.
- **Agent activity log** (`agent_activity`, encrypted descriptions): every automatic
  decline and every "asked you" is recorded; Settings → Agent activity, with
  "Ask me next time" to fine-tune.
- Tests: `web/tests/integration/avoid-list.test.js`, rendering + system-prompt assertions.

**Known limitations (not yet addressed):**
- An auto-decline happens immediately; a host watching closely could notice the instant
  response. Mitigation (randomized delay) needs a scheduler — not built.
- The agent sees a placeholder for earlier private-mode turns, so it can't refer back to
  them. Facts it needs should be stored with `store_private_data` / `manage_avoid_list`.
- Replies sent by **SMS** in private mode still travel over the carrier in plain text.
- Avoid lists act on invites only. `message_agent` to an avoided contact and the
  (currently inert) desire-coordination candidate resolution are not yet filtered.
- `crypto.js` private-prefs store still has no writer; `sensitive.js` facts still have no
  owner read path for planning (steps 3–4).

### Build order

1. ✅ Private-mode hardening (code-enforced writes, no plain-text history copy, real state
   on page load, honest banner).
2. ✅ `act_on` avoid-lists end to end for invites: encrypted storage, per-person policy,
   enforcement in `inviteContacts`, inbound handling, activity log, tests.
3. Generalize per-edge approval (`share_with_approval`) beyond health notes; ask at the
   moment of need.
4. `context` class: minimized owner read path for tone/timing.

Store consolidation onto one cipher stays in Phase 2 (`docs/REARCHITECTURE.md`); this
design works on either store and should not wait for it.

### Invariants 8–9 `[LOCKED 2026-10-05 — enforced for invites]`

- **Invariant 8 — Private data is used, not said.** No `act_on` or `context` datum, or its
  reason, appears in any `agent_messages` payload, coordination message, SMS, or API
  response visible to another user. An automatic decline is indistinguishable from a
  manual one in content. Test: `avoid-list.test.js` → "auto_decline: declined, host gets
  the ordinary decline notice, no reason anywhere".
- **Invariant 9 — Exclusions are enforced in code.** An `act_on` subject is never
  invited, regardless of model output. Test: `avoid-list.test.js` → "inviteContacts
  skips an avoided contact" and "create_social_event tells the agent who was left out".

### Owner decisions `[LOCKED 2026-10-05]`

1. **Invites from an avoided person: per-person setting, default automatic.** The agent's
   job is to minimize questions while maximizing fun, so an avoid-list entry defaults to
   `auto_decline` (answer "not available", never a reason). Each entry can be switched to
   `ask` ("ask me when Julie invites me, but not when Nate does"). The user can see every
   automatic action in an **agent activity** log and fine-tune from there.
2. **Group events that include someone on the avoid list: always ask.** The agent prompts
   its user before responding, regardless of that entry's per-person setting. This also
   applies when the avoided person is added after the user was invited.
3. **Avoid lists do not expire.** They persist until the user removes an entry.
4. **Private-mode messages are kept encrypted,** visible only to their owner in chat
   history. The agent's own history sees a placeholder, not the text.

---

## Test-user agent trace `[LOCKED 2026-10-05]`

For the friends-and-testers program, the agent's work is recorded so problems can be
understood without pulling server logs (`web/trace.js`, table `agent_trace`).

- **Opt-in only:** recorded only for users with `test_user = 1` (Settings → Help improve
  ButterflAI). The toggle text discloses what is recorded and for how long.
- **What:** each turn's incoming message, every tool call (name, input, result, duration),
  the reply, and errors/stuck turns.
- **Private-mode turns** record only which tools ran — no message, inputs, results or reply.
- **Redacted always:** `value` / health / sexual-health / private notes / exclusions fields,
  decrypted private prefs (`get_private_preferences`), avoid-list names.
- **Retention:** 30 days, then hard-deleted by the coord-loop purge tick
  (`trace.purgeOld`). Viewable by the admin only (`/admin/feedback`, Activity tab).
- **Test:** `web/tests/integration/agent-trace.test.js`.

---

## Rules for contributors (including the agent)

1. **Any migration that adds a column to `user_preferences` must be reviewed against Invariant 1.** If the column could hold sensitive data, it belongs in `user_private_data` instead.

2. **Any new API route that returns user data must check `req.user.id === target_user_id`** before fetching. No exceptions.

3. **Any new agent tool that crosses user boundaries must be reviewed against Invariant 2.** If it can return data about User B to User A's agent, it needs a consent check in code, not in the prompt.

4. **The system prompt is not an enforcement layer for privacy.** Rules in the prompt may be misinterpreted. Privacy invariants are enforced in code and verified by tests.

5. **A link or OAuth `state` that acts for a user must be signed** (`web/linktoken.js`: user +
   purpose + expiry, HMAC). Never put a bare userId in a link or trust one from a URL/body —
   on 2026-10-09 that let anyone attach their own calendar/contacts to another user's
   ButterflAI, and let unauthenticated API routes read contacts or send as another user.
   Tests: `connect-links.test.js`, `route-auth.test.js`.

6. **When in doubt, don't send it.** The default for all sensitive data is: don't cross any boundary unless there is an explicit, code-verified consent record.

---

## Trust model evolution — confidential compute `[LOCKED 2026-07-17]`

The current trust model is honest but interim: ButterflAI holds the encryption keys and **can** read private data (`sensitive.js` / `crypto.js`), disclosed plainly, controlled by audit + minimization. The owner has locked a move to **confidential compute**: private-data decryption moves into an **attested enclave** (AWS Nitro / GCP Confidential Space), and KMS releases the data key **only** against a matching enclave attestation — so the operator genuinely **cannot** read private data. Full design in `docs/REARCHITECTURE.md`.

This **strengthens** every invariant above; it does not weaken any. Additional invariants that take effect as the enclave ships:

- **Decryption happens only inside the attested enclave.** No operator process (including the Guardian, §below) can obtain the key to decrypt `user_private_data`.
- **Reasoning uses Anthropic under zero-retention, disclosed.** Decrypted data may be sent to the Anthropic API (Claude) for reasoning, transiently, under zero-retention terms. Anthropic is a named member of the trust set. **The public claim names Anthropic; never claim "no one can read your data" — the honest claim in v1 is "our operators cannot read it; it is processed transiently by Anthropic under zero-retention terms."** The enclave sends the model only minimized derived facts, never the raw private blob.
- **Non-retention across agents is verified, not promised.** A peer agent releases another user's data only after the requester proves, by attestation, that it runs the audited code that purges (answers `MEMORY.md` §5 Open Q1).

**The Guardian:** the OpenClaw agent continuously verifies these invariants from outside the enclave (runs `privacy.test.js`, checks the purge job ran, scans the audit log, verifies attestation health). It supervises the boundary without being able to read through it. Note: before the enclave ships, keys are env vars, so this "cannot read" property is a target, not yet a fact — state it that way.
