-- User timezone for correct date parsing and formatting
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/New_York';
