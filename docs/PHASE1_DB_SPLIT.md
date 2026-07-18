# Phase 1 — Per-User Data Isolation: Design

> Source: workflow map+design of the ButterflAI data layer (2026-07-18). Persisted from the analysis so it survives across sessions. Implementation proceeds in the staged increments in §5.

## Implementation status (2026-07-18) — draft PR #8, branch `phase1/per-user-isolation`

**Done and proven (isolation validated under `SPLIT_MODE=1`; flag-off suite 461/461):**
- The routing **seam**: `initDatabase(handle)`, `openDb`, `shardFor(userId)`, `_raw(userId)` — flag-gated (`SPLIT_MODE`), returns `main` for everyone while off. Cross-file FK handling (shards run FK-off; `main` FK-on).
- Shard schema completeness (folded `calendar_tokens`, `venue_favorites` into `db/schema.sql`).
- **Threaded to the owner's shard:** `sensitive.js` (all private/health data + sharing + audit); `db.js` core state — `user_preferences`, `conversation_history`, `private_data`, `access_audit`, `onboarding_intents`, `user_wallets`, `pending_actions` (deletePendingAction now takes userId).
- **contact_directory foundation** (main): `syncContactDirectory` on every contact write + `getContactOwner(contactId)`. Additive — no read path uses it yet.

**Next (each its own increment), in order:**
1. **Contacts read-path rewrite (HIGH RISK — inbound SMS routing):** wire `getContactByPhone` and the `/sms` webhook routing onto `contact_directory`, then move `contacts` (+ `contact_preferences`, `contact_groups`) per-user, routing id-keyed methods via `getContactOwner`.
2. **relationships/cadences/activities cluster** (move together — they JOIN) + **desires**.
3. Direct `db._raw()` sites on per-user tables in `agent.js` / `multiparty.js` / `server.js`; **background loops** (`coord-loop`, `cadence`) → directory-driven fan-out (replace `SELECT * FROM users` scans).
4. Flag-on **full-suite CI lane**, then **prod cutover** (§4: backup → migrate → verify → flip `SPLIT_MODE=1` → drop; reversible).

Tables intentionally kept in `main` (cross-user / transport): `agent_messages`, `inbound_messages`, `coordination_sessions`, `coord_session_peers`, `ambient_signals`, `social_events`, `event_invitations`, `referrals`, `consent_records`, `otp_codes`, `sms_optouts`, `contact_directory`.

---

All maps verified against the actual code. Here is the design doc.

---

# ButterflAI Per-User SQLite Split — Design Doc

**Status:** proposal · **Target:** `main.sqlite` (directory/routing/coordination) + `data/users/{user_id}.sqlite` (one file per user's private data) · **Constraint:** LIVE app, real data, 442+ tests must stay green at every step.

## 0. Honest bottom line first

A full physical split in one pass is **too risky** to ship safely. The reasons are structural, not cosmetic:

- **~122 production `db._raw()` call sites across 15 modules** (`web/multiparty.js` 27, `web/sensitive.js` 14, `web/server.js` 13, `web/agent.js` 12, …) each assume `_raw()` returns *the one and only* handle. Every one is a place a query could silently hit the wrong shard.
- **Background loops scan all users in one SQL statement**: `SELECT id FROM users` (`web/coord-loop.js:208`), `SELECT * FROM users` (`web/cadence.js:112,190`). These *vanish* the instant `users`' private columns move per-shard.
- **FK enforcement is ON** (`web/db.js:23`) and dozens of tables `REFERENCES users(id)`. A cross-file FK cannot exist, so splitting forces dropping/relaxing real constraints — a correctness downgrade if done carelessly.
- **`admin.js` merge/delete and `db.js:790` purge are single `db.transaction()` blocks spanning many tables.** A transaction cannot span two SQLite connections; these become non-atomic orchestration the moment tables live in different files.

**Recommendation:** do the split as a **sequence of independently shippable increments**, where the *first shipped increment delivers real isolation without moving a single byte*: a **structurally-enforced per-user data-access layer** (`db.forUser(userId)`) that today still points at the one physical DB, but makes "which user is this query for?" an explicit, testable, enforced parameter. Physical file separation is layered on top only after every access path is routed through that seam. This bounds blast radius: the seam is introduced once, tested once, and the physical move becomes a config change behind it.

Everything below is written to that staged plan.

---

## 1. Table placement

Default rule: **cross-user coordination / contact-directory / agent-transport / phone-keyed compliance tables stay in `main.sqlite` for v1.** Only *clearly single-owner, post-resolution* data moves to `users/{user_id}.sqlite`. When in doubt, keep it in main (a table in main is always correct-but-not-isolated; a mis-sharded cross-user table is a data-leak/loss bug).

### Stays in `main.sqlite`

| Table | Why main |
|---|---|
| `users` (**routing/identity columns only**: `id, phone, telegram_id, agent_endpoint, referral_token, onboarding_state`, plus coarse directory fields `city, lat, lng, timezone, share_location`) | THE directory. `getUserByPhone` (`db.js:97`) maps an inbound `From` → user_id *before* any shard can be opened (`server.js:199,242,252`; `webapp-auth.js:141`). All 4 external keys are UNIQUE routing keys. Coarse location kept here so `check_invitee_locations` (`agent.js:1047`) answers N peers from one lookup honoring `share_location`. |
| `otp_codes` | Phone-keyed, written **before the user row exists** (`webapp-auth.js:32`, user created only after verify). No shard to write to yet. |
| `sms_optouts` | Phone-keyed legal suppression gate, checked before routing (`server.js:210`), applies to non-users. Must enforce with no user_id in hand. |
| `consent_records` | Phone-keyed compliance ledger; the outbound `send()` gate. A phone is a contact of many users. |
| `invites` | Resolved by opaque token before auth (`server.js:314…503`); reader-user unknown until read. |
| `referrals` + `users.referral_token` | Token→referrer resolved pre-auth (`server.js:994,596`); links two users. |
| `agent_messages` | **Canonical cross-user.** Every row has `from_user` AND `to_user` (`db.js:611`). One row belongs to neither shard. Shared transport. |
| `inbound_messages` | Global dispatch queue scanned `WHERE processed=0` by the single agent loop (`db.js:472`); enqueued for **contacts** (non-users) too (`server.js:243`). |
| `coordination_sessions`, `coord_session_peers` | Both parties' agents mutate rows under the **same shared `session_id`** (`coordination.js:75,409`). `coord_session_peers` stores the *other* user's data. Sharding fractures the shared key. |
| `ambient_signals` | Shared short-TTL bus; `getAmbientSignalsForDate(date)` returns ALL peers' signals (`db.js:759`). Keyed by date, not user. |
| `social_events`, `event_invitations` | Guest-side reads/writes cross into the host's event graph everywhere (`multiparty.js:252,339,365,409,468`; `server.js:228,886`; `agent.js:1108`). Keeping the event store shared avoids scanning every host's shard on each inbound RSVP. Owned by host, but *read by guests platform-wide* → main for v1. |
| `consent_edges` | Joined to `users.agent_endpoint` at the MCP boundary (`db.js:172`, `server.js:1780`). Owner-scoped but consulted during peer routing; keep with the coordination cluster in main for v1 (revisit → per-user once routing resolves endpoint→user in main first). |
| `_migrations` | Per-database bookkeeping — **each DB (main and every shard) gets its own.** Not moved; replicated by construction. |

**New routing directories to add in `main.sqlite`** (replace today's unscoped scans):

- `contact_directory(phone, owner_user_id, contact_id, PRIMARY KEY(phone, owner_user_id))` — maintained on contact upsert/opt-out. Replaces unscoped `getContactByPhone` (`db.js:159`) so an inbound phone finds which owner-shard(s) hold it.
- `reply_expectations(phone|contact_id, event_id, host_user_id, expires_at)` — written whenever an invite SMS goes out; lets an inbound reply route to the correct host without a cross-host scan (`server.js:228`, `multiparty.js:252`).
- `desire_workqueue(user_id, due_at)` (optional, Stage 4+) — replaces `SELECT DISTINCT user_id FROM coord_desires` (`coord-loop.js:142`) and `SELECT id FROM users` fan-out drivers so background loops enumerate work from main.

### Moves to `users/{user_id}.sqlite`

Everything below is keyed by `user_id` (or reaches it via a parent) and is only ever touched **after** the user is resolved / `requireAuth` has run.

| Table | Owner key | Why per-user (rationale) |
|---|---|---|
| `users` **profile columns** (`name, nickname, onboarding_data, …`) | `id` | Private profile; not routing. (Optional — see §Tension below; may stay duplicated in main for v1.) |
| `contacts` | `invited_by_user_id` | Private relationship rows; rich fields per-user. Directory row in main covers the phone→owner lookup. |
| `contact_preferences` | `contact_id` | Single-subject coordination prefs; owner-scoped. |
| `private_data` (legacy) | `user_id` | Per-user AES blob, never cross-user readable. |
| `user_private_data` | `user_id` | Per-record AES secrets. **Cross-user-flagged only via `sharing_approved_to`** — but the *bytes* are single-owner; sharing is mediated by owner-side reads (§3). Stays per-user; the encryption/audit boundary lives inside the owner shard. |
| `private_data_access_log`, `access_audit` | `user_id` (whose data) | Audit of the owner's decrypts; lives with the data it audits. |
| `user_preferences` | `user_id` | Post-auth coordination prefs. |
| `conversation_history` | `user_id` | Private transcript, always post-resolution (`db.js:488`). |
| `pending_actions` | `user_id` | SMS state, read only after user resolved (`server.js:259`). |
| `onboarding_intents` | `user_id` | Onboarding scratch. |
| `relationships`, `cadences`, `activities` | `user_id` (cadence/activity via parent) | The organiser's graph. `activities.participants` is multi-party JSON but the row is organiser-owned; add `owner_user_id` denormalized onto `activities` so `getActivityOrganiser` (`db.js:429`) routes without a join. |
| `desires`, `coord_desires` (view) | `user_id` | Private desire; `raw_text` zeroed after parse. |
| `desire_deletions` | `user_id` | GDPR receipt. |
| `budgets`, `user_wallets`, `flai_ledger` | `user_id` | Per-user economy. **`flai_ledger` caveat:** written per-user but *read globally* (`getFlaiLedgerSummary` `db.js:973`). For v1 keep it per-user AND keep the admin aggregate by summing over the directory (§6), OR leave `flai_ledger` in main. **Recommend per-user + directory-sum** to preserve isolation; accept slower admin stats. |
| `attendance_confirmations`, `proposals`, `lift_observations` | `user_id` | Per-attendee/per-user records. `event_id` is a provenance link resolved via the shared event store in main. |
| `push_subscriptions` | `user_id` | Device rows, always by user_id. |
| `contact_groups`, `contact_group_members` | `user_id` / via `group_id` | Single-owner lists. |
| `venue_favorites` | `user_id` | Per-user saved venues (created in JS, `venues.js:28`). |
| `calendar_tokens` | `user_id` | Per-user OAuth tokens (created in JS, `calendar.js:31`). |

**Genuinely cross_user tables, decided:** `contacts`, `relationships`, `activities`, `agent_messages`, `coordination_sessions`, `coord_session_peers`, `ambient_signals`, `referrals`, `user_private_data`, `private_data_access_log`, `social_events`, `event_invitations`.

- `agent_messages`, `ambient_signals`, `coordination_sessions`, `coord_session_peers`, `referrals`, `social_events`, `event_invitations` → **main** (transport/shared-key/multi-reader; justified above).
- `contacts`, `relationships`, `activities` → **per-user** despite pointing at other people, because each row has exactly ONE owner and the "other person" is resolved through the main directory, not stored as a co-owned row. This preserves isolation without breaking routing.
- `user_private_data`, `private_data_access_log` → **per-user**, because the cross-user aspect is *access mediation*, not shared storage; mediation is done by the owner's shard (§3), which is strictly safer than letting a requester open a peer file.

### Tension: `users` profile columns

Two options; **recommend Option A for v1** to minimize churn and keep 442 tests green:

- **Option A (v1):** `users` row stays whole in `main.sqlite`. Nothing about `users` moves. Per-user shards hold only the domain tables. This delivers real isolation for the *sensitive* data (contacts, private_data, conversation history, calendar tokens) — the actual goal — with far less risk. Profile split deferred.
- **Option B (later):** routing columns in main, profile columns per-shard. Requires a thin `users` row (id only) in each shard for local FKs, or dropping those FKs. Do this only after Option A is stable.

---

## 2. The `db.js` API change

**Goal: keep the current exported method surface working so the ~34 consumers don't all change signatures.** The connection becomes an explicit, routed dependency instead of a module singleton — but callers that already pass `userId` keep working.

### 2.1 Connection registry + accessor

Replace the single module-level `const db = new Database(DB_PATH)` (`web/db.js:21`) with a registry:

```js
// web/db.js  (conceptual)
function openDb(file) {
  const h = new Database(file);
  h.pragma('journal_mode = WAL');   // per-file  (was db.js:22)
  h.pragma('foreign_keys = ON');    // per-connection (was db.js:23)
  return h;
}

// Extract the current top-level init (lines 21–83) into a callable:
function initDatabase(handle) { applySchema(handle); applyMigrations(handle); }

const MAIN_PATH = process.env.DB_PATH || <repo>/data/main.sqlite;
const main = openDb(MAIN_PATH); initDatabase(main);   // main directory DB

const shardCache = new Map();       // userId -> handle (LRU-capped)
function shardFor(userId) {
  if (process.env.SPLIT_MODE !== '1') return main;   // <-- v1 flag: still one file
  if (userId == null) throw new Error('shardFor(null)');
  let h = shardCache.get(userId);
  if (!h) { h = openDb(shardPath(userId)); initDatabase(h); shardCache.set(userId, h); }
  return h;
}
```

The `SPLIT_MODE` flag is the crux: **until it flips, `shardFor(x)` returns `main` for every user, so the physical file layout is unchanged and every test behaves identically.** All the routing plumbing ships and is exercised *before* any byte moves.

### 2.2 `_raw()` becomes `_raw(userId)` — backward compatible

Today `_raw()` returns the global handle (`db.js:89`). Change to:

```js
_raw(userId) { return userId == null ? main : shardFor(userId); },
```

- In v1 (`SPLIT_MODE` off) `shardFor` returns `main`, so **`_raw()` with no arg keeps returning the same handle** → the ~122 prod call sites and the test seeds (`events.test.js:43` etc.) keep compiling and passing **untouched**.
- Migrating a call site to isolation is then a *local, mechanical* edit at the natural injection point the code already uses: `sensitive.js`/`admin.js` already do `const raw = db._raw()` at function top (`sensitive.js:145,171,…`; `admin.js:42,75,…`) where a `userId` is in scope → becomes `const raw = db._raw(userId)`. One line each, no signature change to the public function.

### 2.3 Named helpers route internally

Helpers that already take `userId` (`getUser`, `getRecentConversation`, `upsertContact`, `getPreferences`, …) change their internal `db.prepare(...)` to `shardFor(userId).prepare(...)`. **Signature unchanged → zero consumer churn.** Helpers keyed only by a non-user key (`getUserByPhone`, `getInvite`, `getContactByPhone`, `isOptedOut`, `getConsent`, OTP) route to `main`. Helpers touching cross-user main tables (`sendAgentMessage`, `getPendingAgentMessages`, coordination, ambient) route to `main`. This is a **single-file change** (`db.js`) for the sanctioned path.

Helpers that today do a cross-user JOIN in one statement (`getContactByAgentEndpoint` `db.js:172`, `getActivityOrganiser` `db.js:429`, `getPendingAttendanceConfirmations` `db.js:855`, `getFlaiLedgerRecent` `db.js:984`) get **split into two hops**: resolve the id in `main`, then read the owner shard. In v1 (single file) both hops hit the same DB and results are byte-identical — proving the two-hop rewrite correct *before* files separate.

### 2.4 Transactions

`db.transaction()` blocks (`db.js:790`, `sensitive.js:322`, `admin.js:123,161`) must each run on **one** handle. `purgeExpiredCoordination` (all coordination tables → main): unchanged, runs on `main`. `admin` merge/delete: see §6 — becomes per-shard transaction + main-side cleanup + shard-file drop; give up single-transaction atomicity for a **resumable, logged** operation.

### 2.5 `ensure*Tables()` and runtime ALTERs

`venues.js:28`, `calendar.js:31`, `multiparty.js:64` create tables lazily; `contacts-import.js:35`, `cadence.js:47` `ALTER` defensively. **Fold all of these into `initDatabase(handle)`** so every shard gets them at creation, not on first touch. This also removes the reason migrations must swallow `already exists` on shards.

---

## 3. Cross-user reads after the split

Principle: **a user's turn never opens a peer's shard for writing, and opens it for reading only through a narrow, whitelisted, audited path — preferably by routing the request through the owner's own code so the encryption/audit boundary stays inside the owner shard.**

- **`readPrivateDataForSharing(ownerUserId, dataKey, requestingUserId)` (`sensitive.js:202`)** — the request runs *as the owner*: open `shardFor(ownerUserId)`, decrypt with the owner's key, check `sharing_approved_to` against `requestingUserId`, write the approve/deny to `private_data_access_log` **in the owner shard**, return only the resolved value. The requester never touches the owner's file or key. Recipient existence is validated against the `users` directory in `main`, not an FK (§`approveSharing` `sensitive.js:234`). This is *safer than today's* single-DB read because the boundary is now physical.

- **`get_contact_hard_constraints` (`agent.js:965`)** — resolve contact→peer via `main` directory (`getUserByPhone`). Then read ONLY the whitelisted hard-constraint columns (`allergies`, `diet`) from `shardFor(peerId)`'s `user_preferences`, and the health note *only* via the owner-mediated `readPrivateDataForSharing` above. Soft prefs/notes columns are never selected during an `agent_query` turn — enforced by a dedicated read function that hard-codes the column list (preserves the `coordinationOnly` wall, `agent.js:1560`).

- **`check_invitee_locations` (`agent.js:1047`)** — answered entirely from `main`: coarse `city/lat/lng/share_location` live on the directory row. **No peer shard opened at all.** Honors `share_location` in main.

- **Coordination peers / probes (`coordination.js:75,409`; `coord-loop.js:79`)** — `coordination_sessions` + `coord_session_peers` + `ambient_signals` + `agent_messages` all in `main`. Both agents mutate the shared `session_id` row in one file. The initiator's `desires` stay in the initiator's shard, referenced by `desire_id`; the session row carries a **denormalized category/summary + `initiator_user_id`** so escalation (`coord-loop.js:235`) needs no per-user join.

- **`message_agent` / `reply_agent` (`agent.js:874,893`)** — resolve peer via `main` directory; write the `agent_messages` row to `main`; deliver by writing an `inbound_messages` row to `main` (shared queue). No peer shard opened.

- **Inbound RSVP (`multiparty.js:252`, `server.js:228`)** — `social_events`/`event_invitations` in `main`, so the guest's reply updates the host's invitation and appends to the host's `conversation_history` via a **queued `inbound_messages` row the host's shard consumes** (rather than a foreign write into the host shard). The host's agent loop drains its own queue and writes its own conversation history — writes stay owner-local.

**Rule of thumb:** cross-user *writes* are always delivered as a message into `main`'s shared queue and applied by the target's own loop; cross-user *reads* of sensitive data go through the owner's mediated function; cross-user reads of coarse/directory data hit `main`.

---

## 4. Migration (idempotent, reversible, startup-run)

Runs inside `initDatabase`/boot, **guarded by `SPLIT_MODE`**. While `SPLIT_MODE=0` nothing physical happens — the code path is dead and prod is byte-for-byte today's layout.

**First boot in prod with `SPLIT_MODE=1`:**

1. **Backup (mandatory, blocking).** Before touching anything: `sqlite3 butterflai.sqlite ".backup 'butterflai.pre-split.<ts>.sqlite'"` (online-consistent copy). Refuse to proceed if the backup file is missing or smaller than source. This is the reversibility anchor.
2. **Create `main.sqlite`** by `.backup`-copying the current DB, then **dropping** the tables that become per-user-only (after step 4 confirms copy). Actually order it safely: build main and shards *additively first*, drop nothing until verification passes.
3. **Enumerate users** from the existing `users` table (still the single source).
4. **For each user:** create `users/{id}.sqlite`, run `initDatabase` (full schema + all ~35 migrations + `ensure*` tables), then `INSERT ... SELECT` that user's rows from the source DB into the shard, per per-user table, filtered by the owner key (`user_id` / via parent join). Populate `contact_directory` and `reply_expectations` in `main` from `contacts` / outstanding invitations. Each step wrapped so re-running skips already-copied shards (idempotent: presence of `users/{id}.sqlite` with a `_split_done` marker row means skip).
5. **Verification (blocking).** Before deleting any source data: for each per-user table, assert `SUM(rowcount across shards) == rowcount in source`. Assert every shard opens, has `_migrations` fully applied, and `PRAGMA integrity_check = ok`. Assert `contact_directory` covers every `contacts.phone`. **If any check fails, abort and leave source untouched** — the app can still boot in `SPLIT_MODE=0` off the backup.
6. **Cutover.** Only after verification: drop the per-user tables from `main.sqlite` (they're now redundant), leaving main with directory/routing/coordination tables. Write a `split_complete` marker in `main._migrations`.

**Reversibility:** at any point before step 6, deletion of `data/main.sqlite` + `data/users/` and setting `SPLIT_MODE=0` restores the original single-file behavior from the untouched source (or the step-1 backup). After step 6, a **down-migration** re-attaches: create a fresh single DB, `INSERT ... SELECT` per-user rows back from every shard + copy main's shared tables. Because the split is additive-then-verify-then-drop, there is always a consistent source until the final drop, and always a `.backup` after.

**Idempotency:** every create/copy checks a marker; re-running boot after a crash resumes (shards already marked `_split_done` are skipped, verification re-runs). The `_migrations` swallow-on-`no such table` behavior (`db.js:65`) is a hazard on empty shards — so §2.5 folds `ensure*` tables into `initDatabase` and Stage 1 (below) **verifies the migration set is self-sufficient against an empty DB** first.

---

## 5. Staging (each step ships independently, 442+ tests stay green)

**Stage 0 — Prove migrations are self-sufficient (no behavior change).** Add a test that spins an empty DB and runs `initDatabase`, asserting all ~50 tables exist without relying on `no such table` swallowing. Fix any migration that assumes prior ad-hoc creation; fold `ensure*Tables()`/defensive `ALTER`s into `initDatabase`. Lowest risk: pure test + refactor of init, single file. *Green because runtime behavior is identical.*

**Stage 1 — Introduce the seam, single file underneath.** Extract `initDatabase(handle)`, add `openDb`, `shardFor(userId)` returning `main` while `SPLIT_MODE=0`, change `_raw()` → `_raw(userId)` with `null`→`main`. Route named helpers through `shardFor(userId)`. **No file moves, no call-site edits required** (default arg keeps `_raw()` working). *Green because every handle still resolves to the same physical DB.* **This is the real deliverable of increment 1: an enforced access seam.**

**Stage 2 — Add directories + two-hop rewrites, still single file.** Create `contact_directory` and `reply_expectations` in main; maintain them on contact upsert / invite send. Rewrite the cross-user JOIN helpers (`getContactByAgentEndpoint`, `getActivityOrganiser`, `getPendingAttendanceConfirmations`, RSVP routing) into resolve-in-main-then-read-shard two-hop form. *Green because both hops hit the same file and return identical rows;* add tests asserting the two-hop result equals the old single-JOIN result.

**Stage 3 — Thread `userId` into `_raw()` call sites, module by module, heaviest first.** `multiparty.js` (27) and `sensitive.js` (14) first, then `server.js`, `agent.js`, loops. Each `db._raw()` → `db._raw(userId)` where the owner is in scope; cross-user main-table access explicitly `db._raw(null)`/named main helper. Ship one module per PR. *Green because `shardFor` still returns `main`.* This is where the "which user?" question becomes explicit and reviewable everywhere — the isolation contract exists in code before any physical split.

**Stage 4 — Convert background loops to directory-driven fan-out.** Replace `SELECT id FROM users`/`SELECT * FROM users` scans (`coord-loop.js:208`, `cadence.js:112,190`) with: enumerate ids from `main`, then per-id call helpers that use `shardFor(id)`. *Green single-file;* tests assert same set of users processed.

**Stage 5 — Flip `SPLIT_MODE=1` in a staging/CI env only + run the §4 migration.** Add a test harness mode where the connection factory maps each test user to a real per-user in-memory shard (honoring the `:memory:` seam, `db.js:18`) instead of one shared `:memory:`. Run the full suite in split mode. Fix leaks surfaced (any query that returned another user's row now returns empty → a real isolation bug caught). *This is the first step where "green" means green under actual physical separation.*

**Stage 6 — Prod cutover.** Backup → migrate → verify → flip `SPLIT_MODE=1` in prod → cutover drop. Rollback = flip flag off, restore backup.

Only Stages 5–6 involve physical separation; Stages 1–4 each ship real, test-green structural isolation with zero data movement.

---

## 6. Risks & test strategy

| # | Failure mode | How it happens | Guard |
|---|---|---|---|
| 1 | **Cross-user data leak** — a query returns another user's row | A `db._raw()` site not threaded with `userId`, or a helper routed to the wrong shard | **Isolation test matrix (Stage 5):** seed 2 users in separate shards, run every read helper as user A, assert zero user-B rows ever returned. In split-mode this is a hard boundary; any leak = empty vs populated mismatch. Also a lint/grep CI check forbidding bare `db._raw()` (no arg) in prod modules after Stage 3. |
| 2 | **Silent data loss on migration** | `INSERT..SELECT` filter drops rows whose owner key is null/via-parent (e.g. `flai_ledger.user_id` NULLABLE, `activities.cadence_id` nullable) | **Row-count conservation check is blocking (§4 step 5):** `SUM(shard counts)+main counts == source counts` per table, abort on mismatch. Explicit test for null-owner rows: they route to a designated home (null-owner `flai_ledger`/`lift_observations` → main system-ledger; orphan `activities` → resolved via denormalized `owner_user_id`). |
| 3 | **Corruption via non-atomic admin merge/delete** | `admin.js:123,161` transaction can't span shards; a crash mid-merge leaves half-moved footprints | Convert to **resumable, logged** orchestration: write a merge-journal row in main, copy dropId's shard rows into keepId's shard, rewrite main ownership columns (`agent_messages.from/to_user`, `event_invitations`, `coord_session_peers`), then drop dropId's file; on restart resume from journal. Test: kill-and-resume merge, assert final footprint == union, no dupes. |
| 4 | **FK silently unenforced across files** | Tables `REFERENCES users(id)` in shards can't FK to main's `users` | Decide per table: keep Option A (`users` whole in main) so shard-local FKs to a duplicated thin `users(id)` row, OR drop the FK and add an app-level directory check. Test: attempt orphan insert, assert app-layer rejection where FK was load-bearing. |
| 5 | **Routing miss** — inbound SMS/RSVP can't find its user/host | `contact_directory`/`reply_expectations` not maintained on every write path | Maintain in the same helper that writes `contacts`/`invitations` (single choke point). Test: end-to-end inbound RSVP from a guest phone lands on the correct host in split mode; opt-out by pure-contact phone still gates (`sms_optouts`). |
| 6 | **WAL/file sprawl & fd exhaustion** | N shards → 3N files (`-wal`/`-shm`), unbounded open handles | LRU-cap `shardCache`, `PRAGMA wal_checkpoint` + close on eviction. Backup tooling updated to snapshot `main` + all shards consistently. Test: open >cap users, assert handles bounded and data still correct after eviction/reopen. |
| 7 | **Sensitive read escapes the owner boundary** | A refactor opens a peer shard read-only for a health note instead of owner-mediated read | Enforce single entry point `readPrivateDataForSharing` that only ever opens `shardFor(ownerUserId)`; grep-guard against `shardFor(peerId)` in requester paths. Test: requester NOT in `sharing_approved_to` gets denial + audit row **in owner shard**; `agent_query` turn cannot select soft-pref columns (column-whitelist test preserving the `coordinationOnly` wall, `agent.js:1560`). |
| 8 | **Test suite hidden coupling** | ~20 tests assume one shared `:memory:` DB for all users (`db.js:18` seam); split-mode changes what they see | Stage 5 factory maps test users to real per-user in-memory shards; audit each test that seeds via `_raw().prepare('INSERT INTO users')` (`events.test.js:43`) to seed into the right store. Keep a `SPLIT_MODE=0` CI lane AND a `SPLIT_MODE=1` lane both green through Stages 1–4. |

**Net:** the design keeps `main.sqlite` as the authoritative directory + shared coordination/transport layer, moves only unambiguously single-owner private data into per-user shards, and — critically — ships the *isolation contract* (`db.forUser`/`_raw(userId)`, directories, two-hop reads, owner-mediated sensitive access) as test-green increments **before** any physical file separation, so the risky byte-move (Stages 5–6) happens against code that already treats every access as user-scoped.

Relevant files: `/home/aphilos/GI/git/ButterflAI/web/db.js` (seam, lines 18–89, 42–83), `/home/aphilos/GI/git/ButterflAI/web/sensitive.js` (owner-mediated reads, 145–322), `/home/aphilos/GI/git/ButterflAI/web/multiparty.js` (event/RSVP cross-user, 252–468), `/home/aphilos/GI/git/ButterflAI/web/coord-loop.js` (all-user scans, 142–235), `/home/aphilos/GI/git/ButterflAI/web/cadence.js` (112,190), `/home/aphilos/GI/git/ButterflAI/web/admin.js` (merge/delete transactions, 93–161), `/home/aphilos/GI/git/ButterflAI/db/schema.sql`, `/home/aphilos/GI/git/ButterflAI/db/migrations/` + `/home/aphilos/GI/git/ButterflAI/web/db/migrations/`.

---

## Appendix A — cross-user access sites (map)

- `web/db.js:97` **getUserByPhone(phone)** — The fundamental cross-user resolver: given a phone number (usually taken from one user's contact row) it returns another user's full users row. Called everywhere a contact must be mapped to the ButterflAI account behind it (message_agent, get_contact_hard_constraints, check_invitee_locations, resolvePeerAgentIds, private-sharing, RSVP flows). _(why hard: A physical per-user split has no single place to answer 'which user owns this phone' — the lookup is inherently global. Keep the users identity/routing columns (id, phone, telegram_id, agent_endpoint, referral_token, and coarse fields like city/lat/lng/share_location/timezone) in main.sqlite as a global directory; per-user DBs hold only that user's private rows. Contact→user resolution then hits main first, then opens the resolved user's DB only if genuinely needed.)_
- `web/db.js:172` **getContactByAgentEndpoint(agentEndpoint, ownerUserId)** — JOINs contacts → consent_edges → users to answer: does ownerUserId have a contact whose linked ButterflAI account has this agent_endpoint, and may it coordinate? Used by the MCP inbound handler to gate peer messages. _(why hard: Single query spans the owner's private tables (contacts, consent_edges) AND the global users table joined by phone=agent_endpoint. Split it: resolve agent_endpoint→user_id in main.sqlite, then open ownerUserId's DB read-only to check the contact + consent_edge for that resolved peer id.)_
- `web/db.js:611` **sendAgentMessage / getPendingAgentMessages / markAgentMessageProcessed** — agent_messages is a mailbox whose rows carry from_user and to_user — every row spans two distinct users (sender and recipient). Written by message_agent/reply_agent, read by the recipient's agent loop. _(why hard: A single row references two users, so it cannot belong cleanly to either per-user DB. Keep agent_messages in main.sqlite as a shared transport table (or write only to the recipient's inbox DB and drop the sender FK), indexed by to_user/thread_id.)_
- `web/db.js:759` **upsertAmbientSignal / getAmbientSignalsForDate / deleteAmbientSignal** — ambient_signals is a shared pool: each row's from_agent_id is some peer user's agent, and getAmbientSignalsForDate(date) returns ALL peers' signals for a day so any local user can ask 'what's happening tonight?' _(why hard: The read is intentionally many-users-at-once and keyed by date, not user. Keep ambient_signals in main.sqlite as a shared bus (it is already short-TTL and purged), rather than sharding by author.)_
- `web/db.js:719` **createCoordPeer / getCoordPeers / getCoordPeer** — coord_session_peers rows hold peer_agent_id and peer_user_id — the OTHER user in a negotiation — plus that peer's offered/matched availability windows. _(why hard: Peer rows describe a second user's data attached to the initiator's session; the responder side also writes peer rows for the initiator. Keep coordination_sessions + coord_session_peers in main.sqlite (shared negotiation scratch space keyed by the shared session_id), since both parties' agents mutate rows under the same session id.)_
- `web/db.js:429` **getActivityOrganiser(activityId)** — JOINs activities → cadences → relationships → users to return the organiser user for an activity id, when the caller has only the activity id and not the owning user. _(why hard: Although all four tables belong to the organiser, the entry point is a bare activity id with no user context — in a per-user split you don't know which DB to open. Keep an activity_id→owner_user_id index in main.sqlite (or embed owner_user_id on the activity) so you can route to the right per-user DB before joining.)_
- `web/db.js:855` **getPendingAttendanceConfirmations(userId)** — JOINs activities → cadences → relationships and NOT EXISTS against attendance_confirmations to find events the user accepted but hasn't confirmed attendance for. _(why hard: Within one user's graph, but attendance_confirmations is keyed by (event_id, user_id) where events can be authored by other users (social_events host). If attendance rows live per-user this is fine; but the underlying event_id may reference a host's social_events row, so keep event identity resolvable in main.sqlite.)_
- `web/coordination.js:409` **handleProbeInbound (responder) + checkConsent(localUserId, payload.from_user_id)** — On an inbound probe, the responder creates a coordination_session reusing the INITIATOR's session_id as a shared key, stores peerUserId = the initiator (another user), and calls checkConsent to authorize one user acting on behalf of another. _(why hard: Both the initiator's and responder's agents write rows keyed by the same shared session_id — inherently cross-DB if sessions were sharded per user. Keep coordination_sessions/peers in main.sqlite so the shared session_id is a single row both sides update.)_
- `web/coordination.js:75` **createSession / startProbing (initiator)** — Creates the session for the initiator and one coord_session_peers row per peer agent endpoint (each endpoint belongs to a different user), then sends probes out to those peer agents. _(why hard: Session fans out to N other users' agents; peer rows reference those users. Shared coordination tables in main.sqlite (per the entry above); the desire itself (desires/coord_desires) stays in the initiator's per-user DB and is referenced by desire_id.)_
- `web/coordination.js:590` **handleAmbientIntentInbound / getAmbientSummary** — Stores inbound ambient signals from peer agents and aggregates every peer's signals for a date into an anonymized summary for local users. _(why hard: Cross-user aggregate over a shared pool. Same handling as db.js ambient_signals — keep it in main.sqlite as a shared, short-lived bus.)_
- `web/coord-loop.js:79` **resolvePeerAgentIds(userId, desire)** — For each of this user's candidate contacts, calls getUserByPhone(contact.phone) then reads that OTHER user's agent_endpoint, to build the list of peer agents to probe. _(why hard: Maps one user's contacts to other users' agent endpoints. Resolve contact→user via the main.sqlite directory (phone→user_id, agent_endpoint), keeping the contact rows themselves in the initiator's per-user DB.)_
- `web/coord-loop.js:142` **tickDesires (SELECT DISTINCT user_id FROM coord_desires)** — Background loop scans EVERY user's pending social desires in one query to decide which need coordination sessions started. _(why hard: A single query over all users' desires disappears once desires are sharded per-user DB. Replace with an iteration over the user directory in main.sqlite (SELECT id FROM users), opening each per-user DB in turn — or maintain a global 'users with pending desires' work-queue table in main.)_
- `web/coord-loop.js:207` **tickRecurring (SELECT id FROM users) + getDueRecurringTemplates per user** — Enumerates all users, then finds each user's due recurring desire templates to spawn new instances. _(why hard: Cross-user enumeration driver. The user list comes from main.sqlite; the per-user template query must run against each per-user DB. Fan out over the directory instead of one global scan.)_
- `web/coord-loop.js:235` **tickEscalations (JOIN coordination_sessions ⨝ coord_desires across all users)** — Finds stuck sessions platform-wide by joining sessions to their desires, then notifies the initiator user of each. _(why hard: Joins shared session state to per-user desires across everyone. If sessions live in main and desires live per-user, this join can't be one statement — store the initiator_user_id (already present) and the category/desire summary denormalized onto the session row in main so escalation needs no per-user join.)_
- `web/coord-loop.js:49` **notifyUser(userId, text, meta)** — Coordination code calls this with an arbitrary userId (often a peer/initiator determined by the negotiation) and writes an inbound_messages row into that user's agent queue. _(why hard: The loop delivers into whichever user's inbox the negotiation names — not necessarily the loop's 'current' user. Route via main directory to find the user, then write to that user's per-user inbound_messages DB.)_
- `web/multiparty.js:252` **handleRsvpReply(contactPhone, body)** — A contact's inbound SMS is resolved to a contact, joined through event_invitations → social_events to find the host, then the reply MUTATES the host's data: updates the invitation, appends to the HOST's conversation_history, and SMS-notifies the host. _(why hard: One person's message writes into another user's (the host's) event, conversation history and notification path. Event graph (social_events + event_invitations) must be reachable from the guest side; keep events/invitations in main.sqlite (shared event store) or open the host DB read-write for the invitation update and queue a cross-DB write to the host's conversation_history.)_
- `web/multiparty.js:339` **getInvitedEvents(userPhone)** — JOINs event_invitations → social_events → contacts → users by phone to list events HOSTED BY OTHER USERS that this phone was invited to (with host_name). _(why hard: Reads across every host's events to find ones matching this guest's phone. Per-user split can't scan all hosts' DBs; keep social_events + event_invitations in a shared main.sqlite store (indexed by contact phone / contact_id), joining host name from the users directory.)_
- `web/multiparty.js:365` **rsvpInvitation(invitationId, userPhone, status)** — Verifies the guest owns the invitation's contact by phone, then updates the invitation (which belongs to the host's event) and appends a system note to the HOST's conversation_history. _(why hard: A guest write lands in the host's event + host's conversation history. Same remedy: shared events/invitations in main; cross-DB append to host conversation_history (or queue it as an inbound_message the host's DB owns).)_
- `web/multiparty.js:409` **publicRsvp(eventId, {name, phone, status})** — A stranger RSVPing a public event CREATES a synthetic contact on the HOST's side and an invitation, and appends to the host's conversation_history. _(why hard: An unauthenticated third party writes new rows into a specific host user's contact list and event graph. Requires writing into the host's per-user DB from outside; keep events shared in main and the synthetic contact insert routed to the host DB (or hold public-RSVP contacts in the shared event store, not the host's private contacts).)_
- `web/multiparty.js:468` **wasInvited(contactPhone, eventId) / inviteContacts / dismissInvitation** — wasInvited gates pull-not-push disclosure by checking the host's event_invitations for a contact resolved from a (guest's) phone; inviteContacts writes invitation rows + SMS for a host's chosen contacts; dismissInvitation lets a guest (by phone) hide a row inside the host's event. _(why hard: All three cross the host/guest boundary on the shared event_invitations table (guest identity vs host-owned event). Consolidate social_events + event_invitations in main.sqlite so both host and guest sides operate on one authoritative copy; enforce the disclosure gate there.)_
- `web/sensitive.js:202` **readPrivateDataForSharing(ownerUserId, dataKey, requestingUserId)** — Reads and decrypts ONE owner's encrypted private datum on behalf of a DIFFERENT requesting user, but only if requestingUserId is in that datum's sharing_approved_to list; logs every approved/denied share. _(why hard: The canonical owner-vs-requester cross-user read of the most sensitive table. In a per-user split the requester's agent must reach into the owner's DB. Prefer routing the request THROUGH the owner's agent/DB (owner opens its own user_private_data, checks its own approved list, returns only the value) rather than opening a peer DB read-only — that keeps the encryption boundary and audit log inside the owner's DB.)_
- `web/sensitive.js:234` **approveSharing / revokeSharing / listSharingApprovals** — Owner mutates their datum's sharing_approved_to array, which stores FOREIGN user_ids (the recipients the datum is shared with). _(why hard: Writes stay in the owner's DB, but the stored ids reference users in other DBs, so a foreign key can't be enforced across the split and revocation must be reconciled if a recipient is deleted. Keep approvals in the owner's per-user DB (id list is opaque); validate recipient existence against the main.sqlite directory, not a FK.)_
- `web/agent.js:874` **tool: message_agent** — Resolves a contact to a peer user via getUserByPhone, records an agent_messages row (from userId → targetUser.id), then writes an inbound_messages row into the TARGET user's agent queue so their agent processes it. _(why hard: Directly writes into another user's inbound queue and a two-user mailbox row. Resolve peer via main directory; deliver by writing to the target's per-user inbound_messages DB (or shared agent_messages transport in main), never assuming a single DB.)_
- `web/agent.js:893` **tool: reply_agent** — Loads an agent_messages row (original.from_user is another user), records the reply, and writes an inbound_messages row into the original sender's queue. _(why hard: Reads a cross-user mailbox row and writes back into the other user's inbox. Needs the shared agent_messages table (main) plus cross-DB delivery into the peer's inbound_messages.)_
- `web/agent.js:965` **tool: get_contact_hard_constraints** — Resolves a contact to a peer user, reads that PEER user's user_preferences (allergies/diet only) via getPreferences(contactUser.id), and pulls their health note via readPrivateDataForSharing — i.e. reads two of another user's tables during the requester's turn. _(why hard: Requester's agent reads a peer's preferences + encrypted private data live. Route through the peer's agent/DB or open peer DB read-only for the whitelisted hard-constraint columns only; the health note must go through the owner-side sharing check (see readPrivateDataForSharing).)_
- `web/agent.js:1047` **tool: check_invitee_locations** — For each invitee contact, resolves the peer user and reads their city/lat/lng and share_location flag to compute distance from the host — reading many other users' location fields in one call. _(why hard: Fan-out read of N peers' location data. Keep coarse location + share_location on the users directory row in main.sqlite so a single main lookup answers it without opening N peer DBs; honor share_location there.)_
- `web/agent.js:1108` **tool: confirm_coordination_invite** — Guest RSVPs to a host's event: JOINs event_invitations ⨝ social_events (host's event), updates the invitation, then getUser(host_user_id) and writes an inbound_messages row into the HOST's queue to notify the host's agent. _(why hard: Guest action mutates the host's event and injects into the host's agent inbox. Shared events/invitations in main; cross-DB queue write to the host's inbound_messages via the directory.)_
- `web/agent.js:1003` **tools: request_private_sharing / revoke_private_sharing** — Resolve the target contact to a peer user (getUserByPhone) to obtain contact_user_id, then stage a pending approve_share action / call revokeSharing keyed by that foreign user id. _(why hard: Own-data operations that nonetheless must resolve and store a foreign recipient user_id. Resolve via main directory; keep pending_actions and the sharing list in the owner's per-user DB.)_
- `web/agent.js:1590` **processMessage — pendingCoordination snapshot** — Builds the agent's state by getContactByPhone(user.phone) then JOINing event_invitations ⨝ social_events ⨝ users to list events this user was invited to by OTHER hosts (host_name shown). _(why hard: Every turn reads across all hosts' events to surface the user's inbound invites. Requires shared events/invitations (main) queryable by the guest's contact_id, joined to host names from the directory.)_
- `web/agent.js:1560` **processMessage — coordinationOnly wall (channel==='agent_query')** — When answering another user's agent, suppresses soft prefs/notes so only hard constraints render — a structural boundary between the responding user's private context and the peer-facing reply. _(why hard: Not a query, but the invariant that governs what may cross the user boundary; a physical split should preserve it by never letting a peer's turn open the owner's soft-preference columns. Enforce by only ever reading the whitelisted hard-constraint columns during agent_query turns.)_
- `web/cadence.js:111` **runNudgeScan / nudgeUser / runAttendanceGate (SELECT * FROM users)** — Background loops scan EVERY completed user, then per user read cadences → relationships → contacts (nudges) or activities/attendance_confirmations (gate) and SMS them. _(why hard: Platform-wide scans over all users vanish under a per-user split. Drive from the users directory in main.sqlite and fan out per-user DB queries, or maintain a 'due work' queue table in main populated as cadences advance.)_
- `web/server.js:218` **POST /sms webhook — contact routing** — Inbound SMS resolves getContactByPhone(from), tries multiparty.handleRsvpReply, then queries recentInvitation JOINing event_invitations ⨝ social_events (host_user_id) to decide whether to route a contact's text to a HOST's coordination flow vs the sender's own agent. _(why hard: A single inbound message may belong to the sender's own agent OR to some host's event — decided by a cross-user join. Keep events/invitations in main so the webhook can classify without opening every host DB; then dispatch to the correct user's per-user DB.)_
- `web/server.js:1166` **GET /api/dashboard/overdue** — JOINs cadences ⨝ relationships and LEFT JOINs users u2 ON u2.id = r.contact_id AND r.contact_is_user=1 — i.e. a relationship's counterpart can BE another user, resolved inline for the contact_name. _(why hard: relationships.contact_id polymorphically points at either a contact (this user's DB) or another users row (global). Resolve the contact_is_user=1 case against the main directory rather than a same-DB join; contacts stay per-user.)_
- `web/server.js:1774` **POST /mcp/inbound (deps: checkConsent, notifyUser, getWindows)** — Entry point for peer-agent coordination messages: checkConsent calls getContactByAgentEndpoint(fromAgentId, toUserId) (contacts⨝consent_edges⨝users), notifyUser targets an arbitrary local user, getWindows reads a local user's availability. _(why hard: External boundary where another installation's agent triggers reads/writes on a specific local user resolved from an agent endpoint. Resolve endpoint→user in main, then confine consent + windows + session updates to that user's per-user DB (with coordination_sessions shared in main).)_
- `web/server.js:1668` **_ownerContactByUserId / GET /api/user/private-sharing / _resolveOwnedContactUser** — To render 'shared with' names, iterates the owner's contacts calling getUserByPhone on each to map peer user_ids back to contact names; approve/revoke endpoints resolve a contact to its peer user before granting. _(why hard: Reverse-maps foreign recipient user_ids (stored in sharing_approved_to) to the owner's contact names — a per-recipient cross-user resolution. Do the id→user resolution against the main directory; keep contacts and sharing lists in the owner's per-user DB.)_
- `web/server.js:886` **GET /event/:id + GET /api/events/:userId/:eventId** — Public/host event pages resolve an event and getUser(event.host_user_id) to show host name and RSVP summary to any viewer (including logged-out strangers). _(why hard: Any viewer reads a specific host's event by id. Shared events in main.sqlite plus host name from the directory makes this a single-DB read; sharding events per host would force id→host routing on every public hit.)_
- `web/admin.js:93` **POST /admin/users/merge** — Reassigns rows in ~12 owner-keyed tables (contacts, conversation_history, desires, relationships, inbound_messages, cadences-via-relationships, pending_actions, user_preferences, private_data, access_audit, user_wallets, coordination_sessions) from dropId to keepId, then deletes dropId. _(why hard: Rewrites two users' entire footprints in one transaction — impossible as a single ACID op across two physical per-user DBs. Becomes a copy-merge: move rows from dropId's DB file into keepId's DB, rewrite shared-table (main) ownership columns, then drop dropId's file; give up single-transaction atomicity for a resumable migration.)_
- `web/admin.js:148` **DELETE /admin/users/:id + userStats/GET /admin/stats** — Deletes a user across all owner-keyed tables in one transaction; userStats and /admin/stats COUNT rows per-table for one user and platform-wide across all users. _(why hard: Delete spans one user's whole footprint (per-user DB drop handles the private part, but shared main rows — agent_messages, event_invitations referencing them, coordination peers — need separate cleanup). Platform-wide stats aggregate across all users, which no per-user DB can answer; compute stats by summing over the directory or keep counters in main.)_
