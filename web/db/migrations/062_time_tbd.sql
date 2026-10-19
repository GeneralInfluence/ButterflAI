-- A plan whose day is known but not its time (Sean, 2026-10-19 - "I also didn't give a time
-- so we don't know if it's 7:00"). scheduled_at holds noon of that day, shown as "time TBD",
-- and calendars get an all-day entry.
ALTER TABLE social_events ADD COLUMN time_tbd INTEGER NOT NULL DEFAULT 0;
