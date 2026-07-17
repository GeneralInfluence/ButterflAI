# ButterflAI — Claude Code Context

Social ButterflAI: personal social agent. Agent does the logistical labor of friendship so the human can do the emotional labor of friendship.

**Prod:** https://butterflai.social / https://butterflai.fly.dev  
**Stack:** Node/Express + SQLite on Fly.io. SMS via Twilio. Agent loop in `web/agent.js`.  
**Tests:** `cd web && npm test` — run before every commit. 382 passing. Never skip or delete tests.  
**Deploy:** push to main → CI tests → auto-deploy (requires `FLY_API_TOKEN` in GitHub secrets).

---

## The orchestrating agent (Social ButterflAI / me)

The OpenClaw agent that owns this repo has its own identity, operating rules, and memory. These are part of the system — Claude Code should understand them to work in context.

@.claude/SOUL.md
@.claude/IDENTITY.md
@.claude/AGENTS.md
@.claude/TOOLS.md

---

## Project decisions, architecture, hard rules

@.claude/MEMORY.md
@.claude/PRIVACY.md
@.claude/IMPLEMENTATION.md
@.claude/COORDINATION_PLAN.md
@.claude/LAUNCH_CHECKLIST.md
@.claude/BRANDING.md

---

## Session history (newest first)

@.claude/session-2026-07-17.md
@.claude/session-2026-07-16.md
@.claude/session-2026-07-15.md
@.claude/session-2026-07-05.md
@.claude/session-2026-06-20.md
@.claude/session-2026-06-19.md
@.claude/session-2026-06-18.md
