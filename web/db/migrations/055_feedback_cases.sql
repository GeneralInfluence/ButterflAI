-- Every 🐛 becomes a test (owner, 2026-10-13). case_json = the anonymized situation the
-- feedback was about (feedbackcase.js: the plan as seen, its change history, ripples, the
-- conversation, people as "Person A/B"). It is kept after the screenshot and raw state are
-- deleted (90 days) and after the plan itself is gone, because it is what the test is built
-- from. test_ref = the test that covers it (a feedback item can't be marked fixed without one).
ALTER TABLE feedback ADD COLUMN case_json TEXT;
ALTER TABLE feedback ADD COLUMN test_ref TEXT;
