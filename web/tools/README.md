# web/tools

Developer tooling (not shipped to prod).

## sim.js — multi-agent simulator

A fast local loop for iterating on **agent behavior** ("training the general user
agent") without real SMS or two humans. It runs the same code paths production
uses — `routeInboundSms()` for routing, `agent.processMessage()` for each agent
turn — against an **isolated in-memory DB** seeded with two full users (Aphilos +
BamBam), with **Twilio stubbed** so outbound SMS is printed, not sent. After each
human message it **drains the whole inbound queue**, so an Aphilos→BamBam cascade
(agent↔agent coordination, RSVP notifications, tool calls) plays out in one shot
and is printed as a transcript. Nothing touches production.

### Run

```sh
cd web
# real agent turns need a real key + a model your Anthropic account has:
#   ANTHROPIC_API_KEY=...   (put it in web/.env — never on the command line)
#   AGENT_MODEL=claude-...  (the same model prod uses; the code default is NOT on the account)
npm run sim
```

### REPL

```
aphilos: invite bambam to dinner friday 7pm     (or  a: ... )
bambam:  yeah im in                             (or  b: ... )
<text>                                          (uses the last speaker)
/state        users, open events + RSVP statuses, queue depth
/events       all events + invitations
/a2a          recent agent-to-agent messages
/prompt a|b   print an agent's system prompt (the behavioral rules you're tuning)
/reseed       wipe + reseed the two users
/help /quit
```

### How to "train" with it

1. Send a realistic instruction as one user, watch the full cascade + tool calls.
2. When the agent does something wrong, edit the rule in `buildSystemPrompt()`
   (`web/agent.js`), add/adjust an assertion in
   `tests/integration/system-prompt.test.js` (per the MEMORY.md convention),
   and re-run the same scenario.
3. Lock in good behavior as a regression later (the same engine —
   `sim.seed`/`sim.injectHuman`/`sim.drain` — is exercised headlessly in
   `tests/integration/sim-engine.test.js`).

The engine relies on two prod-safe injection hooks in `agent.js`
(`_setAnthropic`, `_setToolObserver`) that are complete no-ops unless set.
Override the in-memory DB with `SIM_DB_PATH=/path/to/file.sqlite` if you want
state to persist between runs.
