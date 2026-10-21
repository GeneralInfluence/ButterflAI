-- 🐛 #81 (Sean: "I'd like to be able to just heart something or do an emoji reaction"): a reaction on a chat
-- message reaches the person it's about (an incoming message's sender, a friend's yes) — in the app only.
ALTER TABLE conversation_history ADD COLUMN about_user_id TEXT;
ALTER TABLE conversation_history ADD COLUMN about_what TEXT;
ALTER TABLE inbound_messages ADD COLUMN about_user_id TEXT;
ALTER TABLE inbound_messages ADD COLUMN about_what TEXT;
CREATE TABLE IF NOT EXISTS message_reactions (
  history_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  sent_at    INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (history_id, user_id)
);
