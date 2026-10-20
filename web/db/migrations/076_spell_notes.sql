-- 🐛 #42 (Sean, 2026-10-20): "as I go through the website I can make a comment and what I find and say
-- what's interesting and what's not. And that becomes a part of my personal preferences". What the
-- person said about an idea after looking at its page (theirs only, shapes their own ideas).
ALTER TABLE spells ADD COLUMN note TEXT;
