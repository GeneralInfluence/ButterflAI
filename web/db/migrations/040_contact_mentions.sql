-- What the user called someone, and in what context (owner, 2026-10-09: "Al" for Allie
-- around Grover and the Favorite Mama's — and someday a different Al from work). One row
-- each time the user acts on a contact. Owner-only, like the contacts themselves.
-- context = lowercase words from the plan / activity / place / group it was about.
CREATE TABLE IF NOT EXISTS contact_mentions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  name_used  TEXT,
  event_id   TEXT,
  group_id   TEXT,
  context    TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_mentions_user_contact ON contact_mentions (user_id, contact_id, created_at);
