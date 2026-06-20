-- Migration 007: user location
ALTER TABLE users ADD COLUMN city TEXT;
ALTER TABLE users ADD COLUMN region TEXT;   -- e.g. 'SF Bay Area', 'New York', 'Los Angeles'
ALTER TABLE users ADD COLUMN country TEXT DEFAULT 'US';
