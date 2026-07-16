-- 020: Contact groups / lists (e.g. "closest friends", "work", "book club")
CREATE TABLE IF NOT EXISTS contact_groups (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  emoji       TEXT,                      -- optional label emoji (e.g. "⭐")
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(user_id, name COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS contact_group_members (
  group_id    TEXT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (group_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_contact ON contact_group_members(contact_id);
