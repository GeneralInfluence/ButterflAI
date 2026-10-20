-- 🐛 #38 (Sean, 2026-10-20): "I might be going for a hike … skiing … having a beer at a park … I need
-- to be able to add categories and the butterfly needs to consolidate those categories so overlap is
-- found". The activities each person has added themselves, offered again next time.
CREATE TABLE IF NOT EXISTS out_activity_choices (
  user_id  TEXT NOT NULL,
  label    TEXT NOT NULL,
  used_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, label)
);
