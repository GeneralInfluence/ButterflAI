-- A user can opt in as a test user (dev-user cohort). When on, the chat shows a
-- feedback affordance. Future: test users get a perk for helping.
ALTER TABLE users ADD COLUMN test_user INTEGER DEFAULT 0;
