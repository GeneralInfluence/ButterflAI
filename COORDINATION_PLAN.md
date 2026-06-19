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
| 4 | `web/desires.js` | ✅ Done | LLM parsing → structured records; sanitizer blocks free-text; tool wired into agent |
| 5 | Agent loop hook | 🔲 | When desire is `pending` + `social`, ask user who to probe, then call `createSession` + `startProbing` |
| 6 | SMS escalation | 🔲 | `notifyUser` implementation — sends SMS when `ESCALATE_HUMAN` fires or plan is ready |
| 7 | Ambient query handler | 🔲 | Agent responds to "what's happening tonight?" using `getAmbientSummary` + venue lookup |

---

## Open Questions

- How does the receiving agent check consent before responding to a probe? (Is `from_user_id` on the contact's allow-list?)
- Politeness limit: 3 rounds / 5 days — where is this enforced? coordination.js or mcp-messages.js?
- When a user says "a friend or two" — does the agent ask who to probe, or does it pull from the top of the contact list?

---

## Resume Prompt

> "Let's continue building the desire coordination system. Start with `web/mcp-messages.js` — the builder functions and outbound schema validator. See COORDINATION_PLAN.md for context."
