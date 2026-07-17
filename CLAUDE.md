# ButterflAI — Claude Code Context

Social ButterflAI: personal social agent. Agent does the logistical labor of friendship so the human can do the emotional labor of friendship.

**Prod:** https://butterflai.social / https://butterflai.fly.dev  
**Stack:** Node/Express + SQLite on Fly.io. SMS via Twilio. Agent in `web/agent.js`.  
**Tests:** `cd web && npm test` — run before every commit. 382 passing. Never skip or delete tests.  
**Deploy:** push to main → CI tests → auto-deploy (requires `FLY_API_TOKEN` in GitHub secrets).

---

## All context docs (read these)

@.claude/MEMORY.md
@.claude/PRIVACY.md
@.claude/IMPLEMENTATION.md
@.claude/BRANDING.md
@.claude/COORDINATION_PLAN.md
@.claude/LAUNCH_CHECKLIST.md
@.claude/session-2026-07-16.md
@.claude/session-2026-07-17.md
