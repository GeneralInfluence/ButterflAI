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

## Reflection `[2026-10-09]`

The agent reviews its own quiet conversations to catch mistakes it made for its user
(`web/reflect.js`, MEMORY.md §13). The review sees only that user's own conversation and
what was sent for them — the same material their agent already has, sent to Anthropic like
any agent turn; private-mode messages are excluded. Follow-ups go only to that user. What
the review noticed is stored only for opted-in test users (like the agent trace); for
everyone else only the outcome (asked / clear / unsure) is kept.

## Feedback from any screen `[2026-10-12]`

A 👎 tab on every app screen lets a person report what they didn't like (`web/public/feedback.js`).
It captures a screenshot of what's on screen (in the browser; the person sees it and can leave
it out), the page and what it was showing, app version and device. When a plan is on screen,
the server attaches that plan as the person sees it (`plan.js` — only plans they're in).
Screenshots can show friends' names and plans, so: sent only when the person taps Send, viewable
by the admin only (`/admin/feedback`), and **screenshots, screen state and the raw recent
conversation are deleted after 90 days** (coord-loop purge); the written note is kept.

**Every 🐛 becomes a test (2026-10-13):** each report also saves an **anonymized case**
(`feedbackcase.js`) — the plan as the person saw it, its change history and the conversation
about it, with every person replaced by a stand-in name (Aspen, Birch…; the reporter is
"Viewer"), and phone numbers, emails, ids and links removed. It is kept (it is what the
regression test is built from, and test fixtures live in the code repository), so it must
never carry real names: the anonymizer is tested (`feedback-cases.test.js`). Private-mode
messages are never included.

## Ripples that touch private data `[2026-10-13]`

- **Avoid-list heads-up** (`ripples/reactions/avoid-heads-up.js`): when someone says yes to a
  plan, anyone in it still deciding who has them on their avoid list is told in the app
  (never SMS) and their answer is paused. The notice names only who said yes; the reason, the
  avoid list and the fact that a heads-up happened never reach the person who said yes, the
  host, or any agent (Invariant 8). Logged in the user's own agent activity.
- **Plan circle:** agents of people in the same plan (host, or said yes) may share that plan's
  details and their user's availability and hard constraints *for that plan* with each other
  without asking. Decided in code (`plan.inCircle`); plan details enter the prompt only for an
  insider. Private data, reasons and other plans are never shared, inside or out.

## Plans on Google / Apple Calendar `[2026-10-13]`

Plans a person is in are copied to **their own** connected Google or Apple (iCloud) Calendar (`calmirror.js`):
the plan's name, date(s), place, "You're hosting" / "With <host's first name>", and a link to
the plan. Nothing else — no guest list, notes, to-dos or private data. On by default once
a calendar is connected; Settings → Connections turns it off, which removes the entries.

## Answers on a plan `[2026-10-13]`

When a friend's ButterflAI answers your agent's question about a plan, the answer is kept on
that plan for you only (`answers.js`) — exactly what their agent chose to send, nothing else —
so your agent reads it instead of asking again. Other people in the plan don't see it. It is
deleted with the plan.

## Cancelled plans `[2026-10-13]`

A cancelled plan (or one folded into another) is hard-deleted 90 days after it was cancelled,
with its guest list, to-dos, change history, check-ins and calendar records
(`planops.purgeCancelled`). Each person's own chat messages about it stay in their chat.

## What messages were understood as `[2026-10-19]`

Each message a person sends their own agent is first read into the actions it asks for
(`understand.js`) — the same text their agent already sees, sent to Anthropic like any agent
turn; private-mode messages are never read. Each action and the words it was based on are kept
in `understood` so the person can undo it and so corrections can improve the reading; rows are
visible only to that person (chips in their chat) and the admin, and are **deleted after 90
days**.

## Wishes `[LOCKED 2026-10-20]`

People can write wishes — things they'd love to happen (`wishes.js`, MEMORY.md §29). Owner
decisions: matching happens between the agents; nobody browses anyone's wishes.
- **A wish's text is never shown to another person.** A match is made only when it is the other
  person's wish too; both are told only what they have in common ("Hot springs this fall").
- **Names only for people close to you** (you have each other saved). Anyone else is "someone near
  you" until **both** say they're open to meeting — only then are names shared (and each is saved to
  the other's contacts, with a plan for the two). Saying "Not now" tells the other person nothing.
- **Who can be matched:** close people; and people near you (same city or within 80 km, from
  location you chose to share) only if both wishes are open to new people. Each wish has "Only people
  I know". Avoid lists apply both ways.
- Wishes are compared by Anthropic's model inside ButterflAI (like any agent turn); each pair once.
- Wishes end after 60 days and are deleted (with their matches) when removed.

## Spells (ideas ButterflAI imagines for you) `[2026-10-20]`

Once a day ButterflAI suggests a few ideas to a person (`spells.js`). They are built **only** from
that person's own recent messages (never private-mode ones), their own plans and wishes, and public
web search results for their city — **never from other people's conversations**. A friend is named
only if they're in the person's own plans, and never someone on their avoid list (checked in code).
Ideas are kept 7 days; dismissed ones are remembered for 60 days so similar ideas stop.
**Passing ideas on (🐛 #37, 2026-10-20):** when someone taps ✨ Sounds nice on an idea about something
happening near them or something new to try, that idea — its public title only (no person named; the
model writes it and avoid-listed names are checked in code), link included — is passed on to people
associated with them in the same town (friends who saved each other; people they've made plans with
in the last 180 days), shown as "People around you like this" with a count, **never who**. Ideas about
friends or wishes never spread. Avoid lists apply both ways; at most 3 passed-on ideas a day each.
Ideas liked around someone (titles only, no names) also shape what ButterflAI imagines for them. With
few people around, someone could guess who liked an idea — the owner accepted that ("they don't
necessarily know that it's from me").
**Explore (2026-10-20; first called Feed):** a tab of ideas, a page at a time (`ideafeed.js`). Besides a person's own
ideas it shows **public ideas ButterflAI found for other people in the same town** (city or ≤ 80 km) —
only their public titles and links, never who they were for, how many people got them, or any idea
about friends or wishes — with how many people around liked each. Avoid lists apply both ways. Its
"right now" cards show only what the person can already see elsewhere: friends who are out (named),
counts of what people around are out for, friends' shares, and public plans in town.
**Pictures (🐛 #39):** for an idea with a link, ButterflAI's server reads the start of that public web
page once to find the picture it offers for sharing (og:image) — public addresses only (private and
internal ones are refused, including by redirect), nothing about the person is sent. The person's phone
then loads the picture from that site with no referrer, so the site learns an IP address but not which
ButterflAI page showed it.

## I'm out (who's near you now) `[2026-10-20]`

When someone says they're out (`outnow.js`), their phone's location is used to find others out
nearby. **Nobody ever sees anyone's location** — only a rough distance ("under a mile", "~2 mi").
The location is rounded to about 1 km, kept only while they're out, and deleted when the outing
ends or they tap Stop. Friends (people who have each other saved) see each other's first name.
Anyone else is shown anonymously, and only if both chose "open to meeting new people" (which needs
"I'm 18 or older") and are up for the same thing; interest reaches the other person only if it's
mutual, and only then are first names shared. Avoid lists apply both ways. People can add their own
activities ("skiing", "beer at the park"); while out, "Around you, people are up for" shows the
activities of people they could already see (friends, and others open to new people) as counts — no
one named. No dating app is
connected; ButterflAI only sees what a person chooses to screenshot into a Quick note.

## Quick notes about people met elsewhere `[2026-10-20]`

A Quick note ("talking to Sarah on Tinder, she's in Kings Beach") is saved as the user's own
contact — name, where they met (`met_via`) and what the user said about them (`about`). Like
every contact it is the user's alone: never shown to that person, other users or their agents,
and nobody is messaged (there's usually no number). The note goes to Anthropic like any message
to the agent.
A **screenshot** attached to a chat message or a Quick note (or shared to ButterflAI from any app) is read once by
Anthropic's model into a few facts — the app, the person's name, where they are, what they're
into, what was talked about; never anyone's looks — and then discarded: **the image is not
stored** anywhere by ButterflAI. Screenshots can show the other person's profile and messages,
so only those few facts are kept, on the user's own contact.

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
