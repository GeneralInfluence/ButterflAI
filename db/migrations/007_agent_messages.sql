-- Agent-to-agent message channel.
-- Agents send queries/replies to each other asynchronously.
-- Privacy rule: only hard constraints, availability, and logistics cross this wire.
-- Soft preferences, exclusion reasons, and private notes NEVER cross.
CREATE TABLE IF NOT EXISTS agent_messages (
  id          TEXT PRIMARY KEY,
  from_user   TEXT NOT NULL REFERENCES users(id),
  to_user     TEXT NOT NULL REFERENCES users(id),
  thread_id   TEXT NOT NULL,              -- groups a request + reply
  kind        TEXT NOT NULL,              -- 'query' | 'reply'
  topic       TEXT NOT NULL,             -- 'availability' | 'constraints' | 'rsvp' | 'coordination'
  body        TEXT NOT NULL,             -- the message text
  processed   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS agent_messages_to_unprocessed
  ON agent_messages(to_user, processed, created_at);
