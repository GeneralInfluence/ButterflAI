-- Migration 002: SMS consent ledger
-- Records every explicit opt-in event keyed by E.164 phone number.
-- The send() gate in sms.js requires a row here before any outbound Twilio call.

CREATE TABLE IF NOT EXISTS consent_records (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    phone            TEXT    NOT NULL,
    consent_source   TEXT    NOT NULL
                       CHECK (consent_source IN ('SELF_START', 'INVITE_PAGE')),
    consented_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    disclosure_version TEXT  NOT NULL DEFAULT '1.0'
);

CREATE INDEX IF NOT EXISTS idx_consent_phone ON consent_records(phone);
