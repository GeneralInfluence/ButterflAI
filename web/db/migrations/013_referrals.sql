-- Migration 013: Referral system
-- Additive only — no DROP or RENAME

CREATE TABLE IF NOT EXISTS referrals (
    id               TEXT PRIMARY KEY,
    referrer_user_id TEXT NOT NULL REFERENCES users(id),
    referral_token   TEXT NOT NULL UNIQUE,
    referred_user_id TEXT REFERENCES users(id),    -- set when they join
    status           TEXT NOT NULL DEFAULT 'pending',
      -- 'pending' | 'joined' | 'rewarded'
    created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    rewarded_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_referrals_token    ON referrals(referral_token);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id);

ALTER TABLE users ADD COLUMN referral_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_token ON users(referral_token) WHERE referral_token IS NOT NULL;
