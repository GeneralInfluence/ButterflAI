-- Persistent agent notes per user — durable facts the agent has learned
-- (resolved disambiguations, preferences, recurring context)
ALTER TABLE users ADD COLUMN agent_notes TEXT NOT NULL DEFAULT '';
