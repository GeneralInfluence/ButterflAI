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

- ✅ **Agent-behavior work shipped** (PR #11, merged, live): weekday rule, deterministic date-context,
  invite-by-name recipe, RECIPES layer, and the coordination-invite host-notify crash fix (was PR #10).
- ✅ **Pinned Haiku 4.5** (PR #11) — stale `claude-3-5-haiku-20241022` default removed + guarded; owner
  set the `AGENT_MODEL` Fly secret.
- ✅ **Date hardening** (PR #12) — `datetime.js` resolves the user's day+time phrase server-side via
  create_social_event's `when` field; the model no longer does date math. Validated live.
- ✅ **Notify user-invitees in-app, not by SMS** (PR #12) — `inviteContacts` routes users in-app +
  best-effort push; SMS reserved for non-users. Cohort of app users runs on ~zero SMS.
- ✅ **Timezone captured at login** (PR #12) — browser IANA tz adopted when the stored tz is unset,
  fixing the Eastern-default bug. ⬜ *lat/lng auto-capture at onboarding still open* (a GPS opt-in
  flow exists; auto-seeding from area code / browser is not wired).
- ✅ **Silent-failure sweep** (PR #12) — agent errors now surface on the user's own channel (web +
  SMS), `MAX_ITERATIONS` reaches both, tool errors log full stacks; regression-tested.
- 🚧 **Push notifications end-to-end** (PR #12) — fully wired + a gesture-tied "Enable notifications"
  button in Settings. **Needs (owner):** set the `VAPID_*` Fly secrets, then tap Enable on a device.
- **Definition of done:** a friend opens the web app, invites another friend (also in the app), and
  invite → in-app notify → RSVP → host-notified works with correct dates on Haiku, **no SMS sent**.
  *Met in the simulator; confirm on real devices once the push secrets are set.*

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
