-- Deferring on a plan (owner, 2026-10-09 — Allie: "whatever we do is up to Melanie").
-- The invitee is in and goes with whatever the named people decide. Their ButterflAI
-- answers questions about that plan itself instead of asking them. Plan-only.
-- defers_to = JSON array of first names. deferred_at = when they said so.
ALTER TABLE event_invitations ADD COLUMN defers_to TEXT;
ALTER TABLE event_invitations ADD COLUMN deferred_at INTEGER;
