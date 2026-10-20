-- Where you met someone and what they're into (owner, 2026-10-20 - "I'm here talking to Sarah,
-- she's over in Kings Beach. I don't have her number. She's on Tinder"). For your own ButterflAI
-- only - contacts are never shared with anyone.
ALTER TABLE contacts ADD COLUMN met_via TEXT;
ALTER TABLE contacts ADD COLUMN about TEXT;
