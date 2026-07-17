# REARCHITECTURE.md — Coordination & Privacy

> **Status:** Design, pending owner approval. Not yet built.
> **Author:** Claude Code session 2026-07-17, at owner request.
> **Decisions locked by owner 2026-07-17:** privacy target = **confidential compute / TEE**; coordination target = **federated agents + enforced protocol**; reasoning model = **Anthropic, in the trust set, under zero-retention terms, disclosed publicly** (Option A+B, §3); infra = **AWS/GCP for the enclave**; the **OpenClaw agent is the system Guardian** (heartbeat that runs tests, verifies invariants, watches for anomalies — §2.4); process = **design first, then build**.
> **Reader:** whoever builds this next (Claude Code or the OpenClaw agent). Companion docs: `PRIVACY.md` (invariants), `.claude/COORDINATION_PLAN.md` (the existing protocol), `MEMORY.md` (project state), `IMPLEMENTATION.md` (build spec).

---

## 0. The one idea

The hard *structural* work is already built. The rearchitecture is not a rewrite — it adds the **trust boundary** that makes existing guarantees hold, and it uses **one mechanism (enclave attestation) to satisfy both owner choices at once**:

> The same attestation that proves *"the operator cannot read your data"* also makes *"the other agent cannot retain your data"* **enforceable** — a peer agent releases data only after the requester **proves, by attestation, that it is running the audited code that purges.**

Privacy and coordination were always the same problem (both hinge on "who can read the plaintext, and can you verify it"). Attestation is the shared answer.

---

## 1. What exists today (honest baseline)

### Already built and good — becomes the *inside* of the new boundary
- **Typed coordination protocol** `butterflai-coord/1.0`: 3-round negotiation state machine (`coordination.js`), enum/typed-only payloads with a free-text-rejecting validator (`mcp-messages.js` `validateOutbound`/`assertNoFreeText`).
- **Structural raw-text exclusion**: the `coord_desires` SQL **view** (`003_coordination.sql:30-35`) means the coordination layer *cannot* select `raw_text`. This is real "structural not instructional" isolation.
- **Privacy constitution**: `PRIVACY.md`, 7 invariants, each with a test in `web/tests/privacy.test.js`. HTTP-layer authz (Invariant 4) does not depend on the LLM.
- **Separate encrypted private store** with per-category cross-agent sharing consent (`sensitive.js` `readPrivateDataForSharing`) and an access audit log.
- **A real HTTP transport with attestation-shaped hooks**: `mcp-transport.js` already does signed `POST /mcp/inbound`.

### The gaps between here and the owner's targets
| # | Reality today | File evidence | Why it blocks the target |
|---|---|---|---|
| G1 | **Two a2a subsystems; the deployed one is the unsafe one.** `message_agent`/`reply_agent` send raw LLM free-text into `agent_messages.body` (≤2000 chars), no scrubber, persisted forever. | `agent.js:848-885`, `db.js:611-618` | Federated non-retention is impossible while the live path is unstructured free text. |
| G2 | **The safe typed protocol is inert.** Never fires cross-user: needs distinct `agent_endpoint`s (single deployment has none) and responder resolution is an env stub. | `coord-loop.js:99-107`, `coordination.js:696-700` | No real inter-agent boundary exists yet. |
| G3 | **Non-retention is aspirational.** `purge_after` is computed and stored but **no job deletes on it**. Peer data sits in `coord_session_peers`, `ambient_signals`, `agent_messages` indefinitely. | `coordination.js:81-83`, `003_coordination.sql:56-87` (no deleter anywhere) | The core Tier-2 promise is unenforced. |
| G4 | **Operator can read everything.** Two stores, both operator-decryptable: `crypto.js` (KMS master key = `KMS_MASTER_KEY_HEX` env, `KMS_PROVIDER=local` in prod) and `sensitive.js` (key = `sha256(ENCRYPTION_KEY‖JWT_SECRET‖'dev-insecure-key')`). | `crypto.js:29,62-71`, `sensitive.js:18-22`, `fly.toml` | This is "we hold the keys" — one rung below the TEE target. |
| G5 | **Plaintext already reaches Anthropic.** `get_private_preferences` returns the decrypted object into the prompt. | `agent.js:751-753 → 1746-1747` | Anthropic is silently in the trust set; the target must make this a *decided, disclosed* fact. |
| G6 | **No agent identity.** Single shared `MCP_SHARED_SECRET` HMAC, accepts everything if unset; `peer_agent_id` is just an endpoint URL, not a key. | `mcp-transport.js:21,48,59-62` | Federation requires verifiable per-agent identity. |
| G7 | **Logical isolation only** — one shared `butterflai.sqlite`, `WHERE user_id=?`. Per-user DB split (PLAN item 8) not done. | `db.js:21`, `COORDINATION_PLAN.md:113` | A logic bug crosses users; no per-user delete/export. |

---

## 2. Target architecture

Split the system into three roles — a byte-routing **Gateway**, a plaintext-only **Enclave**, and a supervising **Guardian**:

```
  UNTRUSTED GATEWAY (stays on Fly)                 TRUSTED ENCLAVE (new; AWS Nitro or GCP Confidential Space)
  ───────────────────────────────                 ────────────────────────────────────────────────────────
  • Twilio SMS in/out                              • holds NO long-term secret at rest
  • web app + static UI                            • on attestation, KMS releases the data key → here only
  • ciphertext storage (SQLite/Postgres)           • decrypts user_private_data IN enclave memory
  • coordination transport (routing bytes)         • runs the agent's private-data reasoning
  • sees only ciphertext + typed protocol msgs     • calls Anthropic (zero-retention) for reasoning (§3)
                                                   • emits only: SMS text to send, typed protocol payloads
        │  vsock / attested channel  ▲             • zeroes plaintext + session state at end of turn
        └────────────────────────────┘

  GUARDIAN — the OpenClaw agent (untrusted side; never holds the enclave key)
  ────────────────────────────────────────────────────────────────────────
  • runs the privacy + coordination test suites on its heartbeat, alerts on red
  • verifies the purge job actually deleted (rows past purge_after must be zero)
  • watches the access audit log for anomalies (break-glass, unexpected accessor, cross-user reads)
  • verifies every enclave is attesting the known-good image measurement
  • flags invariant drift (new user_preferences columns, new routes missing authz)
  • keeps docs (MEMORY.md, PRIVACY.md, REARCHITECTURE.md) current
```

The Gateway handles everything that doesn't touch plaintext private data. Anything that decrypts happens in the Enclave. The operator has root on the Gateway and **still cannot read** private data, because the KMS key policy releases the data key only against a matching enclave attestation. The Guardian supervises the whole thing from outside the boundary — see §2.4.

### 2.1 Privacy = confidential compute (owner choice)
- **Key release gated by attestation.** Replace `KMS_PROVIDER=local` with `KMS_PROVIDER=nitro` (or GCP CS). Master key lives in AWS KMS with a key policy requiring `kms:RecipientAttestation:ImageSha384` = the audited enclave image measurement. Only that exact image can `Decrypt`. Operator cannot forge the attestation.
- **Decrypt only inside the enclave.** `crypto.js`/`sensitive.js` decrypt paths move into the enclave process. The orchestrator never holds a key that opens `user_private_data`.
- **Honest public claim becomes true:** "ButterflAI's operators cannot read your private data." Revocation stops being purely trust-based for the enclave-protected class.
- **Unify the two stores** (G4): one encrypted private-data store, one envelope format, one code path. Kill `'dev-insecure-key'` and the `JWT_SECRET` fallback (fail closed).

### 2.2 Coordination = federated + enforced (owner choice)
- **Converge on the typed protocol; retire the free-text path (G1).** `message_agent`/`reply_agent`'s raw-text relay is incompatible with non-retention. Either (a) route all a2a through `coordination.js`'s typed schema, or (b) as an interim, force `message_agent` through `validateOutbound` + `scrubForAgentMessage` and give its rows a `purge_after`. Recommend (a).
- **Real per-agent identity (G6).** Each agent gets an Ed25519 keypair; public key = agent identity, anchorable to the user's wallet/Base address (this is the retained "wallet = identity" role, and the path to ERC-8004). Every protocol message is signed; verify on receipt. Replace the shared HMAC; **fail closed** when identity is absent.
- **Attestation handshake before data release (the spine).** Peer B releases availability/hard-constraints to requester A only after A presents an attestation document matching a known-good ButterflAI enclave measurement. B's release policy is enforced *in the enclave*, not the prompt. This is what finally answers Open Q1: B doesn't *trust* A to purge — B *verifies* A runs code that purges.
- **Make purge real (G3).** (i) Coordination working state (`coord_session_peers`, matched windows) lives in **ephemeral enclave memory**, zeroed at session end — not durable disk. (ii) For anything that must hit disk, add the missing executor: a job that deletes every row past `purge_after`. Non-retention becomes a running deleter, not a stored timestamp.
- **Per-user physical isolation (G7).** Execute PLAN item 8: `main.sqlite` (identity/routing) + `users/{user_id}.sqlite` (desires, sessions, private data, contacts, history). GDPR erasure = delete the file. This also cleanly maps to eventual one-enclave-per-user.

### 2.4 The Guardian = the OpenClaw agent (owner choice)
The OpenClaw agent is not being retired — it becomes the system's **Guardian**, using its existing heartbeat/cron mechanism (`workspace/HEARTBEAT.md`) to continuously prove the boundary holds. It lives on the **untrusted side** and, once Phase 2 lands, **cannot obtain the enclave key**, so it supervises without being able to read plaintext. That is the point: a living verifier whose own access proves nothing is leaking. Its heartbeat duties:
- Run `web/tests/privacy.test.js` + coordination tests every cycle; page the owner on any red.
- Assert the purge executor did its job: `SELECT count(*) WHERE purge_after < now()` must be 0.
- Scan the access audit log for anomalies (break-glass access, unexpected accessor id, any cross-user read).
- Verify every running enclave reports the known-good image measurement (attestation drift = alert).
- Static-check invariant drift: new migrations touching `user_preferences` (Invariant 1), new routes missing the `req.user.id === target` check (Invariant 4).
- Keep the docs current (this file, `MEMORY.md`, `PRIVACY.md`) as phases land.

**Honest caveat:** before Phase 2, keys are env vars, so the Guardian (like any operator process) *could* decrypt. The "Guardian cannot read plaintext" guarantee becomes real only once key release is attestation-gated. State it that way until then.

### 2.5 The federation staging (single operator → true federation)
v1 runs all enclaves under one operator but with **real boundaries in code** (signed identity, attested release, ephemeral session memory), so the guarantee is "auditable code + attestation" today and strengthens to "different operators / self-hosted agents" later without a rewrite. The protocol and identity model are the same at every stage; only *where the enclaves run* changes.

---

## 3. Reasoning model & trust set — DECIDED (owner-locked 2026-07-17)

**Decision: Option A+B. The Enclave calls the Anthropic API (Claude) for reasoning; Anthropic is a named member of the trust set, operating under zero-retention terms, and this is disclosed publicly. The Enclave minimizes what plaintext it sends — derived facts, not raw private notes. Self-hosting the model in-enclave (Option C) is the north star, not v1.**

| Option | Trust set | Honest claim | Status |
|---|---|---|---|
| **A. Anthropic in TCB, disclosed + zero-retention** | {hardware vendor, Anthropic} | "Our operators can't read it; it's processed transiently by Anthropic under zero-retention terms." | **CHOSEN (v1)** |
| **B. A + plaintext minimization** | same, but Anthropic sees less | same claim, smaller exposure | **CHOSEN (v1, combined with A)** |
| **C. Self-host the model in the enclave** | {hardware vendor} only | "No third party ever sees your data." | North star, later |

**What this obligates:**
- The public privacy statement names Anthropic explicitly (e.g. "processed transiently by Anthropic under zero-retention terms; ButterflAI's own operators cannot read it"). Never claim "no one can read it" in v1.
- Confirm/keep a zero-retention + no-training posture on the Anthropic account used by the enclave.
- The Enclave's prompt-assembly step sends the model only the minimized facts a task needs, never the raw `user_private_data` blob (extends the existing `coord_desires`-view discipline into the reasoning path).

---

## 4. Build order

**Phase 0 — hardening that needs no TEE (do first; independently valuable):**
1. Make `purge_after` actually delete (G3). Add the executor + a test that a purged session leaves no peer rows.
2. Close the deployed free-text leak (G1): route `message_agent` through `validateOutbound`+`scrubForAgentMessage`, or converge to the typed protocol.
3. Fail closed on missing `MCP_SHARED_SECRET` and `ENCRYPTION_KEY`; delete insecure fallbacks (G4/G6).
4. Unify the two private-data stores into one path (G4).
5. Stand up the **Guardian heartbeat** (§2.4): add the privacy/coordination test run, the purge-verification query, and the audit-log anomaly scan to `workspace/HEARTBEAT.md` so the OpenClaw agent runs them every cycle. This makes the hardening self-monitoring from day one.

**Phase 1 — identity & isolation:**
5. Per-user SQLite split (G7, PLAN item 8).
6. Ed25519 per-agent keypairs; sign/verify every protocol message; retire shared HMAC (G6).

**Phase 2 — confidential compute:**
7. Carve out the "sensitive reasoning core" as an enclave binary (decrypt + reason + emit). Orchestrator ↔ enclave over vsock.
8. `KMS_PROVIDER=nitro`: attestation-gated key release. Operator can no longer decrypt.
9. Ephemeral in-enclave coordination session memory.

**Phase 3 — enforced federation:**
10. Attestation handshake before cross-agent data release (the spine).
11. Distinct per-agent endpoints; activate Subsystem B cross-user for real (fixes G2).
12. North-star: split operators / self-hosted enclaves.

Each phase leaves the app deployable. Phase 0 alone closes the worst live gaps.

---

## 5. Honest limits (state these publicly, as PRIVACY.md already does for the old model)
- TEE converts "trust the operator" into "trust the hardware vendor (AWS/Intel/AMD) + the attested code." Enclave side-channels exist; this is a strong mitigation, not a mathematical guarantee.
- Under Option A/B, Anthropic is in the trust set. That must be disclosed plainly — never claim "no one can read it" while shipping plaintext to a model provider.
- v1 federation runs under one operator; the boundary is real in code and attestation, but true multi-operator federation is later.
- The enclave protects the *private-data* class. Operational data (names, cadence, general prefs) stays operator-readable by design so coordination works — same split PRIVACY.md already draws.

---

## 6. What is explicitly preserved
- All 7 `PRIVACY.md` invariants and their tests — the enclave makes them *stronger*, never weaker.
- The `MEMORY.md` "Agent Architecture Vision" (agents talk first, human last; hard constraints cross, soft prefs stay scoped; exclusion reasons never cross the wire).
- The typed `butterflai-coord/1.0` schema, the `coord_desires` view, the additive-only migration rule.
- Wallet = identity + future social budget only (now also the anchor for agent keypair identity). Not a privacy mechanism.

---
*Update this file as phases land. Move items from "target" to "built" with the commit that did it.*
