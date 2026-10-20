-- 🐛 #41 (Sean, 2026-10-20: "I opened the cargo website and it was an unsecured website … how did you
-- find it in the first place? If it's an unsecured site, how do I know it's real?"): a link is kept only
-- if its site was in the web search results, and only shown once it opens over https (link_ok).
-- 🐛 #43 ("a map view of the explorer … the color of the pins is how far away they are"): each idea's
-- day and place, and where that is on a map.
ALTER TABLE spells ADD COLUMN link_ok INTEGER;
ALTER TABLE spells ADD COLUMN date TEXT;
ALTER TABLE spells ADD COLUMN place TEXT;
ALTER TABLE spells ADD COLUMN lat REAL;
ALTER TABLE spells ADD COLUMN lng REAL;
ALTER TABLE spells ADD COLUMN geo_checked INTEGER NOT NULL DEFAULT 0;
