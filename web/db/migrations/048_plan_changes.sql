-- Every change to a plan, from any path (owner, 2026-10-12: "operate on single objects").
-- Written only by planops.js. via = agent | app | system.
CREATE TABLE IF NOT EXISTS plan_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL,
  actor_id   TEXT,
  via        TEXT NOT NULL,
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_plan_changes_event ON plan_changes (event_id, created_at);
