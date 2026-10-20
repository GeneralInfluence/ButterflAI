-- 🐛 #44 (Sean, 2026-10-20): "the things that need to be done, the creating … things that you want to do
-- together like Allie and I did at lunch today … chatting about stuff and figuring it out together … over
-- a drink … that by itself with other people who are involved or relevant could be its own event".
-- The plan made to do a Creating item together.
ALTER TABLE event_todos ADD COLUMN together_event_id TEXT;
