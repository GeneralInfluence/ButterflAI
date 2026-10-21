-- 🐛 #61/#63 (Sean, 2026-10-21): searches get a short name, for their pill and the dropdown
-- ("some summary of past searches … not everything in every detail").
ALTER TABLE explore_asks ADD COLUMN label TEXT;
-- 🐛 #62 ("It's asking if I'm out and about. I should also be able to say if I'm in so it stops asking me"):
-- in for the night, until the night ends.
CREATE TABLE IF NOT EXISTS staying_in (
  user_id  TEXT PRIMARY KEY,
  until    INTEGER NOT NULL
);
