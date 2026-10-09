-- Keep Google contacts in sync (owner, 2026-10-09: "Alex is already in my contacts").
-- The first import used a one-time grant and kept nothing, so contacts added after it
-- were never seen. The Google grant is stored encrypted (crypto.js, like calendar_tokens)
-- and contacts re-sync daily and when a lookup finds no match.
CREATE TABLE IF NOT EXISTS contact_sync_tokens (
  user_id      TEXT PRIMARY KEY,
  provider     TEXT NOT NULL DEFAULT 'google',
  ciphertext   TEXT NOT NULL,
  iv           TEXT NOT NULL,
  tag          TEXT NOT NULL,
  wrapped_key  TEXT NOT NULL,
  last_sync_at INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
