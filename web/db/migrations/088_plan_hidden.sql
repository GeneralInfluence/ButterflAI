-- Sean, 2026-10-24: "I cannot remove past events. I want to be able to swipe left to throw an event away."
-- A past plan removed from your lists is hidden for you only, and stays for everyone else.
CREATE TABLE IF NOT EXISTS plan_hidden (
  event_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (event_id, user_id)
);
