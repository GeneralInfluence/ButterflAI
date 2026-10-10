-- A chat message sent from inside a plan's discussion (the plan pills along the top of
-- chat, owner 2026-10-09) carries that plan, so the agent knows what it's about and the
-- turn is filed under it.
ALTER TABLE inbound_messages ADD COLUMN event_id TEXT;
