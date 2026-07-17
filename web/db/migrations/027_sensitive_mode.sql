-- Migration 027: sensitive_mode flag on user_preferences
-- Persists across server restarts (was previously in-memory only)
ALTER TABLE user_preferences ADD COLUMN sensitive_mode INTEGER DEFAULT 0;
