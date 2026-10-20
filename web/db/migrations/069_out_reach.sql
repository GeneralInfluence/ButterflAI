-- How far someone will go to meet up while out (owner, 2026-10-20 - "somebody is willing to drive,
-- you know, 5-10 minutes"). Kilometres, chosen per outing. Two people only see each other if each is
-- within the other's reach.
ALTER TABLE out_now ADD COLUMN max_km REAL NOT NULL DEFAULT 15;
