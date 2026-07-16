-- Migration 024: host_attending flag on social_events
-- host_attending=1 (default): organizer plans to attend their own event.
-- host_attending=0: organizer bailed but the event continues for invitees.
-- Event status stays 'open' — this is separate from cancellation.
ALTER TABLE social_events ADD COLUMN host_attending INTEGER DEFAULT 1;
