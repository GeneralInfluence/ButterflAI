-- Google Calendar mirrors the ButterflAI calendar (owner, 2026-10-13: "a person's google
-- calendar should reflect their ButterflAI calendar"). One row per person per plan:
-- entries = the Google event ids made for it ([{key, gid}] — one for a set date, one per
-- proposed date option), hash = what they were last written from. dirty = needs syncing
-- (set by the calendar ripple, flushed right away and retried from the coord loop).
CREATE TABLE IF NOT EXISTS calendar_mirror (
  user_id    TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  entries    TEXT,
  hash       TEXT,
  dirty      INTEGER NOT NULL DEFAULT 1,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_mirror_dirty ON calendar_mirror (dirty);
-- On by default. Settings → Connections turns it off (and removes the entries).
ALTER TABLE users ADD COLUMN gcal_mirror INTEGER NOT NULL DEFAULT 1;
