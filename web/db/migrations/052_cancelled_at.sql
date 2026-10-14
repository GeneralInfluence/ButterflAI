-- "Delete" was only ever cancel, and cancelled plans were kept forever (event-map #7).
-- cancelled_at is when a plan was cancelled (or folded into another). Cancelled plans are
-- hard-deleted CANCELLED_KEEP_DAYS later (planops.purgeCancelled, coord loop). Plans that
-- were already cancelled count from now.
ALTER TABLE social_events ADD COLUMN cancelled_at INTEGER;
UPDATE social_events SET cancelled_at = strftime('%s','now') WHERE status = 'cancelled' AND cancelled_at IS NULL;
