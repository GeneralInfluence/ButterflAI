CREATE TABLE IF NOT EXISTS attendance_confirmations (
    id            TEXT PRIMARY KEY,
    event_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL REFERENCES users(id),
    attended      INTEGER,
    confirmed_at  INTEGER,
    asked_at      INTEGER NOT NULL,
    ask_count     INTEGER NOT NULL DEFAULT 1,
    source        TEXT NOT NULL DEFAULT 'sms_gate',
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_event_user
    ON attendance_confirmations(event_id, user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_unconfirmed
    ON attendance_confirmations(user_id, attended);
