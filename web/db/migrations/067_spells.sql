-- Spells - ideas ButterflAI imagines for you (owner, 2026-10-20 - "imagine what's possible … you
-- could be doing this, you could be going there … ButterflAI ends up making things happen by
-- constantly casting spells"). Built only from the person's own chats, plans and wishes plus
-- public events. Kept 7 days. Dismissed ones are remembered (titles only) so similar ones stop.
CREATE TABLE IF NOT EXISTS spells (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  why         TEXT,
  link        TEXT,
  status      TEXT NOT NULL DEFAULT 'new',
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spells_user ON spells(user_id, status);
