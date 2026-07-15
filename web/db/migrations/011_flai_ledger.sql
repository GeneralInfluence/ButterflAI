CREATE TABLE IF NOT EXISTS flai_ledger (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT REFERENCES users(id),
    delta       INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    ref_id      TEXT,
    metadata    TEXT DEFAULT '{}',
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_flai_ledger_user ON flai_ledger(user_id, created_at);
