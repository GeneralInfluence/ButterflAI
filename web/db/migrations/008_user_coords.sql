-- Migration 008: store precise coordinates alongside city
ALTER TABLE users ADD COLUMN lat  REAL;
ALTER TABLE users ADD COLUMN lng  REAL;
ALTER TABLE users ADD COLUMN location_updated_at INTEGER;
