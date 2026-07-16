-- Migration 026: user_private_data — encrypted sensitive data store
-- Separate from user_preferences (plaintext). AES-256-GCM per record.
-- Access is audited. Never readable cross-user. See PRIVACY.md Invariant 1 + 2.
CREATE TABLE IF NOT EXISTS user_private_data (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  category     TEXT NOT NULL,  -- HEALTH | SEXUAL | FINANCIAL | LEGAL | MENTAL_HEALTH | RELATIONSHIP | OTHER
  data_key     TEXT NOT NULL,  -- namespaced key e.g. "health.sti_status"
  encrypted_v  TEXT NOT NULL,  -- AES-256-GCM ciphertext (base64)
  iv           TEXT NOT NULL,  -- GCM IV (base64)
  auth_tag     TEXT NOT NULL,  -- GCM auth tag (base64)
  sharing_approved_to TEXT DEFAULT '[]', -- JSON array of user_ids approved to receive this field
  created_at   INTEGER DEFAULT (strftime('%s','now')),
  updated_at   INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_private_data_user ON user_private_data(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_private_data_key ON user_private_data(user_id, data_key);

-- Access audit log for private data reads
CREATE TABLE IF NOT EXISTS private_data_access_log (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,  -- whose data was accessed
  accessor_id  TEXT,           -- who accessed it (null = own user)
  data_key     TEXT NOT NULL,
  action       TEXT NOT NULL,  -- 'read' | 'write' | 'share' | 'delete'
  context      TEXT,           -- brief description of why
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_access_log_user ON private_data_access_log(user_id, created_at);
