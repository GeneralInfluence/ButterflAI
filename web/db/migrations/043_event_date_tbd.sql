-- Plans exist from their first mention, before there's a date (owner, 2026-10-09: "every
-- conversation in ButterflAI is about an event"). date_tbd = 1: scheduled_at is only a
-- placeholder (kept ~45 days ahead by the coord loop) and every display says "date TBD".
ALTER TABLE social_events ADD COLUMN date_tbd INTEGER NOT NULL DEFAULT 0;
