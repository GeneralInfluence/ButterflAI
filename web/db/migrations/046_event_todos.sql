-- A plan's to-do list (owner, 2026-10-12: "a list of what needs to happen for each event").
-- Everyone in the plan (host + invitees) sees and edits it. assignee_phone identifies the
-- person in the plan it's assigned to (NULL = anyone). suggested = 1: proposed by the agent,
-- not kept yet.
CREATE TABLE IF NOT EXISTS event_todos (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL,
  text           TEXT NOT NULL,
  assignee_phone TEXT,
  assignee_name  TEXT,
  suggested      INTEGER NOT NULL DEFAULT 0,
  done_at        INTEGER,
  done_by        TEXT,
  created_by     TEXT,
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_event_todos_event ON event_todos (event_id);
CREATE INDEX IF NOT EXISTS idx_event_todos_assignee ON event_todos (assignee_phone);
