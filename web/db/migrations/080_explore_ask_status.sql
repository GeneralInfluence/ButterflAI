-- 🐛 #54 (Sean, 2026-10-21: "I did a search about Liam's party but they never updated and when I went to the
-- home screen and then back to explore it disappeared. I'd like to be able to do the search again or find out
-- the results of the search without having to redo the search"): a search runs in the background and is kept,
-- with how it went.
ALTER TABLE explore_asks ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE explore_asks ADD COLUMN made INTEGER NOT NULL DEFAULT 0;
ALTER TABLE explore_asks ADD COLUMN finished_at INTEGER;
