-- Roles, items with a team, and suggestions (owner, 2026-10-19 — after report 20).
-- Hosts and co-hosts decide. The person a plan is for is a co-host automatically.
-- Guests suggest changes and hosts or co-hosts accept or decline them.
-- A Creating item has a lead (assignee_phone, whoever added it) and a team of people
-- actively working on it. Only they edit it, and anyone else's change is a suggestion to them.
ALTER TABLE event_invitations ADD COLUMN role TEXT NOT NULL DEFAULT 'guest';
ALTER TABLE event_todos ADD COLUMN when_text TEXT;
ALTER TABLE event_todos ADD COLUMN place TEXT;
ALTER TABLE event_todos ADD COLUMN status TEXT NOT NULL DEFAULT 'idea';
ALTER TABLE event_todos ADD COLUMN notes TEXT;
CREATE TABLE IF NOT EXISTS todo_team (
  todo_id   TEXT NOT NULL,
  phone     TEXT NOT NULL,
  name      TEXT,
  joined_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (todo_id, phone)
);
CREATE TABLE IF NOT EXISTS plan_suggestions (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL,
  todo_id      TEXT,
  from_user_id TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  summary      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  decided_by   TEXT,
  decided_at   INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_plan_suggestions_event ON plan_suggestions(event_id, status);
