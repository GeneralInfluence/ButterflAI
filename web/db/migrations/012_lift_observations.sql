CREATE TABLE IF NOT EXISTS lift_observations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id       TEXT,
    user_id        TEXT REFERENCES users(id),
    estimator      TEXT NOT NULL,
    value          REAL,
    confidence     REAL,
    inputs         TEXT DEFAULT '{}',
    computed_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
