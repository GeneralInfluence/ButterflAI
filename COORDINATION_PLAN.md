# Coordination Plan — Agent-to-Agent Desire Coordination
> Status: In progress. Resume here next session.
> Last updated: 2026-06-19

---

## What We're Building

Each user tells their agent what they want for the week (e.g. "work out twice, go out with a friend or two, one chill night"). Agents coordinate with each other to find compatible activities — with minimal user interruption and zero leakage of private desire text between users.

---

## Architecture Decisions (Locked)

### Desire Categories
- **Solo** — agent schedules internally (e.g. "work out twice")
- **Social** — requires agent-to-agent coordination (e.g. "go out with a friend or two")
- **Protective** — blocks time, no coordination needed (e.g. "chill night")

### Negotiation Protocol (3 rounds max)
- **Round 1** — Probe / Interest: category + day-level availability
- **Round 2** — Window exchange: specific time windows
- **Round 3** — Proposal / Confirm / Counter / Reject

Multi-party: probe all candidates in parallel, find intersection, proposal only goes to people in the intersection.

### Privacy Invariants (Non-negotiable)
1. `raw_text` of desires **never** leaves the server — excluded at the DB/view level
2. No `notes`, `reason`, `context`, or free-text fields in any agent-to-agent message
3. LLM is used for ingestion only — deterministic code constructs all outbound messages
4. Outbound messages validated against strict enum/typed schema before send
5. Reject reasons stay private — `{ message_type: 'reject', payload: {} }` only
6. Coordination session records purge after the event (TTL: event_date + 7 days)

---

## Data Models

### `desires` table (private, never exposed to coordination layer)
```
id, user_id, raw_text, category, activity_type,
social_size_min, social_size_max,
time_window_start, time_window_end,
priority, status, created_at
```

### `coord_desires` VIEW (the only thing coordination.js sees)
```sql
SELECT id, user_id, category, activity_type,
       social_size_min, social_size_max,
       time_window_start, time_window_end,
       priority, status
FROM desires;
-- raw_text excluded
```

### `coordination_sessions` table
```
id, session_id (uuid), initiator_user_id, desire_id,
peer_agent_ids (JSON array), state, round,
agreed_slot, expires_at, purge_after, created_at
```

### Session States
```
PENDING → PROBING → AVAILABILITY → PROPOSED → PENDING_HUMAN_OK → SCHEDULED
                                             → COUNTER (loop)
       → DROPPED (no interest / reject)
       → ESCALATE_HUMAN (no match / rounds exhausted / timeout)
```

---

## Message Schema

```js
{
  protocol: "butterflai-coord/1.0",
  session_id: "uuid",
  round: 1 | 2 | 3,
  from_agent: "mcp_public_key",
  to_agent: "mcp_public_key",
  message_type: "probe" | "interest" | "availability" | "proposal" | "confirm" | "counter" | "reject" | "cancel",
  payload: { ... },   // type-specific, enums/typed only — NO free text
  expires_at: "ISO timestamp",
  nonce: "random"
}
```

Payload shapes:
- **probe**: `{ from_user_id, category (enum), activity_type (enum), group_size: {min,max}, time_window: {start,end} }`
- **interest**: `{ interested: bool, available_days: [enum] }`
- **availability**: `{ windows: [{day, period (enum), earliest, latest}] }` or `{ matching_windows: [...] }`
- **proposal**: `{ slot: {start, duration_min}, activity_sketch (enum), requires_human_confirm: bool }`
- **confirm**: `{ pending_human_approval: bool, respond_by: ISO }`
- **counter**: `{ slot: {start, duration_min} }`
- **reject**: `{}`
- **cancel**: `{}`

---

## Files to Build (In Order)

| # | File | Status | Notes |
|---|------|--------|-------|
| 1 | `web/mcp-messages.js` | ✅ Done | Builder fns + outbound schema validator — covers both coordination + ambient |
| 2 | `web/coordination.js` | ✅ Done | Session state machine, round logic, ambient intent, window intersection |
| 3 | `web/db/migrations/003_coordination.sql` | ✅ Done | `desires`, `coord_desires` view, `coordination_sessions`, `coord_session_peers`, `ambient_signals` |
| 4 | `web/desires.js` | ✅ Done | LLM parsing → structured records; sanitizer blocks free-text; vague candidates; horizons; hard delete |
| 5 | `web/coord-loop.js` | ✅ Done | Ticks every 5min: pending desires → resolve candidates → createSession → startProbing; recurring templates; escalation notify |
| 6 | `notifyUser` | ✅ Done | Routes through agent loop via `storeInboundMessage` — agent sends SMS + handles reply in same turn |
| 7 | `whats_happening` tool | ✅ Done | Aggregates ambient signals + venue lookup; severs identity link (venues from lookup, not broadcast) |
| 8 | Per-user SQLite migration | 🔲 | Split single DB into `main.sqlite` + `users/{user_id}.sqlite` before public launch — see §Storage below |

---

## Storage Architecture

### Current (MVP)
Single SQLite file: `/data/butterflai.sqlite`
All users share one file. Isolation is logical (`WHERE user_id = ?`).

### Target (pre-public-launch)
```
/data/
  main.sqlite              ← users, invites, sms_optouts, consent_records, agent_messages
  users/
    {user_id}.sqlite       ← desires, coord_sessions, preferences, private_data, contacts, conversation_history
```
- Agent resolves `user_id` from phone via `main.sqlite`, then opens `users/{user_id}.sqlite`
- A bug in one user's session cannot touch another's file system
- Per-user DB can be independently backed up, exported, or deleted (GDPR erasure = delete the file)
- Existing `crypto.js` encryption stays for `private_data` within the per-user DB

### Wallet Encryption for Desires — Decision

**Revisited and still not viable for desires.** Same problem as the deprecated NFT approach:

The agent must act autonomously over SMS when the user's device is offline (sleeping, etc.).
If desire decryption requires a live wallet signature, the agent can't probe peers at 2am.

A delegated session key model (wallet signs once → derives session key → agent holds it) solves the
autonomy problem but recreates the "server holds the key" situation — same trust model as the current
KMS approach, just with extra steps.

**What the wallet IS used for (unchanged):**
- Identity (agent's MCP public key maps to wallet address)
- Future social budget (ClawBank / card)

**What protects desires instead:**
1. `raw_text` zeroed immediately after parsing (the most sensitive field is gone)
2. Remaining fields are enums + dates (low sensitivity)
3. Per-user SQLite (physical isolation — different attack surface from logic bugs)
4. `private_data` table encrypted at rest under KMS (for truly sensitive blobs)
5. Hard delete returns a receipt (GDPR erasure)
6. Access audit log (every read of private data logged)

The honest statement: ButterflAI holds the keys and can technically read desire metadata.
This is disclosed, controlled by audit + minimization, and is the deliberate tradeoff for agent autonomy.

---

## Open Questions

- Politeness limit: 3 rounds / 5 days — enforced in coordination.js session creation
- Recurring desires: agent loop checks `getDueRecurringTemplates()` on each tick; spawns instances
- Consent gate on inbound probes: `handleProbeInbound` checks `from_user_id` against contact allow-list

---

## Resume Prompt

> "Continue the coordination plan — see COORDINATION_PLAN.md. Next: agent loop hook (item 5) — when a desire is pending + social, resolve candidates and start probing."
