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

## Rules for contributors (including the agent)

1. **Any migration that adds a column to `user_preferences` must be reviewed against Invariant 1.** If the column could hold sensitive data, it belongs in `user_private_data` instead.

2. **Any new API route that returns user data must check `req.user.id === target_user_id`** before fetching. No exceptions.

3. **Any new agent tool that crosses user boundaries must be reviewed against Invariant 2.** If it can return data about User B to User A's agent, it needs a consent check in code, not in the prompt.

4. **The system prompt is not an enforcement layer for privacy.** Rules in the prompt may be misinterpreted. Privacy invariants are enforced in code and verified by tests.

5. **When in doubt, don't send it.** The default for all sensitive data is: don't cross any boundary unless there is an explicit, code-verified consent record.
