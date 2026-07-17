#!/usr/bin/env bash
#
# guardian-check.sh — the Guardian's heartbeat verification (see docs/REARCHITECTURE.md §2.4).
#
# The OpenClaw agent runs this every heartbeat. It verifies the privacy + coordination
# invariants hold, from OUTSIDE the plaintext boundary — it reads test results, static
# structure, and (optionally) DB metadata, never decrypted private data. Exit code 0 =
# all good; non-zero = the agent should alert the owner with the failing section.
#
# Usage:
#   bash scripts/guardian-check.sh
#   GUARDIAN_DB=/data/butterflai.sqlite bash scripts/guardian-check.sh   # + live-DB checks
#
set -uo pipefail

# Resolve repo root (this script lives in <repo>/scripts).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILED=0
section() { printf '\n=== %s ===\n' "$1"; }
pass()    { printf '  PASS  %s\n' "$1"; }
fail()    { printf '  FAIL  %s\n' "$1"; FAILED=1; }

# ── 1. Guardrail test suite (privacy + coordination + fail-closed) ──────────────
# Run under TZ=UTC (CI-equivalent) + in-memory DB. These encode the invariants; a red
# here means an invariant regressed.
section "Guardrail tests"
GUARDRAIL_TESTS=(
  web/tests/privacy.test.js
  web/tests/coordination.test.js
  web/tests/unit/agent-query-privacy.test.js
  web/tests/unit/coord-purge.test.js
  web/tests/unit/fail-closed.test.js
  web/tests/unit/sensitive-store-encrypted.test.js
)
if [ -d web/node_modules ]; then
  if TZ=UTC DB_PATH=:memory: JWT_SECRET=guardian-check NODE_ENV=test \
       node --test "${GUARDRAIL_TESTS[@]}" >/tmp/guardian-tests.log 2>&1; then
    pass "$(grep -c '^ok ' /tmp/guardian-tests.log 2>/dev/null || echo '?') assertions green"
  else
    fail "guardrail tests red — see /tmp/guardian-tests.log"
    grep -E '^not ok' /tmp/guardian-tests.log | head -10
  fi
else
  fail "web/node_modules missing — run 'cd web && npm ci' before the Guardian can verify"
fi

# ── 2. Structural drift checks (static, no DB) ─────────────────────────────────
section "Structural invariants"

# The schema symlink must resolve (regression guard: it was once an absolute sandbox path).
if [ -e web/db/schema.sql ]; then pass "web/db/schema.sql resolves"; else fail "web/db/schema.sql is a broken symlink"; fi

# The privacy constitution must exist.
if [ -f PRIVACY.md ]; then pass "PRIVACY.md present"; else fail "PRIVACY.md missing"; fi

# Invariant 1 drift: a migration must not add a sensitive-sounding column to user_preferences
# (sensitive data belongs in user_private_data). Heuristic — flag for human review, don't hard-fail.
SUSPECT=$(grep -rilE 'ALTER TABLE user_preferences' db/migrations web/db/migrations 2>/dev/null \
          | xargs grep -ilE 'health|sti|sexual|medic|therap|financ|legal|arrest|mental' 2>/dev/null || true)
if [ -n "$SUSPECT" ]; then
  printf '  WARN  possible sensitive column added to user_preferences (review Invariant 1): %s\n' "$SUSPECT"
else
  pass "no sensitive column added to user_preferences"
fi

# ── 3. Live-DB checks (optional; only if GUARDIAN_DB points at a real sqlite) ───
# Never reads private-data plaintext — only retention + audit metadata.
if [ -n "${GUARDIAN_DB:-}" ] && [ -f "$GUARDIAN_DB" ] && [ -d web/node_modules ]; then
  section "Live DB retention + audit (GUARDIAN_DB=$GUARDIAN_DB)"
  GUARDIAN_DB="$GUARDIAN_DB" node - <<'NODE' 2>/tmp/guardian-db.err
    const path = require('path');
    let Database;
    try { Database = require(path.join(process.cwd(), 'web', 'node_modules', 'better-sqlite3')); }
    catch (e) { console.error('  FAIL  cannot load better-sqlite3:', e.message); process.exit(3); }
    const db = new Database(process.env.GUARDIAN_DB, { readonly: true, fileMustExist: true });
    let bad = 0;
    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    // Non-retention: nothing should sit past its purge_after (the tick should have deleted it).
    if (has('coordination_sessions')) {
      const n = db.prepare("SELECT count(*) c FROM coordination_sessions WHERE datetime(purge_after) < datetime('now')").get().c;
      if (n > 0) { console.log(`  FAIL  ${n} coordination_sessions past purge_after (purge not running?)`); bad = 1; }
      else console.log('  PASS  no coordination_sessions past purge_after');
    }
    // Audit anomaly: any break-glass / cross-user access in the last 24h is worth a human look.
    if (has('private_data_access_log')) {
      const n = db.prepare("SELECT count(*) c FROM private_data_access_log WHERE accessor_id IS NOT NULL AND created_at > strftime('%s','now')-86400").get().c;
      if (n > 0) console.log(`  WARN  ${n} cross-user/break-glass private-data accesses in last 24h — review`);
      else console.log('  PASS  no cross-user private-data access in last 24h');
    }
    process.exit(bad);
NODE
  [ $? -ne 0 ] && { FAILED=1; cat /tmp/guardian-db.err 2>/dev/null; }
else
  section "Live DB checks"
  printf '  SKIP  set GUARDIAN_DB=/path/to/butterflai.sqlite to enable retention + audit checks\n'
fi

# ── Verdict ────────────────────────────────────────────────────────────────────
section "Guardian verdict"
if [ "$FAILED" -eq 0 ]; then
  echo "  ALL CLEAR — invariants hold."
  exit 0
else
  echo "  ATTENTION NEEDED — alert the owner with the FAIL lines above."
  exit 1
fi
