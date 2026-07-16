-- 019: Allow 'system' role in conversation_history for agent/system notifications.
-- SQLite does not support ALTER TABLE … ALTER COLUMN, so we recreate the table.
CREATE TABLE IF NOT EXISTS conversation_history_new (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    role       TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    text       TEXT NOT NULL
);
INSERT OR IGNORE INTO conversation_history_new SELECT id, user_id, created_at, role, text FROM conversation_history;
DROP TABLE conversation_history;
ALTER TABLE conversation_history_new RENAME TO conversation_history;
CREATE INDEX IF NOT EXISTS idx_conversation_history_user ON conversation_history(user_id, created_at DESC);
