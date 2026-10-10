-- Reflection (owner, 2026-10-09): once a conversation where the agent acted for its user
-- goes quiet, the agent reviews it — did it misread them, drop a question, overstate
-- something? — and if fairly sure, asks a gentle follow-up in the app. One row per review.
-- details (what it noticed) is kept only for opted-in test users (admin review).
CREATE TABLE IF NOT EXISTS reflections (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end   INTEGER NOT NULL,
  outcome      TEXT NOT NULL,
  confidence   REAL,
  followup     TEXT,
  details      TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_reflections_user ON reflections (user_id, window_end);
