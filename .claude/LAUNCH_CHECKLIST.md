# ButterflAI — Launch Checklist
> Gate: nothing ships to real users until every ✅ is checked.
> Status tags: ✅ Done · 🔲 Not started · 🚧 In progress · ⚠️ Blocked

---

## 1. Security & Privacy

### Encryption
- 🔲 **Swap KMS from `local` to `aws`** — currently `KMS_PROVIDER=local` in fly.toml means the master key is just an env variable. Before real users: provision an AWS KMS key, update `crypto.js` AWS path, rotate `KMS_MASTER_KEY_HEX` out.
  - Create KMS key in AWS Console (symmetric, AES-256)
  - Set `KMS_KEY_ARN` as a Fly secret
  - Set `KMS_PROVIDER=aws` in fly.toml
  - Test encrypt/decrypt round-trip in staging
- 🔲 **Per-user SQLite** — split single DB into `main.sqlite` + `users/{user_id}.sqlite`. Physical isolation: a bug in one user's session cannot touch another's file. (See COORDINATION_PLAN.md §Storage)
  - Write migration script: copy per-user tables to individual files
  - Update `db.js` to accept a `userId` param and open the right file
  - Update all callers
  - Test: verify cross-user reads are structurally impossible
- ✅ `raw_text` of desires zeroed immediately after parsing
- ✅ `coord_desires` VIEW excludes `raw_text` from coordination layer
- ✅ `private_data` encrypted at rest (AES-256-GCM, KMS-wrapped key)
- ✅ Access audit log on `private_data` reads

### Data lifecycle
- 🔲 **Per-class TTLs implemented** — passive signals (ambient intents) expire end-of-day; coordination sessions purge at event_date + 7 days. Add a cron job that runs nightly and deletes expired records.
- 🔲 **Hard delete tested end-to-end** — user requests erasure → all tables cleared → receipt returned → backup propagation window stated (currently: ~30 days for Fly volume snapshots)
- 🔲 **Backup propagation window disclosed** — add to privacy policy: "deletion takes effect immediately in the live DB; backups cycle within 30 days"

### Consent & identity
- ✅ Self-identify + STOP on every first outbound SMS
- ✅ Opt-out recorded and propagated to contact tier
- ✅ Two-gate rule: ingesting a contact ≠ consent to message them
- 🔲 **STOP handling tested** — send STOP from a test number, verify: (a) contact tier set to 0, (b) no further SMS ever sent, (c) re-opt-in flow works
- 🔲 **Consent ledger audited** — verify every send path checks consent before sending

---

## 2. Infrastructure

### Fly.io
- 🔲 **`auto_stop_machines = false` verified holding** — machine kept crashing and stopping (fixed 2026-06-19). Confirm health check stays green for 48h+ before launch.
- 🔲 **Volume backup enabled** — enable Fly volume snapshots, verify restore works on a staging copy
- 🔲 **Memory/CPU sized for load** — current: 512MB / 1 shared CPU. Load test at 50 concurrent users before scaling decision.
- 🔲 **Two machines minimum** — single machine is a single point of failure. Add a second for rolling deploys and redundancy.
- 🔲 **Deploy pipeline** — currently manual `fly deploy`. Set up GitHub Actions: push to `main` → run tests → deploy if green.

### Twilio
- ✅ A2P 10DLC registration documented (`docs/twilio-a2p-registration.md`)
- 🔲 **A2P registration completed** — without this, SMS throughput is throttled and messages may be filtered as spam
- 🔲 **Webhook signature validation** — verify `WEBHOOK_SECRET` is checked on every inbound Twilio request (prevents spoofed webhooks)
- 🔲 **SMS error handling** — test: what happens when Twilio returns a non-200? Is the message retried? Is the user notified?

### Dependencies
- 🔲 **`npm audit` clean** — currently 12 vulnerabilities (10 moderate, 2 critical). Resolve critical ones before launch.
  - Run `npm audit --json` to identify packages
  - Update or replace affected packages
  - Re-audit after changes
- 🔲 **Node.js version pinned** — currently using node:20-alpine in Dockerfile. Pin to a specific patch version.
- 🔲 **Dependency lock file committed and clean** — `web/package-lock.json` committed ✅, but ensure no drift between local and prod.

---

## 3. Testing

### Unit tests
- 🔲 **`mcp-messages.js`** — test every builder with valid + invalid inputs; confirm validator blocks free-text strings
- 🔲 **`coordination.js`** — test state machine transitions; test window intersection edge cases (already smoke-tested, needs formal test file)
- 🔲 **`desires.js`** — test sanitizer with fuzzed inputs; test `buildSummary` for all desire type combos
- 🔲 **`db.js`** — test that `coord_desires` view never exposes `raw_text`; test `zeroDesireRawText` actually zeroes

### Integration tests
- 🔲 **End-to-end coordination flow** — two test agents, one probes the other, full 3-round negotiation, human approves → event created
- 🔲 **Ambient intent flow** — agent A broadcasts; agent B queries "what's on tonight?"; verify B gets category + area but no venue or identity
- 🔲 **Desire → candidate resolution → probing** — user says "any close friend", agent resolves candidates by cadence, sends probes autonomously
- ✅ Basic consent test (`web/tests/consent.test.js` exists)

### Security tests
- 🔲 **Cross-user read attempt** — with two test users, verify that no query path returns user B's data when running in user A's context
- 🔲 **Free-text injection** — attempt to inject raw text into a coordination message via the builder API; verify validator throws
- 🔲 **STOP bypass attempt** — attempt to send SMS to an opted-out number via all code paths; verify all are blocked

### Load / chaos
- 🔲 **Concurrent coordination sessions** — 10 simultaneous sessions across 5 test users; no state bleed
- 🔲 **Machine restart mid-session** — start a coordination session, restart the Fly machine, verify session recovers from DB state

---

## 4. Legal & Compliance

- 🔲 **Privacy policy published** at `https://butterflai.social/privacy`
  - Must disclose: what is stored, how long, who can read it (us, with audit log), deletion rights, contact data handling, agent-to-agent communication, backup retention window
  - Must NOT claim "we can't read your data" — we can; the honest statement is that every read is logged and audited
- 🔲 **Terms of service published** at `https://butterflai.social/terms`
- 🔲 **GDPR / CCPA readiness** — hard delete tested, data portability export (what data do we hold about you?), DPA if processing EU data
- 🔲 **Contact data disclosure** — onboarding clearly states that contacts' data is stored and what it's used for
- 🔲 **Self-identify language reviewed by a human** — the mandatory first-contact text ("This is [User]'s ButterflAI assistant...") should be reviewed for clarity and legal adequacy

---

## 5. Observability

- 🔲 **Error alerting** — Fly machine crash → alert via email or SMS
- 🔲 **Agent loop health metric** — if the agent loop stops processing messages for >10 minutes, alert
- 🔲 **Failed SMS metric** — track Twilio delivery failures; alert if failure rate >5%
- 🔲 **Coordination session stuck metric** — sessions in `ESCALATE_HUMAN` state for >24h
- 🔲 **Access audit log review** — periodic (weekly) review of `access_audit` to catch unexpected reads

---

## 6. KMS Production Cutover (Detailed Steps)

When ready to swap `local` → `aws`:

1. **Provision AWS KMS key**
   ```sh
   aws kms create-key --description "butterflai-private-data" --key-usage ENCRYPT_DECRYPT
   # Note the KeyId / KeyArn
   aws kms create-alias --alias-name alias/butterflai --target-key-id <KeyId>
   ```

2. **Create IAM role for Fly** — least-privilege: only `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey` on this key

3. **Set Fly secrets**
   ```sh
   fly secrets set KMS_PROVIDER=aws
   fly secrets set KMS_KEY_ARN=arn:aws:kms:us-east-1:...
   fly secrets set AWS_ACCESS_KEY_ID=...
   fly secrets set AWS_SECRET_ACCESS_KEY=...
   ```

4. **Re-encrypt existing private_data rows** — existing rows were encrypted with the local key. Write a migration script that: reads each row (using old local key), re-encrypts under KMS, writes back. Run in staging first.

5. **Remove `KMS_MASTER_KEY_HEX`** from Fly secrets after migration verified.

6. **Rotate KMS key annually** — set a calendar reminder.

---

## 7. Per-User SQLite Migration (Detailed Steps)

When ready to split the DB:

1. **Write `scripts/migrate-per-user-db.js`**
   - Open `main.sqlite`
   - For each user: create `users/{user_id}.sqlite`, copy their rows from all per-user tables, verify row counts match, delete from shared tables
   - Tables that move: `desires`, `coordination_sessions`, `coord_session_peers`, `ambient_signals`, `contacts`, `contact_preferences`, `private_data`, `access_audit`, `user_preferences`, `conversation_history`, `cadences`, `relationships`, `onboarding_intents`, `activities`, `pending_actions`, `agent_messages`
   - Tables that stay in `main.sqlite`: `users`, `invites`, `sms_optouts`, `consent_records`, `_migrations`

2. **Update `db.js`** — add `openUserDb(userId)` that returns a Database instance for that user's file; cache open handles with LRU eviction

3. **Update all callers** — any module that currently calls `db.*` for per-user data now calls `userDb.*`

4. **Run full test suite** against migrated structure

5. **Deploy with feature flag** — run both old and new path in parallel on staging, verify outputs match

---

## 8. Pre-Launch Sign-Off

- 🔲 All ✅ items above confirmed
- 🔲 Privacy policy and ToS live and linked from app
- 🔲 A2P 10DLC registration approved by Twilio
- 🔲 KMS cutover complete
- 🔲 48h smoke test with real (internal) users: Sean + 2-3 others
- 🔲 First external user onboarded manually (watch the logs live)
