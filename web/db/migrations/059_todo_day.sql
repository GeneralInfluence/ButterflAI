-- A plan's to-dos can be for one day of it (owner, 2026-10-13: "the tests should ensure the
-- massage is on Friday"). day = YYYY-MM-DD, one of the days the plan covers. Set from the
-- calendar day the person was looking at when they said it (inbound_messages.context_day)
-- unless they named another day.
ALTER TABLE event_todos ADD COLUMN day TEXT;
