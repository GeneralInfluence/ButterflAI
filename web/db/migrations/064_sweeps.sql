-- The daily consistency sweep (sweep.js, 2026-10-20 - Sean: "these sweeps through things
-- to make sure everything is consistent and in order isn't properly implemented yet").
-- One row per check per run that found something, with what it did.
CREATE TABLE IF NOT EXISTS sweep_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  check_name TEXT NOT NULL,
  fixed      INTEGER NOT NULL DEFAULT 0,
  detail     TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_sweep_log_created ON sweep_log(created_at);
