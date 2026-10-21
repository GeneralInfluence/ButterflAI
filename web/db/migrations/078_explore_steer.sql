-- 🐛 #46: an idea's street address when the search found one (what the map looks up best).
-- 🐛 #50 (Sean, 2026-10-20: "I need to … give feedback about what I'm seeing or do a search for what I'm
-- looking for in my feed. It can't just be that I'm scrolling forever based on what you said"): what the
-- person asked Explore for, and which batch of ideas answered it.
ALTER TABLE spells ADD COLUMN address TEXT;
ALTER TABLE spells ADD COLUMN asked TEXT;
CREATE TABLE IF NOT EXISTS explore_asks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_explore_asks_user ON explore_asks(user_id, created_at);
-- 🐛 #45/#47: a ＋ New plan made from one of ButterflAI's ideas carries which idea (so the agent knows why
-- it suggested it, and the person's own edit of it wins).
ALTER TABLE inbound_messages ADD COLUMN spell_id TEXT;
