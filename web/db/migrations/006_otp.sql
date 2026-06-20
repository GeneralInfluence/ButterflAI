-- Migration 006: OTP codes for web app auth
CREATE TABLE IF NOT EXISTS otp_codes (
  id          TEXT PRIMARY KEY,
  phone       TEXT NOT NULL,
  code        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,   -- unix seconds
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes (phone, expires_at);
