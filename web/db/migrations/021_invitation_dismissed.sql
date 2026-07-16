-- Migration 021: add dismissed_at to event_invitations
-- dismissed_at unix timestamp when user hides an invite (NULL means visible)
ALTER TABLE event_invitations ADD COLUMN dismissed_at INTEGER;
