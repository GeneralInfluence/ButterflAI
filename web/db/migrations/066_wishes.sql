-- Wishes - things you'd love to happen, matched between agents (owner, 2026-10-20 - "trying to
-- cast a spell into the world … to bring the world together"). A wish has no date or guest
-- list. open_to_new = it may be matched with people near you who aren't in your circle (both
-- anonymous until both opt in). Wishes end after 60 days and are deleted when removed.
CREATE TABLE IF NOT EXISTS wishes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  text        TEXT NOT NULL,
  open_to_new INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'active',
  event_id    TEXT,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wishes_user ON wishes(user_id, status);
-- Two wishes the matcher found are the same wish. kind friend means they have each other saved,
-- names shown. kind nearby means not connected, anonymous until both say yes.
CREATE TABLE IF NOT EXISTS wish_matches (
  id         TEXT PRIMARY KEY,
  wish_a     TEXT NOT NULL,
  wish_b     TEXT NOT NULL,
  user_a     TEXT NOT NULL,
  user_b     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  together   TEXT NOT NULL,
  a_answer   TEXT,
  b_answer   TEXT,
  status     TEXT NOT NULL DEFAULT 'open',
  event_id   TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE (wish_a, wish_b)
);
-- Pairs of wishes already compared, so the matcher doesn't ask twice.
CREATE TABLE IF NOT EXISTS wish_checked (
  wish_a     TEXT NOT NULL,
  wish_b     TEXT NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (wish_a, wish_b)
);
