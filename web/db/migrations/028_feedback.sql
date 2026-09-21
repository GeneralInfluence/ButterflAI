-- Phase B dev-user feedback loop.
-- A tester flags an agent reply that missed their expectation. We capture enough
-- context (the message plus recent turns and the model) to reproduce it in the sim.
CREATE TABLE IF NOT EXISTS feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  rating        TEXT NOT NULL DEFAULT 'down',   -- down now, up reserved later
  agent_message TEXT,                            -- the reply the user flagged
  user_note     TEXT,                            -- optional "what I expected"
  context_json  TEXT,                            -- recent conversation turns as JSON, for repro
  model         TEXT,                            -- AGENT_MODEL at the time
  status        TEXT NOT NULL DEFAULT 'new',     -- new, triaged, or fixed
  created_at    INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback (status, created_at);
