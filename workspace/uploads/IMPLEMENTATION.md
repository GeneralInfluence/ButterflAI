# ButterflAI — Implementation Spec for OpenClaw

> **Reader:** the OpenClaw build agent (has git repo access). This is the build spec derived from a design conversation on 2026-05-21. It supersedes the Telegram-based onboarding in the prior build. Pair this with MEMORY.md (product vision, consent model, open questions). Where this doc and MEMORY.md disagree, this doc wins on *implementation*; MEMORY.md wins on *product intent*.
>
> **Status tags:** `[BUILD]` = implement now. `[STUB]` = scaffold, defer logic. `[OPEN]` = do not build, awaiting human decision.

---

## 0. What changed from the previous build

The prior build used a Telegram bot as the human interface. **Telegram is being removed as the primary human channel.** Reasons: most target users don't have Telegram, we don't want contacts creating bots, and the core use case (recurring social scheduling with close friends) is better served by SMS, which everyone already has. Telegram may return later for international or B2B use cases — do not delete Telegram code, just stop routing primary onboarding through it.

---

## 1. System overview

Three communication channels, each chosen for what it's good at:

| Channel | Between | Transport | Purpose |
|---|---|---|---|
| SMS | Human ↔ their own ButterflAI | Twilio | All human interaction. Voice-to-text on the phone keyboard covers "talking" to the agent. |
| SMS | ButterflAI → a contact (non-Tier-2) | Twilio | Invites; coordination with people who don't have an agent yet. |
| MCP | ButterflAI ↔ ButterflAI | MCP server protocol | Agent-to-agent coordination. Never carries private preferences. |

**Core data-flow rule (the spine of the whole privacy model):**
- Each user's agent is a **silo**. It holds its own user's private preferences and never transmits them.
- Agents coordinate by **proposing and responding**, never by explaining. "Don't invite Julie" never crosses the wire — only the *output* (a proposal that happens to omit Julie) does.
- A receiving agent may, over time, *infer* a pattern (Julie keeps getting dropped) but is never *told* the reason. That inference asymmetry is acceptable; explicit transmission of exclusions is not.

---

## 1.5 Agent topology `[BUILD]` — master + per-user subagents

The system is **one master agent + ephemeral per-user subagents.** Do NOT run one long-lived agent per user (too expensive), and do NOT run a single shared agent that holds multiple users' data in memory (bleeding risk is disastrous here given the private data).

**Master agent:**
- Listens on the Twilio webhook (inbound SMS) and the MCP endpoint (inbound agent-to-agent).
- Resolves identity and routes to the right subagent. **Identity keys: phone number (for SMS) and MCP key (for agent-to-agent).** Both must map to the same `user_id` in the schema.
- Manages subagent lifecycle (spawn, keep-warm, tear-down) and persists outputs (sent SMS, calendar bookings, reservation confirmations).

**Per-user subagent:**
- Spawned on demand when a user has activity. Spawn must be **fast — well under a minute; target sub-second to a few seconds.**
- Bound to exactly one `user_id` at spawn.
- **Stays warm ~60s** after an interaction to absorb quick follow-ups, then dies. Each interaction is treated as a **fresh session** from the user's POV — no conversation memory carried across sessions (fits the atomic, SMS-first UX).
- In-session state is **in-memory only**, lost on tear-down.

**Context access = tools, not prompt-stuffing `[BUILD]` (Option B, chosen).**
The subagent does NOT get all user data dumped into its system prompt. It gets **tool access** to a user-context API: `getCalendarAvailability()`, `getUserRestaurants()`, `getPrivatePreferences()`, `getRelationships()`, etc.
- **Critical:** each tool implementation is **scoped to the subagent's own `user_id`, fixed at spawn.** This is what structurally enforces no-bleeding — a subagent *cannot* fetch another user's data because its tools are bound to its own user_id, not because the prompt asks it nicely. Isolation is structural, not instructional. This is the security reason for Option B, beyond just "context can be large."
- `getPrivatePreferences()` is the only tool that triggers a §2 decrypt + writes an `access_audit` row.

**Routing flow:**
```
Inbound SMS from +1-555-… ─┐
Inbound MCP from <mcp_key> ─┴─► Master: resolve user_id
                                 ├─ warm subagent exists? → route to it
                                 └─ else: spawn subagent(user_id) [tools bound to user_id]
                                          → handle → reply (SMS or MCP)
                                          → stay warm 60s → die
```

**Context storage:**
- Calendar OAuth tokens: encrypted in DB; needs refresh/rotation logic.
- Private preferences: §2 encrypted store (decrypted only via the tool, only in RAM, logged).
- Restaurant favorites: **unencrypted** in DB, per-user (not publicly exposed, just not sensitive enough to encrypt). See §1.7.
- Per-user partitioning: at minimum a per-user table/namespace; no shared mutable table that mixes users' private data.

---

## 1.6 Calendar integration `[BUILD]` — Google first

- At onboarding the user grants **Google Calendar OAuth, read + write** (`calendar.readonly` + event create). Google first; design the calendar layer behind an interface so other providers can slot in later.
- The agent checks the user's **real** availability before proposing times (honest coordination — "your actual calendar is free," not "you said you're free").
- On confirmation, the agent **creates the event directly** (write access granted, so no user friction).
- **Race conditions are explicitly out of scope for now** (owner decision): if the user later adds a conflicting event, it's on the user to notice and adjust. Do NOT build soft-booking/re-check/conflict-alert logic for v1.
- Calendar read depth, multi-calendar handling, and whether the other party gets a formal calendar invite are **deferred** — not blocking v1.

---

## 1.7 Venue suggestion + reservations `[BUILD core / iterate]`

The agent does venue research and booking so the user doesn't have to ("maximize fun per dollar spent"). It should suggest a mix of **known favorites** and **new places similar to them**.

**v1 mechanism (kept deliberately simple — owner decision):**
- Each user has an **unencrypted favorites list** in our DB (not publicly exposed).
- When two agents coordinate, they **share their favorites lists with each other** and choose from the intersection/union. No cross-user aggregation or collaborative filtering yet.
- Agent checks real-time availability and books.

**v1 flow:**
1. Time agreed (via calendars, §1.6).
2. Agent gathers candidate venues: this user's favorites + the other party's shared favorites + optionally new-but-similar discoveries.
3. Check real-time reservation availability for the agreed time/party size.
4. SMS the user 2–3 options ("[A] your usual Italian, [B] new farm-to-table nearby, [C] highly-rated sushi") or accept "surprise me."
5. Book the reservation; add venue detail to the calendar event; SMS confirmation.

**Deferred to later versions (recorded so intent isn't lost):**
- **Aggregate/collaborative recommendations** — "people who use ButterflAI and like similar things also like X." Owner wants this *eventually*; v1 just records the data, defers the aggregation method. **This is the network-graph consent question (MEMORY.md Open Q2) — do NOT build aggregation until the consent model + honest user-facing disclosure is decided.** Recording favorites per-user is fine; mining them across users is the part that needs the privacy decision first.
- Reservation-provider integration (OpenTable widest coverage ~40%; Resy/Toast vary). Most local spots have no API — v1 should accept a manual/curated fallback rather than pretend full coverage.
- Budget constraints ("max $50/person"), taste-vector modeling, learning favorites from calendar history.

---

## 2. Private data: governance model `[BUILD]`

This is the most important section. Read it twice. **It supersedes the earlier wallet/NFT-as-revocation idea**, which did not actually deliver user-controlled revocation (see §2.1).

### 2.0 The decision and the honest framing
ButterflAI's agent must reason over plaintext private data (e.g. "don't invite Julie", "Marcus is going through a breakup") to act autonomously over SMS *without the user's device online to authorize each read*. Because of that autonomy requirement, **ButterflAI holds the decryption keys and can technically read users' private data.** We chose this deliberately. The alternative — envelope encryption under a user-held key — gives true cryptographic revocation but requires the user's client to be reachable at coordination time, which breaks the autonomous-SMS model. We picked autonomy; the cost is that revocation is **trust-based, not cryptographic.**

**Public-facing language MUST reflect this honestly. Do NOT claim "we can't read your data" or imply cryptographic user control.** The defensible claim is: *encrypted at rest and in transit; ButterflAI can decrypt to coordinate on the user's behalf; access is minimized, logged, expiring, and independently audited; deletion is real and verifiable.* The architecture is defensible because of the *controls and evidence below*, not because of a guarantee we can't keep. Claiming necessity ("we HAD to") where we made a tradeoff is itself indefensible — own the tradeoff.

### 2.1 Why the prior NFT-revocation model was dropped
Burning/transferring the NFT removes the *current ciphertext copy in the wallet*, but ButterflAI holds the master key and may hold cached copies — so it does not remove our *ability to read*. "User deletes their copy while we keep the key" is not revocation. We are not using the NFT as the privacy boundary. (Wallet/Base may still be used for identity and the future social budget per §3 — just not as a privacy guarantee.)

### 2.2 Storage
- Private data stored in **our database** (SQLite now; plan migration path to a managed store for KMS + backup controls below).
- **Encrypted at rest** with AES-256-GCM. Data keys managed by a **KMS/HSM** (e.g. cloud KMS), NOT a static env var. Envelope-encrypt per record: a per-record data key wrapped by a KMS master key, so key rotation and revocation-of-key-material are operations we can actually perform and log.
- **Encrypted in transit** everywhere (TLS; MCP over HTTPS).
- The master/KMS key is the crown jewel — a compromise exposes everyone. Engineer hardest here: least-privilege access, rotation schedule, no human standing access, alerting on key use outside the agent path.

### 2.3 Data minimization (defensibility starts before storage)
- **Do not ingest** sensitive data the agent doesn't need to act.
- **Derive and discard.** Store the operative rule, not the raw confession. Prefer `exclusions: {dinners_with_kaylee: [julie]}` over storing "Sean resents Julie because…". The opaque rule is enough to act on and far less harmful if exposed.
- **TTLs by class.** `passively_accumulated` and emotional-context notes expire automatically (default 90 days, refreshable). Only explicit `user_asserted` operative rules persist. No permanent dossier accumulates.

### 2.4 Access control + audit `[BUILD]` (this is what makes "we choose not to read it" real)
- Plaintext decryption gated to the **agent reasoning path only.** No general read endpoint.
- Any human/admin access requires **break-glass** (explicit, justified, time-boxed).
- **Every decryption is written to an append-only audit log** the user can review. Schema:
```sql
CREATE TABLE access_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  accessor TEXT NOT NULL,        -- 'agent_reasoning' | 'breakglass:<admin_id>'
  purpose TEXT NOT NULL,         -- e.g. 'coordinate_lunch_with_kaylee'
  record_class TEXT NOT NULL,    -- 'exclusion' | 'private_note' | ...
  outside_normal_path BOOLEAN DEFAULT 0
);
```
- **Alert** when `outside_normal_path = 1` or on break-glass use. Surface the user's own audit trail to them on request ("here's every time I looked at your private notes and why").
- Decrypt **in RAM only** during reasoning; never log plaintext; zero buffers after use. (Mitigation, not the guarantee — the guarantee is the controls above.)

### 2.5 Deletion — real and verifiable `[BUILD]` (not a soft flag)
Trust-based deletion is only defensible if deletion actually happens and the user can confirm it.
- **Hard delete**, not soft/tombstone, on user request — and the same for derived/cached copies, search indexes, and agent working memory.
- **Backup propagation:** deletion reaches all replicas/snapshots within a **stated window (target ≤ 30 days)** as old backups age out on a fixed decommission cadence. State this window publicly; don't imply instant erasure from backups if it isn't.
- **Deletion receipt:** issue the user a confirmation (timestamp + scope of what was removed + the backup-window note). This is the artifact that converts "we deleted it" from a promise into evidence.
- Account deletion = full purge of private data + key material for that user.

### 2.6 Third-party verification `[OPEN → roadmap]`
Turns "trust us" into "trust, but verified": independent security audit, SOC 2 (Type II) / ISO 27001, public security/trust page, bug bounty. Not blocking for MVP, but the public-defensibility claim is incomplete without at least a published security page and a stated audit intent.

### 2.7 Encryption helper `[BUILD]` (KMS-wrapped, not static-key)
AES-256-GCM for record encryption; the data key is wrapped by KMS. Illustrative shape:
```javascript
const crypto = require('crypto');
// dataKey is fetched/generated per-record and wrapped by KMS; NOT a static env secret.
function encryptRecord(obj, dataKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { encrypted: enc.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}
function decryptRecord(c, dataKey) {            // dataKey just unwrapped from KMS for this op
  const d = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(c.iv, 'hex'));
  d.setAuthTag(Buffer.from(c.tag, 'hex'));
  const dec = Buffer.concat([d.update(Buffer.from(c.encrypted, 'hex')), d.final()]);
  const obj = JSON.parse(dec.toString('utf8'));
  dec.fill(0);                                   // best-effort zero; mitigation only
  return obj;
}
// AFTER decrypt+use: write access_audit row, zero the unwrapped dataKey, do not cache plaintext.
```

### 2.8 Private-data JSON shape (what gets encrypted)
```json
{
  "version": 1,
  "private_notes": { "marcus": "going through a breakup, be gentle" },
  "exclusions": { "dinners_with_kaylee": ["julie"] }
}
```
Agent-to-agent rule still holds: exclusion *reasons* never cross the wire — only the resulting proposal (§1).

---

## 3. Crypto wallet + ClawBank `[BUILD core / STUB budget]`

> **Scope note:** the wallet is for **identity and the future social budget only.** It is NOT the privacy/revocation mechanism — that moved to §2 (server-side encryption + governance). Do not store private preferences in wallet/NFT metadata. The wallet is optional for MVP if identity can be keyed off phone number; prioritize it for the budget feature.

- At onboarding the user either (a) lets ButterflAI **generate a wallet** for them (recovery phrase shown via the **web app only — NEVER over SMS**), or (b) **brings their own wallet address**.
- Wallet/account creation is intended to run through **ClawBank** ("give your agent a company": bank account, crypto wallet, legal entity, debit card, one API key). `[STUB]` the ClawBank calls behind an interface now; wire fully when the social-budget feature lands.
- **Future / `[STUB]`:** a paid/advanced ButterflAI holds **money** (a "social budget" the user funds) so the agent can make restaurant reservations and book activities via the ClawBank card. Design the wallet layer so this slots in without rework.

### Secret delivery rule `[BUILD]`
Private keys and recovery phrases are **NEVER sent over SMS.** Shown once in the web app over HTTPS; SMS only ever carries a link. (Applies to wallet secrets and any other sensitive credential.)

---

## 4. Onboarding flow `[BUILD]`

### 4.1 User onboarding (SMS)
```
User → texts the ButterflAI Twilio number
Agent: "Hi! I'm ButterflAI — I help you stay connected with people you care about. What's your name?"
User: "Sean"
Agent: "Who do you want to stay in touch with regularly? List names + how often, e.g. 'Kaylee monthly, Adam quarterly.'"
User: "Lunch with Kaylee once a quarter, and dinner with Kaylee and her partner quarterly too."
Agent: "Got it — quarterly lunch with Kaylee, and quarterly dinner with Kaylee + her partner. Right?"
User: "yes"
Agent: "You're all set — I'll invite Kaylee so we can sort the scheduling for you. (Optional: set up your wallet for a future social budget here: [web link]. I'll never text you anything secret.)"
```

### 4.2 Contact invitation (SMS) — `[BUILD]`, transparency is non-negotiable
```
Agent → contact:
"Hi Kaylee! This is Sean's ButterflAI assistant. Sean wants to stay connected with you (quarterly lunch).
Set up your own ButterflAI so our agents can sort the scheduling: [onboard link]
Reply STOP and I won't message you again."
```
Every first-contact message MUST self-identify as an agent acting for a named user and MUST offer STOP. Do not make the agent sound like a human pretending to be the user.

### 4.3 Agent linking
Once Kaylee onboards and has her own agent, record the relationship as **Tier 2** (store each side's agent endpoint; wallet address only if present). From then on, scheduling is agent-to-agent over MCP (§5).

---

## 5. Agent-to-agent coordination (MCP) `[BUILD]`

### 5.1 Message shape (JSON over the MCP transport)
```json
{
  "request_id": "uuid",
  "sender_wallet": "0x…",
  "request_type": "propose_activity",
  "activity": "lunch",
  "cadence": "quarterly",
  "proposed_times": [
    {"date": "2026-06-15", "time": "12:00"},
    {"date": "2026-06-22", "time": "12:00"}
  ],
  "proposed_participants": [{"wallet": "0x…", "name": "Kaylee"}],
  "on_behalf_of": "Sean"
}
```
Responses are `accepted` (with a chosen slot), `counter` (with alternative slots/participants), or `declined`.

### 5.2 Politeness rules `[BUILD]` (defaults — see OPEN Q in MEMORY.md to confirm thresholds)
- An agent may **ask** "who would you like to invite?" — it may NOT assert "X never wants Y."
- **Max 3 counter-proposal rounds** on a single coordination before backing off.
- If unresolved after **5 days**, stop and surface to the human: "Couldn't line up a time with Kaylee this round — want me to try again next quarter?"
- Never include exclusion *reasons* in any message. Only proposals.
- If a participant is declined repeatedly, silently stop proposing them; do not ask the other agent why and do not state why.

### 5.3 Non-retention `[BUILD]` (ties to MEMORY.md Open Q1)
Agent-to-agent coordination messages are **not** persisted as profile data about the other party. Hold them only as long as the active coordination needs, then purge. Add explicit purge logic + a TTL. Do not build aggregate profiles of other users' humans from coordination traffic.

---

## 5.5 Contact ingestion `[BUILD]`

Lets the agent know who is in the user's world so the user can choose whom to invite. Prerequisite for multi-party (§5.6).

**The two-gate rule — this is the whole safety model, do not collapse it:**
1. **Ingest ≠ consent to contact.** Importing a user's address book builds a **private, user-only** list of "people you *could* invite." It does NOT authorize messaging anyone.
2. **Per-contact invite gate.** A contact is messaged ONLY when the user **affirmatively selects that specific contact** for an invite. No bulk-blasting an imported address book — that is spam and destroys the trust the product runs on.

**Mechanics:**
- Source: phone contacts and/or Google Contacts, via OS/OAuth permission. Behind an interface so sources can be added.
- Ingested contacts are stored per-user, **not exposed to other users**, and are not themselves sensitive-tier data but should still be access-controlled (they reveal the user's social graph).
- The imported list maps onto the existing tier model: a raw imported contact is **Tier 0-equivalent (no contact)** until the user promotes them by choosing to invite.
- First outbound message to any newly-invited contact is the **self-identify + STOP** message (already locked, §4.2). The invitee is a non-consenting party until they reply.

---

## 5.6 Multi-party coordination `[BUILD]` — broadcast-to-chosen-friends with soft RSVP

For organizing an outing among **several** people (e.g. "dancing Friday at [club]"). This is NOT a hard all-must-agree scheduling negotiation — owner decision: **"if the others don't make it, it's okay."**

**Model: host sets a plan; chosen friends join if they can.**
1. **Host** (the initiating user) states a plan: activity + time + (optionally) place. The plan is essentially fixed by the host — others aren't negotiating the time.
2. Host's agent reaches the agents of **friends the host explicitly chose for this event** (from ingested contacts / existing relationships). Not "nearby agents," not "friends of friends," not anyone unchosen.
3. Each invited friend's agent relays it; the friend opts in or doesn't. **No quorum, no convergence logic.** The plan happens regardless of how many join.
4. Anti-spam: one invite per chosen friend per event; respect STOP/opt-out; don't re-ping non-responders beyond a single reminder.

**Pull-not-push disclosure rule `[BUILD]` — the safety primitive:**
- The host's plan is **NOT pushed outward** beyond the chosen invitees.
- A friend learns plan details only when **they themselves ask** their own agent ("what's going on Friday night?") — information surfaces in response to the friend's *own pull*, never as an unsolicited push.
- **Gating (the line between safe and unsafe):** an agent may surface "Sean is going dancing at [club] Friday" to a friend **only if Sean already chose that friend for this event.** A pull from someone Sean did NOT invite returns nothing about Sean's plan. "Pull not push" is safe *because the puller is already someone the host included* — without this gate it silently becomes "anyone can query Sean's location," which we are explicitly NOT building.
- Net effect: no one receives an unsolicited notification of where someone will be; location+time+identity never reaches anyone the host didn't personally include.

**Deferred (recorded so intent isn't lost — do NOT build yet):**
- **Ambient "fun is being had here" signal.** Owner's idea: let agents surface that there's *activity* at a place without revealing who/when, as a prioritized option when a user asks for things to do. Out of scope for now. If built later it MUST be: anonymized/aggregate (no identities, no "and Sean is there"), opt-in, and pull-based. Note this is adjacent to the network-graph consent question (MEMORY.md Open Q2) — gate on the same privacy decision.
- **Hard multi-way scheduling** ("find a time that works for all six"). Different, harder feature; later.

---

## 6. Automation rules `[BUILD]` (confirmed in conversation 1)

- **Logistics auto-run** within user-set rules: reminders, scheduling coordination, activity suggestions.
- **Expressive messages require the human in the send path** before sending — anything that speaks *as* the user with sentiment.
- Per-contact opt-in exists for "auto-send expressive within rules" once a user trusts the system; it is NOT the default.

---

## 7. Contact-side data rights `[BUILD]` (confirmed in conversation 1)

- A contact can **view and edit** the facts stored about them (reached via a link in the invite SMS), and can downgrade/erase without going through the user.
- **Edit-conflict rule (LOCKED):** if a contact edits a fact the user asserted about them, the **contact's version wins** and the **user is notified** of the change.

---

## 8. Database additions `[BUILD]` (SQLite, extends existing schema)

```sql
CREATE TABLE user_wallets (
  user_id INTEGER PRIMARY KEY,
  wallet_address TEXT UNIQUE NOT NULL,
  nft_contract_address TEXT,
  nft_token_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP
);

CREATE TABLE contact_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  contact_name TEXT,
  contact_phone TEXT,
  frequency_days INTEGER,            -- 90 = quarterly, 30 = monthly
  tier INTEGER DEFAULT 1,            -- 0 opted out, 1 SMS, 2 agent-to-agent
  contact_wallet_address TEXT,       -- set when Tier 2
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES user_wallets(user_id)
);

-- NOTE: private preferences (notes, exclusions) are NOT stored here in plaintext.
-- They live encrypted-at-rest under KMS in a separate store with the §2 governance
-- controls (audit log, TTL, hard-delete). This table holds only non-secret
-- coordination metadata.
```

---

## 9. Smart contract `[STUB / optional for MVP]` — identity & budget only

> **No longer the privacy mechanism.** Private data is server-side per §2. A contract is only needed for wallet identity and the future social budget — NOT for storing preferences. Do not put preference metadata on-chain. Skip for MVP unless the wallet-identity or budget path is being built; if built, deploy to **Base Sepolia** then mainnet. The previous `ButterflAI_Preferences` NFT design is **deprecated** — if a contract is needed later it should be scoped to identity/budget, not preference storage.

---

## 10. Twilio handler `[BUILD]`

```javascript
const express = require('express');
const twilio = require('twilio');
const app = express();
app.use(express.urlencoded({ extended: false }));

app.post('/sms', async (req, res) => {
  const body = (req.body.Body || '').trim();
  const from = req.body.From;
  const twiml = new twilio.twiml.MessagingResponse();

  if (/^stop$/i.test(body)) {
    await optOutContact(from);          // set tier 0, see Open Q4 for notify/cooldown
    twiml.message("You're opted out and won't hear from me again.");
    return res.type('text/xml').send(twiml.toString());
  }

  const user = await findUserByPhone(from);
  const reply = user
    ? await handleUserMessage(user.id, body)
    : await beginOnboarding(from, body);

  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

app.listen(process.env.PORT || 3000);
```
Enable Twilio request validation in production. US SMS cost is roughly $0.0075–0.0083 per message in/out — budget per active relationship is a couple of cents per coordination.

---

## 11. Build order (suggested)

1. `[BUILD]` DB migrations (§8).
2. `[BUILD]` Twilio inbound/outbound + onboarding state machine (§4, §10).
3. `[BUILD]` Encrypted-at-rest store + KMS-wrapped data keys; encrypt/decrypt helpers (§2.2, §2.7).
4. `[BUILD]` Access audit log + decrypt-only-on-agent-path gating + alerts (§2.4).
5. `[BUILD]` Data minimization + per-class TTLs (§2.3); hard-delete + backup-propagation + deletion receipt (§2.5).
6. `[BUILD]` Contact invite + STOP handling + contact-side view/edit (§4.2, §7).
7. `[BUILD]` MCP agent-to-agent coordination + politeness + non-retention/purge (§5).
8. `[STUB]` Wallet identity + ClawBank interface + social-budget hooks (§3, §9) — optional for MVP.
9. `[OPEN → roadmap]` Security page, audit/SOC2 intent, bug bounty (§2.6).

> **Do NOT build** the deprecated `ButterflAI_Preferences` NFT or store any private data on-chain. Privacy is server-side now.

---

## 12. Open items (do NOT decide unilaterally — see MEMORY.md)
- Agent-to-agent non-retention enforcement mechanism (TTL/purge/audit) — confirm approach.
- Network-graph consent boundary — what agents may *learn* from coordination patterns.
- Whether *every* contact message self-identifies, or only the first.
- STOP semantics: notify the user? allow re-invite? cooldown?
- Confirm politeness thresholds (3 rounds / 5 days).

---
*Hand this to OpenClaw alongside MEMORY.md. Update tags as items move BUILD → done and OPEN → decided.*
