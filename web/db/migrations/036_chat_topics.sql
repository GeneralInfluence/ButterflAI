-- Chat filtered by discussion (owner, 2026-10-09): each chat message can belong to the
-- event it was about, so the user can read one plan's discussion without side things.
ALTER TABLE conversation_history ADD COLUMN event_id TEXT;
CREATE INDEX IF NOT EXISTS idx_conv_user_event ON conversation_history (user_id, event_id);
-- Older messages are sorted into a discussion once, the first time it is opened.
CREATE TABLE IF NOT EXISTS chat_topic_backfill (
  user_id  TEXT NOT NULL,
  event_id TEXT NOT NULL,
  done_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, event_id)
);
