-- Plans can belong to a contact group (owner, 2026-10-09): someone added to the group
-- later is caught up on and invited to its upcoming plans. NULL = not a group plan.
ALTER TABLE social_events ADD COLUMN group_id TEXT;
