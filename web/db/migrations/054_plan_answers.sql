-- Answers from friends' ButterflAIs land on the plan (owner, 2026-10-13: "maximize fun
-- while minimizing communication between people"). When an agent answers a question about
-- a plan, the answer is kept here for the agent that asked, so it is read from the plan
-- instead of asked again. Only what the answering agent chose to send — never more.
CREATE TABLE IF NOT EXISTS plan_answers (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL,
  asker_user_id    TEXT NOT NULL,
  answerer_user_id TEXT NOT NULL,
  topic            TEXT,
  question         TEXT,
  answer           TEXT NOT NULL,
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_plan_answers_event ON plan_answers (event_id, asker_user_id);
