-- Migration 033: shared plans + quiet interest signals (Home feed).
-- Owner decisions 2026-10-08: people share plans when they want to, not when asked
-- (expiry interpreted from their wording). Asking "what're my boys up to" never pings
-- anyone — it leaves a quiet signal they see in their feed. See MEMORY.md §11.
-- NOTE: no semicolons inside comments (the runner splits on them).

-- A plan a user chose to share. Visible only to their own contacts (or one of their
-- contact groups), never to anyone on their avoid list. Hard-deleted after expiry.
CREATE TABLE IF NOT EXISTS shared_plans (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  text        TEXT NOT NULL,
  group_id    TEXT,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_shared_plans_user ON shared_plans(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_shared_plans_expiry ON shared_plans(expires_at);

-- "Sean is up for something tonight" — one row per person asked, refreshed on repeat.
CREATE TABLE IF NOT EXISTS interest_signals (
  id            TEXT PRIMARY KEY,
  from_user_id  TEXT NOT NULL,
  to_user_id    TEXT NOT NULL,
  about         TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE (from_user_id, to_user_id)
);
CREATE INDEX IF NOT EXISTS idx_interest_to ON interest_signals(to_user_id, expires_at);
