-- Migration 034: when the user last used the web app (any signed-in request,
-- updated at most every 5 minutes). Decides whether a message to them can wait
-- in the app or should be texted now (deliver.js). Null = never / long ago.
ALTER TABLE users ADD COLUMN last_active_at INTEGER;
