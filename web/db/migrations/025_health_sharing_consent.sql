-- Migration 025: health/safety data sharing consent
-- health_sharing_approved = 0: agent must ask user before sharing health notes with anyone (default)
-- health_sharing_approved = 1: user has opted in to agent sharing health notes with requesting agents
--
-- REMEDIATED 2026-07-17 (PRIVACY.md Invariant 1). The original design stored
-- health_safety_notes here in PLAINTEXT, which is a violation (user_preferences is the
-- coordination-readable store). Health notes now live ENCRYPTED in user_private_data under
-- the canonical key health.safety_notes (see sensitive.js). The column below is RETAINED
-- per the additive-only migration rule (never dropped) but MUST stay NULL. A startup
-- migration moves any legacy plaintext values into the encrypted store, and the Guardian
-- check verifies the column is empty. health_sharing_approved (a boolean consent flag, not
-- sensitive data) correctly remains here.
-- NOTE: the migration runner splits SQL on the semicolon character, so comments in a
-- migration file must not contain any semicolons.
ALTER TABLE user_preferences ADD COLUMN health_safety_notes TEXT;
ALTER TABLE user_preferences ADD COLUMN health_sharing_approved INTEGER DEFAULT 0;
