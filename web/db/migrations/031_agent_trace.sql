-- Migration 031: agent trace for test users (Phase B feedback loop).
-- One row per event in an agent turn: the incoming message, each tool call with its
-- (redacted) input and result, and the reply or error. Only for users who opted in as
-- test users. Purged after 30 days (trace.js purgeOld, run by the coord purge tick).
-- NOTE: no semicolons inside comments (the runner splits on them).
CREATE TABLE IF NOT EXISTS agent_trace (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  turn_id     TEXT,
  channel     TEXT,
  kind        TEXT NOT NULL,
  tool_name   TEXT,
  input_json  TEXT,
  result_json TEXT,
  text        TEXT,
  duration_ms INTEGER,
  model       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_trace_user ON agent_trace(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_trace_created ON agent_trace(created_at);
