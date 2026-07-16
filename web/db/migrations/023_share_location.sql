-- Migration 023: location sharing preference
-- share_location=1 (default): this user's city/coords can appear in other agents'
--   proximity checks (check_invitee_locations). share_location=0: hidden from others.
-- The user's own agent still uses location for venue search etc. regardless.
ALTER TABLE users ADD COLUMN share_location INTEGER DEFAULT 1;
