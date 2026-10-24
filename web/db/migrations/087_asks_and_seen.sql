-- Owner, 2026-10-23: "the notification process. So that way they know that I see the message, and then I know they see
-- that I've responded. That needs to be smoother." And (decided): only the person can accept something they're put down
-- for — never their agent.
-- An item put on someone else is a question to them: asked → on_it / cant.
ALTER TABLE event_todos ADD COLUMN ask_status TEXT;
ALTER TABLE event_todos ADD COLUMN asked_by TEXT;
ALTER TABLE event_todos ADD COLUMN asked_at INTEGER;
ALTER TABLE event_todos ADD COLUMN answered_at INTEGER;
-- What a chat card is about, for its buttons and "Seen": 'todo:<id>' (a question to you), 'delivery:<id>' (a message you sent).
ALTER TABLE conversation_history ADD COLUMN ref TEXT;
-- When each person last looked at a plan (its discussion, Creating or Details) — "who knows" about each change.
CREATE TABLE IF NOT EXISTS plan_seen (
  event_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  seen_at  INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
