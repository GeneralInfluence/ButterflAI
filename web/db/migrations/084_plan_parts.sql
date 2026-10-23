-- Plans inside plans (owner, 2026-10-23, after Melanie and Allie's Friday lunch: "creating an event sometimes within another
-- event … needs to be a lot smoother"). A part of a plan ("Friday evening" inside the birthday weekend) has everyone in
-- the bigger plan (owner's choice).
ALTER TABLE social_events ADD COLUMN parent_id TEXT;
-- A contact made only so someone can be invited from a plan you share — not shown in People, its number never shown,
-- and it doesn't make you "close" (whispers, wishes, out and about, passing ideas on).
ALTER TABLE contacts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
