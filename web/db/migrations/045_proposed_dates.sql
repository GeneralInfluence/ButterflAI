-- Proposed dates for a tentative plan (owner, 2026-10-12: "events with tentative dates
-- should … show on the potential/proposed dates"). JSON [{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}],
-- up to 5 options. NULL = none (a dated plan shows on its own date).
ALTER TABLE social_events ADD COLUMN proposed_dates TEXT;
