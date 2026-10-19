-- What each user message was understood to ask for (understand.js, 2026-10-14).
-- One row per action read from a message, with the decision code made about it and,
-- when the person undid or changed it, the correction (the eval set's labels).
-- Holds people's words, so rows are deleted after 90 days (coord-loop purge).
CREATE TABLE IF NOT EXISTS understood (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  msg_id       TEXT,
  history_id   TEXT,
  event_id     TEXT,
  kind         TEXT NOT NULL,
  quote        TEXT,
  payload_json TEXT,
  decision     TEXT NOT NULL,
  status       TEXT NOT NULL,
  ref          TEXT,
  label        TEXT,
  correction   TEXT,
  corrected_at INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_understood_history ON understood(user_id, history_id);
CREATE INDEX IF NOT EXISTS idx_understood_created ON understood(created_at);
