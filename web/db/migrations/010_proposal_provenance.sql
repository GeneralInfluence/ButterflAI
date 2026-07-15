CREATE TABLE IF NOT EXISTS proposals (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    cadence_id     TEXT REFERENCES cadences(id),
    origin         TEXT NOT NULL,
    activity_type  TEXT,
    proposed_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    surfaced_slots TEXT,
    outcome        TEXT,
    event_id       TEXT,
    created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_proposals_user   ON proposals(user_id, proposed_at);
CREATE INDEX IF NOT EXISTS idx_proposals_event  ON proposals(event_id);
