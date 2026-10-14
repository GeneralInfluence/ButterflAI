-- Desires become plans (owner, 2026-10-13: "make them plans"). A social desire ("go out
-- with a friend or two this week") is one plan per time it should happen, created on first
-- mention with the desire's window as its proposed dates. This links them so negotiation can
-- set the plan's date and deleting the desire can cancel plans nobody has joined yet.
CREATE TABLE IF NOT EXISTS desire_plans (
  desire_id  TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (desire_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_desire_plans_event ON desire_plans (event_id);

-- The coordination view never got the v2 columns (004), so recurring templates and
-- "specific" candidates were invisible to the coord loop (it read columns the view
-- didn't have, and the error was swallowed). Recreated with them — still never raw_text.
DROP VIEW IF EXISTS coord_desires;
CREATE VIEW IF NOT EXISTS coord_desires AS
  SELECT id, user_id, category, activity_type,
         social_size_min, social_size_max,
         time_window_start, time_window_end,
         priority, status, created_at,
         candidate_strategy, candidate_ids, candidate_tier_min,
         recurrence, recurrence_end, horizon, parent_desire_id
  FROM desires;
