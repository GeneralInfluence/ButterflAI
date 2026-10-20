-- I'm out now - who's near you and up for something (owner, 2026-10-20 - Tahoe: "there's a few
-- potential connections around. You could reach out to somebody and just have a drink or have a
-- coffee"). One row per person while they're out. Location rounded to about 1 km and deleted when
-- the outing ends. Nobody ever sees it, only a rough distance.
CREATE TABLE IF NOT EXISTS out_now (
  user_id     TEXT PRIMARY KEY,
  up_for      TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  open_to_new INTEGER NOT NULL DEFAULT 0,
  until       INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
-- "Say hi" to a friend nearby, or "I'm interested" in someone nearby. A stranger only hears about
-- it if they are interested in you too. Names are shared only when both said yes.
CREATE TABLE IF NOT EXISTS out_requests (
  id         TEXT PRIMARY KEY,
  from_user  TEXT NOT NULL,
  to_user    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  activity   TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  event_id   TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE (from_user, to_user)
);
