-- 🐛 #37 (Sean, 2026-10-20): "when it says sounds nice, I want that to be sort of like a retweet or a
-- repost where there are other people that are somehow associated with me … more likely to see it …
-- they don't necessarily know that it's from me. But still we influence each other's algorithm".
-- public_title: the idea without anyone's name (only these spread). source: own | echo.
ALTER TABLE spells ADD COLUMN public_title TEXT;
ALTER TABLE spells ADD COLUMN source TEXT NOT NULL DEFAULT 'own';
ALTER TABLE spells ADD COLUMN origin_id TEXT;
ALTER TABLE spells ADD COLUMN echoes INTEGER NOT NULL DEFAULT 0;
