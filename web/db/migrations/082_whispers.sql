-- 💌 Whispers (owner, 2026-10-21, after Allie: "The agents are supposed to be able to speak to each other
-- anonymously. And say that something's generally happening or there's a general rumor."): a message to a
-- friend without the sender's name. Only between people who saved each other, checked to be kind, on unless
-- the receiver turns them off. ButterflAI keeps who sent each one (for abuse), the receiver never sees it.
CREATE TABLE IF NOT EXISTS whispers (
  id          TEXT PRIMARY KEY,
  from_user   TEXT NOT NULL,
  to_user     TEXT NOT NULL,
  text        TEXT NOT NULL,
  reply_to    TEXT,
  status      TEXT NOT NULL DEFAULT 'sent',
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_whispers_to ON whispers(to_user, created_at);
CREATE INDEX IF NOT EXISTS idx_whispers_from ON whispers(from_user, created_at);
CREATE TABLE IF NOT EXISTS whisper_settings (
  user_id  TEXT PRIMARY KEY,
  off      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS whisper_mutes (
  user_id    TEXT NOT NULL,
  muted_from TEXT NOT NULL,
  PRIMARY KEY (user_id, muted_from)
);
