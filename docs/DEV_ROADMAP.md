# ButterflAI — Development-Users Roadmap

> **Goal:** get a small cohort of trusted friends using ButterflAI for real social
> coordination, capture every moment it falls short of their expectations, and turn
> each into a durable fix via the simulator training loop — without runaway cost or
> privacy risk.
>
> **Status tags:** ✅ done · 🚧 in progress · 🔲 not started · ⏸️ deferred
> **Author:** Claude Code session 2026-09-21. Update as items land.
> Companion docs: [[LAUNCH_CHECKLIST.md]] (public-launch bar — stricter), [[MEMORY.md]]
> (§7 test suite + training loop), `docs/REARCHITECTURE.md` (long-term, out of scope here).

---

## 0. Framing — what this stage is (and isn't)

This is the **trusted-alpha** bar, not the public-launch bar. Friends who know it's in
development tolerate rough edges — but the *core loop must work*, their *time can't be
wasted*, and their *privacy (and their contacts') can't be violated*. They agreed to
one thing: **flag it when performance misses their expectations.** The entire roadmap
exists to make that flag cheap to give and durable to fix.

**Three non-negotiables even at alpha:**
1. **The core loop works** — invite → RSVP → host notified, with correct dates/times.
2. **No privacy violations** — the two-gate contact rule and the 7 PRIVACY.md invariants hold for real people.
3. **Cost is bounded** — real usage runs on a paid API; a cohort can't produce a surprise bill.

### Locked decisions (owner, 2026-09-21)

- **Model = Haiku 4.5 (`claude-haiku-4-5-20251001`).** The target is to make it work *on Haiku*.
  Reliability comes from concrete **recipes + deterministic scaffolding** (e.g. the date-context
  table) + the **feedback loop** — not from a bigger model. See [[butterflai-agent-training]].
- **Web app is the primary interface. SMS is only the boundary channel to non-users.** Everything
  *inside* the app is web/in-app:
  | Interaction | Channel |
  |---|---|
  | Tester ↔ their own agent | **web app** |
  | Two testers coordinating (both in-app) | **agent-to-agent + in-app RSVP** |
  | Inviting a brand-new person (not a user) | **SMS** (only way to reach them; self-ID + STOP) |
  | That non-user's reply / RSVP | **inbound SMS** (the contact-relay path) |
  | Adding a contact | **web app** (type name+number, or referral link) |
  Consequence: for a closed cohort all on the web app, SMS is nearly untouched — it appears only
  when a tester invites an *outsider*. **A2P/10DLC throughput is therefore a LOW priority for alpha;**
  one Twilio number for the boundary suffices. The in-app replacement for the SMS nudge is
  **push / the invited-events view** — so push notifications matter more, SMS-to-users less.
- **Feedback surface = a 👎 / "not right" button in the web chat** (richest context, and it's where testers live).

**The improvement engine (already built this session):** real feedback → reproduce as a
`web/tools/sim.js` scenario → fix in `buildSystemPrompt()`/code → add a
`system-prompt.test.js` assertion → deploy. Every complaint becomes a test that stops the
regression forever. This roadmap wires the front half (capture) onto that engine.

**Explicitly deferred (do NOT build for dev-users):** TEE/confidential compute, federation,
per-agent identity (REARCHITECTURE Phases 2–3); the full public-launch checklist (A2P scale,
SOC 2, per-user SQLite split); FLAI economy tuning; wallet/ClawBank. Keep the honest interim
trust model ("we can read your data; it's encrypted + access-logged; TEE is future") and say
so plainly to testers.

---

## Phase A — Ship the fixes & close readiness gaps  🚧  *(the gate — do first)*

Dev-users hit the agent on day one, so prod must run the fixed agent, on a known-good
model, with correct per-user data.

- 🔲 **Merge PR #10** (confirm_coordination_invite host-notify crash) → prod. Live bug today.
- 🔲 **Ship the agent-behavior work** — open a PR for the training branch
  (`claude/contacts-sms-routing-rewrite-getxcl`: weekday rule, deterministic date-context,
  invite-by-name recipe, RECIPES layer) and merge → prod. Without this, testers get the
  old agent that mislabels dates and asks "who is X?".
- 🔲 **Pin Haiku 4.5** (`claude-haiku-4-5-20251001`) as the prod `AGENT_MODEL`. **Remove the stale
  `claude-3-5-haiku-20241022` default in `agent.js:55`** (it 404s) — pin the valid Haiku id and
  fail-fast on an unset `AGENT_MODEL` instead of silently using a dead model. Making Haiku reliable
  is the recipe/scaffolding/feedback work, not a model swap.
- 🔲 **Notify user-invitees in-app, not by SMS.** Today `create_social_event` texts every invitee,
  including ButterflAI users (seen in the sim: "SMS → BamBam"). In the web-first model, an invitee
  who is a user should be notified **in-app (push + the invited-events view)**; SMS is reserved for
  **non-user** invitees. This is what makes the cohort run on ~zero SMS.
- 🔲 **Push notifications working end-to-end** — they're the in-app replacement for the SMS nudge,
  and were flagged incomplete in earlier sessions. Without them, a web-first user-invitee has no
  timely signal that they were invited or that an RSVP came in.
- 🔲 **Per-user data that coordination depends on:** capture/derive **timezone + lat/lng at
  onboarding** for every user. The date-context block and location routing are only correct
  when these are set. (Several existing accounts have null timezone / missing coords.)
- 🔲 **Silent-failure sweep:** every agent error must surface a user-facing "hit a snag" AND
  log a full stack (one such drop was fixed 2026-07-17 — audit the rest of the tool/loop paths).
- **Definition of done:** a friend opens the web app, invites another friend (also in the app),
  and invite → in-app notify → RSVP → host-notified works end-to-end with correct dates on Haiku —
  with **no SMS sent** because both are users.

---

## Phase B — The feedback loop  🔲  *(the heart of the ask)*

There is **no feedback mechanism today.** Build the cheapest-possible "that's not right"
capture and route it into the training engine.

- 🔲 **In-app feedback control** — a 👎 / "this isn't right" affordance on each agent message
  in web chat, plus an SMS path (user texts `👎` or `bug: ...`). Two taps, no form fatigue.
- 🔲 **`feedback` table (migration)** — capture the *full context* so it's reproducible:
  `id, user_id, agent_message, prior_turns_json, state_snapshot, tool_calls_json, model,
  user_expectation (optional note), created_at, status (new|triaged|fixed), sim_scenario_ref`.
- 🔲 **Admin triage view** — list reports newest-first, expand to full context, set status,
  link to the fix/commit. (Extends the existing `/admin`.)
- 🔲 **Reproduce-from-feedback helper** — a small tool that seeds `web/tools/sim.js` from a
  feedback row (same user prefs/timezone, the same message) so the miss reproduces in one command.
- **Definition of done:** a dev-user flags a bad response in two taps; it lands in a queue with
  enough context to reproduce it in the sim without asking them for more.

---

## Phase C — Observability  🔲  *(so feedback is diagnosable)*

Today only conversation *text* is persisted (`appendConversation`). When a friend says "it
messed up," we can't see what the agent actually did. Fix that.

- 🔲 **Structured agent-turn logging** — wire the existing prod-safe `_setToolObserver` hook
  (already in `agent.js`) + capture per turn into an `agent_turns` table: input, tools+args,
  output, model, latency, error. This is what pairs with a feedback report.
- 🔲 **Error alerting** — Fly machine crash, agent-loop stall (>10 min no processing), SMS
  delivery-failure rate >5% → notify the dev team (email/SMS). (From LAUNCH_CHECKLIST §5.)
- 🔲 **Dev-team turn viewer** — an admin view of a user's last N turns with tool calls, to open
  next to a feedback item.
- **Definition of done:** for any feedback item, we can pull the exact turn, its tool calls,
  and the error (if any) in under a minute.

---

## Phase D — Cohort onboarding, expectations & guardrails  🔲  *(runs alongside A–C)*

- 🔲 **Dev-tester roster** — a `dev_tester` flag on accounts (turns on richer logging / a gentle
  feedback nudge); a simple invite list for the 3–5 friends.
- 🔲 **Expectation-setting** — a short first-login note: "You're testing an alpha. Here's what
  works, what's rough, how to flag issues (👎), and how to stop (STOP)." Honest, brief.
- 🔲 **Privacy honesty for real people** — the two-gate rule MUST hold: importing a tester's
  contacts is NOT consent to message them; a contact is messaged only when the tester explicitly
  invites them, with self-ID + STOP. Keep the disclosed "we can read your data" language — **no
  TEE claims.** No new privacy infra needed for this stage; just enforce what PRIVACY.md already requires.
- 🔲 **Cost guardrails** — the FLAI throttle is stubbed/permissive today. Add a simple **per-user
  daily cap** (messages / API calls) so the cohort can't run up a surprise bill, and **monitor
  spend by API key** in the Anthropic Console. Pick the model deliberately (Phase A) with cost in mind.
- **Definition of done:** 3–5 friends onboarded with clear expectations, a spend cap in place,
  and the privacy invariants verified intact.

---

## Phase E — The weekly iteration loop  🔲  *(steady state)*

- 🔲 **Cadence** — weekly: pull feedback + turn logs → convert misses to sim scenarios → run the
  training loop → deploy. Batch fixes; ship regularly so testers see progress.
- 🔲 **Grow the sim** — add the scenarios the cohort actually does (multi-user groups, recurring
  hangs). Seed a third sim user (e.g. Allie) for 3-way coordination.
- 🔲 **One quality metric** — % of flagged turns resolved + the recurring miss categories, so we
  know whether the loop is actually reducing repeat complaints.
- **Definition of done:** a repeatable weekly rhythm that visibly shrinks repeat complaints.

---

## Suggested first two weeks

1. **Week 1 — make it safe to invite friends:** Phase A in full (merge PR #10 + the training
   branch, pin the model, fix timezone/lat-lng onboarding, silent-failure sweep) + Phase D's
   cost cap and privacy check. *Gate: don't onboard anyone until A is green.*
2. **Week 2 — make feedback cheap and diagnosable:** Phase B (feedback capture + table + triage)
   and the Phase C turn-logging. Onboard the first 2–3 friends with expectations set, watch the
   first feedback come in, and run one full feedback→sim→fix→deploy cycle to prove the loop.

---

## Decisions resolved (2026-09-21) — see "Locked decisions" above

- **Model:** Haiku 4.5. ✅
- **Channel:** web-app-first; SMS only at the non-user boundary; A2P is low-priority for alpha. ✅
- **Feedback surface:** 👎 button in the web chat. ✅

### Remaining nuance to settle as we build

- **Non-user coordination depth for alpha.** If the first cohort is a closed set of app users,
  we may not exercise the SMS boundary at all early on. Decide whether to deliberately include one
  "invite an outsider" test to keep the SMS invite + reply path warm, or defer SMS testing entirely.
- **Contact entry UX** (since Apple import is out): confirm the manual add + referral-link flow is
  smooth enough that testers can build a small contact list without friction.

---
*Update this file as phases land. Move 🔲 → 🚧 → ✅ with the commit that did it.*
