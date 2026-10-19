-- Whether each outside connection still works (owner, 2026-10-19 - "I want to be told when the
-- grants or any other types of connections expire so they can be fixed or reconnected").
-- Sean's Google grant died on Oct 16 (7-day limit while the Google app is in testing) and
-- nothing noticed for three days. key is google or apple.
CREATE TABLE IF NOT EXISTS connection_health (
  user_id     TEXT NOT NULL,
  key         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ok',
  error       TEXT,
  broken_at   INTEGER,
  notified_at INTEGER,
  checked_at  INTEGER,
  PRIMARY KEY (user_id, key)
);
