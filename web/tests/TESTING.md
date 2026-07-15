# ButterflAI Test Suite

## Quick start

```sh
cd web
npm test              # all unit + integration tests
npm run test:unit     # unit tests only (fast, no server)
npm run test:integration  # integration tests only (HTTP + DB)
npm run test:eval     # LLM agent evals (slow, costs API credits)
```

Tests use Node's built-in `node:test` runner — no extra test framework needed beyond `supertest` for HTTP testing.

---

## How it works

### Three-layer architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Unit tests  (tests/unit/)                                  │
│  Pure logic — no server, no real I/O                        │
│  Runtime: ~1s   Cost: free                                  │
├─────────────────────────────────────────────────────────────┤
│  Integration tests  (tests/integration/)                    │
│  HTTP routes via supertest + in-memory SQLite               │
│  Runtime: ~5s   Cost: free                                  │
├─────────────────────────────────────────────────────────────┤
│  Agent evals  (tests/agent-eval.js)                         │
│  Real LLM calls — checks agent tool use + safety rules      │
│  Runtime: ~60s   Cost: Anthropic API credits                │
└─────────────────────────────────────────────────────────────┘
```

### Key design decisions

**In-memory SQLite for every test run.** Each test file sets `process.env.DB_PATH = ':memory:'` before importing `db.js`. The migration system applies all 19 migrations (from both `db/migrations/` and `web/db/migrations/`) on startup, giving every test a clean, fully-migrated schema. Tests are isolated — no shared state between files.

**No real Twilio calls.** `sms.js` exposes `_setClient(mockClient)` for test injection. Every test that sends SMS injects a counter client and asserts on `calls.length` rather than waiting for a real message. The `validateTwilioRequest` middleware is bypassed in `NODE_ENV=test`.

**No real Anthropic calls.** The agent loop never starts in tests because `server.js` wraps `app.listen()` in a `require.main === module` guard — when imported via `require('./server')`, it only exports `app` without starting loops.

**Supertest wraps Express.** Integration tests call `supertest(app)` directly — no port binding, no network. Response assertions happen synchronously in the test process.

---

## Test file map

```
tests/
├── unit/
│   ├── cadence.test.js      Pure nudge logic: isNudgeDue(), buildNudgeText()
│   ├── flai.test.js         FLAI ledger math, burnForUser(), baseline grant
│   ├── lift.test.js         Lift estimators, computeAndLogLift(), stub coverage
│   └── referral.test.js     Token generation, round-trip, redeem, reward
│
├── integration/
│   ├── auth.test.js         OTP send/verify, JWT cookie, protected route redirects
│   ├── api.test.js          /health, /api/user/me, contacts, dashboard, referral, /r/:token
│   ├── onboarding.test.js   Web signup, referral redemption, /api/onboarding/setup
│   └── sms-flows.test.js    STOP, START, nudge confirm Y/N/skip, attendance confirm batched
│
├── consent.test.js          SMS consent gate, opt-out, E.164 normalization (legacy)
├── coordination.test.js     MCP message builders, window intersection, desire sanitization
└── agent-eval.js            LLM eval harness (not part of npm test)
```

---

## CI/CD

Two GitHub Actions workflows:

### `.github/workflows/ci.yml` — runs on every push and PR

1. Install dependencies (`npm ci`)
2. Run `npm test` (unit + integration)
3. **On `main` only:** deploy to Fly.io via `flyctl deploy --remote-only`

This means: push to any branch → tests run. Push to `main` and all tests pass → auto-deploy. No manual `fly deploy` needed.

**Required GitHub secret:** `FLY_API_TOKEN` (set in repo Settings → Secrets → Actions)

### `.github/workflows/eval.yml` — nightly + manual trigger

Runs `npm run test:eval` (the LLM agent eval harness) against a real Anthropic API key.

**Required secrets:** `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`

---

## Developer guide

### Writing a new unit test

Unit tests live in `tests/unit/`. Follow this template:

```js
'use strict';

// Set DB path BEFORE any require that touches db.js
process.env.DB_PATH  = ':memory:';
process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Import the module under test
const { myFunction } = require('../../my-module');

describe('myFunction', () => {
  test('does the right thing with valid input', () => {
    const result = myFunction({ foo: 'bar' });
    assert.equal(result.status, 'ok');
  });

  test('handles edge case gracefully', () => {
    assert.doesNotThrow(() => myFunction(null));
  });
});
```

**Rules:**
- Always set `DB_PATH=:memory:` and `NODE_ENV=test` before any require
- Delete Twilio/Anthropic env vars if your module imports sms.js or agent.js
- Use `node:assert/strict` — strict equality by default
- Use `describe()` blocks to group related tests (the output is cleaner)

### Writing a new integration test

Integration tests use `supertest` against the real Express `app`. Template:

```js
'use strict';

process.env.DB_PATH   = ':memory:';
process.env.NODE_ENV  = 'test';
process.env.JWT_SECRET = 'test-secret';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { test, describe, before } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../../server');
const db = require('../../db');
const sms = require('../../sms');

// Mock SMS client so no real Twilio calls happen
const mockClient = { calls: [], messages: { create(p) { this.calls.push(p); return Promise.resolve({ sid: 'MOCK' }); } } };
sms._setClient(mockClient);

describe('My feature', () => {
  let cookie;

  before(async () => {
    // Create a test user and get an auth cookie
    const phone = '+12025550199';
    db.writeConsent(phone, 'SELF_START');
    db.createUser({ id: 'test-user-1', phone, name: 'Test', onboarding_state: 'complete' });

    // Request OTP
    await request(app).post('/auth/otp/send').send({ phone });
    const otp = db._raw().prepare(
      "SELECT code FROM otp_codes WHERE phone=? AND used=0 ORDER BY created_at DESC LIMIT 1"
    ).get(phone);

    // Verify OTP → get cookie
    const res = await request(app).post('/auth/otp/verify').send({ phone, code: otp.code });
    cookie = res.headers['set-cookie']?.[0];
  });

  test('my route returns the right thing', async () => {
    const res = await request(app)
      .get('/api/my-route')
      .set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(res.body.myField);
  });
});
```

**Rules:**
- Set `JWT_SECRET` — without it, `webapp-auth.js` throws on token signing
- Always mock `sms._setClient` to prevent real Twilio calls
- Never hardcode user IDs that conflict across test files — use unique values
- Clean state is guaranteed by `:memory:` DB — each `require('./db')` on a fresh process gets a fresh DB

### Writing a new agent eval

Agent evals live in `tests/agent-eval.js`. They call the real Claude API and assert on the reply text and/or tool calls. Add a scenario with the `evalResult()` helper:

```js
await evalScenario('user asks to add a contact', async () => {
  const reply = await processMessage(userId, 'Add my friend Alice, her number is 415-555-0100');
  return evalResult('add_contact tool used', reply, {
    'mentions Alice': r => r.toLowerCase().includes('alice'),
    'does not auto-message': r => !r.includes('sent'),
  });
});
```

Evals are intentionally slow and cost real credits. Only run them locally before a major release or via the nightly CI job.

### Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `no such table: consent_records` | `DB_PATH=:memory:` not set before `require('./db')` | Set env vars before all requires |
| `Cannot find module 'supertest'` | supertest not in node_modules | `npm install --save-dev supertest --ignore-scripts` |
| Test hangs / SIGTERM | Parallel test files each spawn a server with heavy requires | Run files one at a time: `node --test tests/integration/auth.test.js` |
| `mime.getType is not a function` | mime v1/v2 conflict in node_modules | superagent needs mime v2 in its own node_modules (already fixed) |
| `better-sqlite3 bindings not found` | Native binary not compiled for your Node version | Copy binary from a working install or compile: `npm rebuild better-sqlite3` |
| Auth cookie missing in test | before() hook threw before cookie was set | Check that `JWT_SECRET` is set in the test environment |

### Migration system (important for new tables)

When you add a migration file:
- Files starting with `001`–`008` → go in `db/migrations/` (root, shared)
- Files starting with `009`+ → go in `web/db/migrations/` (web-layer)

`db.js` reads both directories and sorts them together before applying. The Docker build also merges both at `/app/db/migrations/`. Always name migration files with a numeric prefix so sort order is deterministic.

### Running tests in CI

The GitHub Actions workflow runs on ubuntu-latest with Node 20. It uses `npm ci` (strict lockfile install) and builds native modules normally — no `--ignore-scripts` needed in CI because prebuilt binaries exist for Node 20 on Linux x64.

If you add a new npm dependency that has a native build step, make sure it has prebuilt binaries for `node@20 linux x64`, or add a build step to `ci.yml`.
