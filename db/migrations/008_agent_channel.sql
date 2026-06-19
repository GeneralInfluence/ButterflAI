-- Allow 'agent', 'agent_query', 'agent_reply' channels for agent-to-agent messages
-- SQLite doesn't support ALTER TABLE for CHECK constraints; recreate with new constraint.
CREATE TABLE inbound_messages_new (
  id           TEXT PRIMARY KEY,
  from_phone   TEXT,
  from_telegram_id TEXT,
  from_type    TEXT NOT NULL CHECK(from_type IN ('user','contact')),
  from_id      TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK(channel IN ('sms','telegram','webchat','eval','agent','agent_query','agent_reply')),
  text         TEXT,
  processed    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
INSERT INTO inbound_messages_new SELECT * FROM inbound_messages;
DROP TABLE inbound_messages;
ALTER TABLE inbound_messages_new RENAME TO inbound_messages;
