-- Migration 001: SMS, audit log, wallet, private data, onboarding state
-- Run once. All statements use IF NOT EXISTS / ADD COLUMN safely.

-- ── Users: add SMS + onboarding fields ──────────────────────────────────────

ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN onboarding_state TEXT DEFAULT 'new';
  -- states: new | awaiting_name | awaiting_contacts | confirming_contacts | complete
ALTER TABLE users ADD COLUMN onboarding_data TEXT DEFAULT '{}';
  -- JSON scratch pad for in-progress onboarding (name guesses, parsed contacts etc.)

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

-- ── Contacts: ensure phone is indexed ───────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);

-- ── Private data store (encrypted at rest) ──────────────────────────────────
-- Private preferences are NOT stored in contact_preferences (which is plaintext).
-- This table holds AES-256-GCM encrypted blobs, one row per user.
-- The wrapped_key is the per-record data key encrypted under the KMS master key.
-- Decrypt only via crypto.js decryptUserPrivateData() — which writes access_audit.

CREATE TABLE IF NOT EXISTS private_data (
    user_id   TEXT PRIMARY KEY REFERENCES users(id),
    ciphertext TEXT NOT NULL,          -- hex-encoded AES-256-GCM ciphertext
    iv        TEXT NOT NULL,           -- hex-encoded 12-byte IV
    tag       TEXT NOT NULL,           -- hex-encoded 16-byte GCM auth tag
    wrapped_key TEXT NOT NULL,         -- base64: data key wrapped by KMS master key
    version   INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ── Access audit log ─────────────────────────────────────────────────────────
-- Every decryption of private_data writes a row here.
-- Users can review their own audit trail. Admins can never access without break-glass.

CREATE TABLE IF NOT EXISTS access_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT NOT NULL REFERENCES users(id),
    accessed_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    accessor        TEXT NOT NULL,     -- 'agent_reasoning' | 'breakglass:<admin_id>'
    purpose         TEXT NOT NULL,     -- e.g. 'onboarding' | 'coordinate_lunch_with_kaylee'
    record_class    TEXT NOT NULL,     -- 'private_prefs' | 'exclusion' | 'private_note'
    outside_normal_path INTEGER NOT NULL DEFAULT 0  -- 1 = alert
);

CREATE INDEX IF NOT EXISTS idx_access_audit_user ON access_audit(user_id, accessed_at);

-- ── Wallet / ClawBank (stubbed for now) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_wallets (
    user_id         TEXT PRIMARY KEY REFERENCES users(id),
    wallet_address  TEXT UNIQUE,
    clawbank_account_id TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ── SMS opt-out registry ─────────────────────────────────────────────────────
-- Separate from contacts.tier so we can enforce STOP even if no contact record exists.

CREATE TABLE IF NOT EXISTS sms_optouts (
    phone       TEXT PRIMARY KEY,
    opted_out_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    source      TEXT DEFAULT 'stop_reply'  -- 'stop_reply' | 'web' | 'admin'
);

-- ── Onboarding: parsed relationship intents (temp scratch during onboarding) ─

CREATE TABLE IF NOT EXISTS onboarding_intents (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    contact_name    TEXT NOT NULL,
    frequency       TEXT NOT NULL,     -- 'monthly' | 'quarterly' | 'weekly'
    activity_type   TEXT,              -- 'lunch' | 'dinner' | null
    group_size      TEXT DEFAULT 'one_on_one',
    confirmed       INTEGER DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
