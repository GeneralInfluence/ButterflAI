# ButterflAI — Claude Code Context

Social ButterflAI: personal social agent. Agent does the logistical labor of friendship so the human can do the emotional labor of friendship.

**Prod:** https://butterflai.social / https://butterflai.fly.dev  
**Stack:** Node/Express + SQLite on Fly.io. SMS via Twilio. Agent loop in `web/agent.js`.  
**Tests:** `cd web && npm test` — run before every commit. 382 passing. Never skip or delete tests.  
**Deploy:** push to main → CI tests → auto-deploy (requires `FLY_API_TOKEN` in GitHub secrets).

---

## The orchestrating agent (Social ButterflAI / me)

The OpenClaw agent that owns this repo has its own identity, operating rules, and memory. These are part of the system — Claude Code should understand them to work in context.

@workspace/SOUL.md
@workspace/IDENTITY.md
@workspace/AGENTS.md
@workspace/TOOLS.md

---

## Project decisions, architecture, hard rules

@MEMORY.md
@PRIVACY.md
@docs/REARCHITECTURE.md
@IMPLEMENTATION.md
@COORDINATION_PLAN.md
@LAUNCH_CHECKLIST.md
@BRANDING.md

---

## Session history (newest first)

@docs/sessions/session-2026-07-17.md
@docs/sessions/session-2026-07-16.md
@docs/sessions/session-2026-07-15.md
@docs/sessions/session-2026-07-05.md
@docs/sessions/session-2026-06-20.md
@docs/sessions/session-2026-06-19.md
@docs/sessions/session-2026-06-18.md
