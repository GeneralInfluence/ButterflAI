-- The day someone was looking at when they wrote (🐛 #15, 2026-10-13: Melanie tapped Friday
-- on the calendar, opened her birthday weekend's discussion and said "thinking about getting
-- a massage" — the massage was for Friday, but the day never reached the agent and it ended
-- up on Saturday). YYYY-MM-DD, from the calendar day that opened the plan.
ALTER TABLE inbound_messages ADD COLUMN context_day TEXT;
