-- Why a message was sent, when the app knows it (2026-10-20, report 34 - the + New plan
-- button). new_plan means the person tapped + New plan, so their ButterflAI creates the plan
-- from these words right away.
ALTER TABLE inbound_messages ADD COLUMN intent TEXT;
