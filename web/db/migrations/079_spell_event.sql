-- 🐛 #53 (Sean, 2026-10-21: "The feed should include feedback I've already given and plans I made as a
-- result of going through the feed recently"): the plan made from an idea.
ALTER TABLE spells ADD COLUMN event_id TEXT;
