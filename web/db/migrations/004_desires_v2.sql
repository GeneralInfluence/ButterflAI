-- Migration 004: Desires v2
-- Adds candidate_strategy, recurrence, and horizon fields.
-- raw_text is zeroed after parsing (not kept).

-- candidate_strategy: how the agent selects who to probe
-- 'specific'       → candidate_ids column (JSON array of contact IDs)
-- 'tier'           → candidate_tier_min column (probe Tier N+ contacts)
-- 'interest_match' → match contacts by activity preference
-- 'any'            → broadest: any willing Tier 1+ contact
ALTER TABLE desires ADD COLUMN candidate_strategy TEXT NOT NULL DEFAULT 'specific';
ALTER TABLE desires ADD COLUMN candidate_ids TEXT;           -- JSON: ["contact-uuid", ...]
ALTER TABLE desires ADD COLUMN candidate_tier_min INTEGER DEFAULT 1;

-- recurrence: 'none' | 'weekly' | 'biweekly' | 'monthly'
-- recurring desires spawn a new instance each period until cancelled
ALTER TABLE desires ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none';
ALTER TABLE desires ADD COLUMN recurrence_end TEXT;         -- YYYY-MM-DD, null = ongoing

-- horizon: 'one_off' | 'recurring' | 'template'
-- template = the parent recurring desire; one_off = instance or standalone
ALTER TABLE desires ADD COLUMN horizon TEXT NOT NULL DEFAULT 'one_off';
ALTER TABLE desires ADD COLUMN parent_desire_id TEXT;       -- for instances spawned from a template

-- raw_text_zeroed: tracks whether raw_text has been cleared after parsing
ALTER TABLE desires ADD COLUMN raw_text_zeroed INTEGER NOT NULL DEFAULT 0;

-- desire_deletions: receipt log for hard deletes (GDPR-style)
CREATE TABLE IF NOT EXISTS desire_deletions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  deleted_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  desire_count    INTEGER NOT NULL DEFAULT 0,
  session_count   INTEGER NOT NULL DEFAULT 0  -- coord sessions cancelled
);
