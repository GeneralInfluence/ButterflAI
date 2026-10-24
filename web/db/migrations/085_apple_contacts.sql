-- 🐛 #90 (Melanie, 2026-10-23: "I wanna be able to connect my Apple contacts list through my iCloud. Where can I do
-- that?"). The iCloud login (Apple ID + app-specific password, encrypted like every connection) for contacts — kept
-- apart from calendar_tokens, which holds one calendar per person (Google or Apple).
CREATE TABLE IF NOT EXISTS apple_contacts (
  user_id      TEXT PRIMARY KEY,
  ciphertext   TEXT NOT NULL,
  iv           TEXT NOT NULL,
  tag          TEXT NOT NULL,
  wrapped_key  TEXT,
  last_sync_at INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
