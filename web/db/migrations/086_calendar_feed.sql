-- Plans on your iPhone (or any) calendar with no password (owner, 2026-10-23: "making them remember something none of my
-- friends have been able to remember"): a private subscription link (webcal). Random, can be turned off or replaced.
ALTER TABLE users ADD COLUMN cal_feed_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cal_feed_token ON users(cal_feed_token);
