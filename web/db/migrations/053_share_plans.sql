-- A share ("Free tonight", "At Sully's from 9 this weekend") can become a plan (event-map
-- #5, 2026-10-13) — by the person who shared it, or by a friend who wants in. One plan per
-- person per share. Kept so the same tap opens the same plan, and the share can show it.
CREATE TABLE IF NOT EXISTS share_plans (
  share_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (share_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_share_plans_event ON share_plans (event_id);
