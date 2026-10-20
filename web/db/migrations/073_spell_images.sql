-- Explore cards show a picture, Instagram-style (🐛 #39, owner 2026-10-20: "We need to have an image
-- there sort of like an Instagram feed"): the preview image the linked page publishes (og:image).
ALTER TABLE spells ADD COLUMN image TEXT;
ALTER TABLE spells ADD COLUMN image_checked INTEGER NOT NULL DEFAULT 0;
