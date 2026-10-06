-- Migration 032: in-app delivery of agent messages between users, SMS as fallback.
-- Owner decision 2026-10-06: agents message people on their user's behalf. A message to
-- another ButterflAI user is delivered in the app (chat card + push). It is texted only
-- if the recipient could not reasonably have seen it in the app after some time.
-- NOTE: no semicolons inside comments (the runner splits on them).
CREATE TABLE IF NOT EXISTS deliveries (
  id            TEXT PRIMARY KEY,
  from_user_id  TEXT NOT NULL,
  to_user_id    TEXT NOT NULL,
  to_phone      TEXT NOT NULL,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  sms_due_at    INTEGER,
  seen_at       INTEGER,
  sms_sent_at   INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON deliveries(status, sms_due_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_to ON deliveries(to_user_id, status);

-- Chat cards for messages between users: kind is 'incoming' (from another user's
-- ButterflAI) or 'outgoing' (sent on this user's behalf), null for normal agent chat.
ALTER TABLE conversation_history ADD COLUMN kind TEXT;
