-- 014: nickname column on contacts (user's label for this contact, overrides stored name in UI)
ALTER TABLE contacts ADD COLUMN nickname TEXT;
