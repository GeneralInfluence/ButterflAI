-- Migration 025: health/safety data sharing consent
-- health_sharing_approved = 0: agent must ask user before sharing health notes with anyone (default)
-- health_sharing_approved = 1: user has opted in to agent sharing health_safety_notes with requesting agents
-- health_safety_notes is stored here (plaintext, user-visible) not in encrypted private_data,
-- because the user needs to be able to see and edit it in Settings.
ALTER TABLE user_preferences ADD COLUMN health_safety_notes TEXT;
ALTER TABLE user_preferences ADD COLUMN health_sharing_approved INTEGER DEFAULT 0;
