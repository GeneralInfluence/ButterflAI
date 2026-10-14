-- Ripples (owner, 2026-10-13: "every change to an event should cascade through the entire
-- system"). Every change to a plan is recorded here in the same transaction as the change;
-- the reactions in web/ripples/ run from it (and are retried from the coord loop if one
-- fails). batch groups the changes made by one operation (a date and place set together
-- send one FYI, not two). results: what each reaction did, by name.
CREATE TABLE IF NOT EXISTS plan_ripples (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  batch      TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  type       TEXT NOT NULL,
  actor_id   TEXT,
  via        TEXT,
  data       TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  done_at    INTEGER,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  results    TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_ripples_batch ON plan_ripples (batch);
CREATE INDEX IF NOT EXISTS idx_plan_ripples_pending ON plan_ripples (done_at);
CREATE INDEX IF NOT EXISTS idx_plan_ripples_event ON plan_ripples (event_id);
