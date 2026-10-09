-- Tentative events (2026-10-09): a trip or plan the group is still figuring out
-- (dates, where to sleep, who's in). Friends who are clearly in are 'accepted'
-- (shown as "interested") and it's on their ButterflAI calendar. 1 = tentative.
ALTER TABLE social_events ADD COLUMN tentative INTEGER NOT NULL DEFAULT 0;
