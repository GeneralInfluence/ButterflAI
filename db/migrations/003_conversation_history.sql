-- Conversation history for agent context
-- Stores both user messages and agent replies so the agent can maintain context
-- across multiple SMS turns.
CREATE TABLE IF NOT EXISTS conversation_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_conversation_history_user
    ON conversation_history(user_id, created_at DESC);
