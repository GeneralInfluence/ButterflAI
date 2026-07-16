-- 018: event_type (private|public) on social_events
--      source (contact|public) on event_invitations — was this person specifically invited or did they self-RSVP?
ALTER TABLE social_events    ADD COLUMN event_type TEXT NOT NULL DEFAULT 'private';
ALTER TABLE event_invitations ADD COLUMN source    TEXT NOT NULL DEFAULT 'contact';
