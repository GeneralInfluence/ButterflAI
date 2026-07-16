-- Migration 022: flexible_time flag on social_events
-- When flexible_time=1, scheduled_at holds the creation date (not a fixed meeting time).
-- The invite says "come when you're ready" instead of a specific time.
ALTER TABLE social_events ADD COLUMN flexible_time INTEGER DEFAULT 0;
