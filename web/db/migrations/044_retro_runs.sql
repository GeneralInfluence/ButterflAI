-- Retroactive application of behavior changes (owner, 2026-10-10: "when we make updates
-- to this app, we need to be retrospective about its applications, in perpetuity").
-- One row per (retro task, user) once it has run. See web/retro.js.
CREATE TABLE IF NOT EXISTS retro_runs (
  task_id  TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  outcome  TEXT NOT NULL,
  done_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (task_id, user_id)
);
