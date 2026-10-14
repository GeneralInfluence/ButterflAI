-- "Going" vs "interested" (Bam Bam, 2026-10-13: "Let everyone know I'm going on Friday" and
-- the plan showed him as interested). On a tentative plan a yes was always shown as
-- "interested". going = 1 when they said they're going / in / will be there.
ALTER TABLE event_invitations ADD COLUMN going INTEGER NOT NULL DEFAULT 0;
