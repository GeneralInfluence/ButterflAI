-- Migration 030: avoid lists, agent activity log, private-mode chat history.
-- See PRIVACY.md "Using private data: act on it, never say it".
-- NOTE: no semicolons inside comments (the runner splits on them).

-- Avoid list. Only user_id is plaintext. Who is avoided and the per-person
-- invite policy live in the encrypted payload (ct/iv/tag, sensitive.js cipher).
CREATE TABLE IF NOT EXISTS avoid_list (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  ct         TEXT NOT NULL,
  iv         TEXT NOT NULL,
  tag        TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_avoid_list_user ON avoid_list(user_id);

-- Agent activity: automatic actions the agent took for its user (owner-only,
-- reviewable). The description is encrypted because it can reveal the avoid list.
CREATE TABLE IF NOT EXISTS agent_activity (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  event_id   TEXT,
  ct         TEXT NOT NULL,
  iv         TEXT NOT NULL,
  tag        TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_activity_user ON agent_activity(user_id, created_at);

-- Invitation needs its invitee's decision before their agent responds (group
-- event with someone on the invitee's avoid list, or an "ask me" entry). Reveals
-- nothing about who. Also added in multiparty.ensureEventTables().
ALTER TABLE event_invitations ADD COLUMN needs_owner_decision INTEGER NOT NULL DEFAULT 0;

-- Private-mode chat history: text holds a placeholder, the real message is
-- encrypted here and only decrypted for its owner.
ALTER TABLE conversation_history ADD COLUMN private_ct TEXT;
ALTER TABLE conversation_history ADD COLUMN private_iv TEXT;
ALTER TABLE conversation_history ADD COLUMN private_tag TEXT;
