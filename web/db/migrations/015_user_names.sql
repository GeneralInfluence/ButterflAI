-- 015: nickname + also_known_as on users (extra names others may recognize them by)
ALTER TABLE users ADD COLUMN nickname TEXT;
ALTER TABLE users ADD COLUMN also_known_as TEXT;  -- comma-separated or free text
