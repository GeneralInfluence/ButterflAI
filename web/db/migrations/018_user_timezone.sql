-- 018: store IANA timezone per user (detected from coordinates on location share)
ALTER TABLE users ADD COLUMN timezone TEXT;
