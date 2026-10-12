-- Feedback from any screen (owner, 2026-10-12): one tap captures what the person was
-- looking at. page = the screen, state_json = what it was showing (+ the plan object when
-- a plan was on screen), screenshot = JPEG (optional, the person can leave it out).
-- Screenshots and state are deleted after 90 days (coord-loop purge).
ALTER TABLE feedback ADD COLUMN page TEXT;
ALTER TABLE feedback ADD COLUMN state_json TEXT;
ALTER TABLE feedback ADD COLUMN screenshot BLOB;
ALTER TABLE feedback ADD COLUMN app_version TEXT;
ALTER TABLE feedback ADD COLUMN device TEXT;
