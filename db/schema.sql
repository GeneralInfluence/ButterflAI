-- ButterflAI core schema
-- This file is applied on fresh installs. For existing DBs, run migrations/ in order.

-- Users (full ButterflAI accounts)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT UNIQUE,                 -- primary human channel (SMS/Twilio)
    onboarding_state TEXT NOT NULL DEFAULT 'new',
      -- new | awaiting_name | awaiting_contacts | confirming_contacts | complete
    onboarding_data TEXT NOT NULL DEFAULT '{}',
      -- JSON scratch pad for in-progress onboarding
    telegram_id TEXT UNIQUE,           -- retained for future international/B2B use
    telegram_username TEXT,
    telegram_chat_id TEXT,
    clawbank_pubkey TEXT UNIQUE,
    agent_endpoint TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Contacts (people in a user's world; Tier 0 until invited)
CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    invited_by_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    phone TEXT,                        -- primary contact channel
    telegram_id TEXT,
    telegram_username TEXT,
    telegram_chat_id TEXT,
    tier INTEGER NOT NULL DEFAULT 0,   -- 0=opted out, 1=contact mode, 2=full user
    opted_out_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Contact preferences (non-sensitive coordination metadata — NOT encrypted)
-- Sensitive data (exclusions, private notes) lives in private_data table, encrypted.
CREATE TABLE IF NOT EXISTS contact_preferences (
    contact_id TEXT PRIMARY KEY,       -- references contacts.id OR users.id
    availability_notes TEXT,           -- "weekday lunches, weekend evenings"
    neighborhoods TEXT,                -- JSON array of preferred areas
    dietary TEXT,                      -- JSON array e.g. ["vegetarian","no nuts"]
    comm_preference TEXT DEFAULT 'sms', -- 'sms' | 'telegram'
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Private data store (AES-256-GCM encrypted at rest, KMS-wrapped data key)
-- One row per user. Decrypt ONLY via crypto.js decryptUserPrivateData().
-- Every decrypt writes an access_audit row.
CREATE TABLE IF NOT EXISTS private_data (
    user_id    TEXT PRIMARY KEY REFERENCES users(id),
    ciphertext TEXT NOT NULL,          -- hex-encoded ciphertext
    iv         TEXT NOT NULL,          -- hex-encoded 12-byte IV
    tag        TEXT NOT NULL,          -- hex-encoded 16-byte GCM auth tag
    wrapped_key TEXT NOT NULL,         -- base64: per-record data key wrapped by KMS
    version    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Access audit log (append-only; every decrypt writes here)
CREATE TABLE IF NOT EXISTS access_audit (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          TEXT NOT NULL REFERENCES users(id),
    accessed_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    accessor         TEXT NOT NULL,    -- 'agent_reasoning' | 'breakglass:<admin_id>'
    purpose          TEXT NOT NULL,    -- e.g. 'coordinate_lunch_with_kaylee'
    record_class     TEXT NOT NULL,    -- 'private_prefs' | 'exclusion' | 'private_note'
    outside_normal_path INTEGER NOT NULL DEFAULT 0  -- 1 triggers alert
);

-- Invite tokens
CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY,
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    contact_name TEXT,
    contact_id TEXT REFERENCES contacts(id),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted_contact', 'accepted_full', 'opted_out', 'expired')),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    expires_at INTEGER,
    resolved_at INTEGER
);

-- SMS opt-out registry (enforced independently of contacts.tier)
CREATE TABLE IF NOT EXISTS sms_optouts (
    phone        TEXT PRIMARY KEY,
    opted_out_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    source       TEXT DEFAULT 'stop_reply'  -- 'stop_reply' | 'web' | 'admin'
);

-- Onboarding intents (parsed relationship goals during onboarding, confirmed before persisting)
CREATE TABLE IF NOT EXISTS onboarding_intents (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    contact_name TEXT NOT NULL,
    frequency    TEXT NOT NULL,        -- 'weekly' | 'monthly' | 'quarterly'
    activity_type TEXT,                -- 'lunch' | 'dinner' | null
    group_size   TEXT DEFAULT 'one_on_one',
    confirmed    INTEGER DEFAULT 0,
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Relationships (between a user and a contact)
CREATE TABLE IF NOT EXISTS relationships (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    contact_id TEXT NOT NULL,          -- contacts.id or users.id
    contact_is_user INTEGER DEFAULT 0,
    nickname TEXT,
    notes TEXT,                        -- PRIVATE: never shared (stored in private_data for sensitive notes)
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Relationship cadences
CREATE TABLE IF NOT EXISTS cadences (
    id TEXT PRIMARY KEY,
    relationship_id TEXT NOT NULL REFERENCES relationships(id),
    activity_type TEXT NOT NULL,
    frequency TEXT NOT NULL,
    group_size TEXT DEFAULT 'one_on_one',
    budget_per_person REAL,
    preferred_areas TEXT,
    preferred_times TEXT,
    last_fulfilled_at INTEGER,
    next_target_at INTEGER,
    active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Activity history
CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    cadence_id TEXT REFERENCES cadences(id),
    participants TEXT NOT NULL,        -- JSON array of user/contact ids
    activity_type TEXT NOT NULL,
    venue_name TEXT,
    venue_address TEXT,
    proposed_slots TEXT,               -- JSON array of ISO datetime strings
    scheduled_at INTEGER,
    cost_actual REAL,
    fun_score REAL,                    -- 0.0–1.0
    responses TEXT DEFAULT '{}',       -- JSON: { phone: 'accepted'|'declined' }
    time_choices TEXT DEFAULT '{}',    -- JSON: { phone: slotIndex }
    notes TEXT,
    status TEXT DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'confirmed', 'completed', 'cancelled')),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Inbound messages (agent processing queue — SMS and Telegram)
CREATE TABLE IF NOT EXISTS inbound_messages (
    id TEXT PRIMARY KEY,
    from_phone TEXT,                   -- set for SMS messages
    from_telegram_id TEXT,             -- set for Telegram messages
    from_type TEXT NOT NULL CHECK (from_type IN ('contact', 'user')),
    from_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'telegram', 'webchat', 'eval', 'agent', 'agent_query', 'agent_reply')),
    text TEXT NOT NULL,
    processed INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Budget tracking
CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    period TEXT NOT NULL,
    amount REAL NOT NULL,
    spent REAL DEFAULT 0,
    period_start INTEGER NOT NULL,
    period_end INTEGER NOT NULL
);

-- Agent-to-agent message log (MCP; purged after coordination resolves)
CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    from_user TEXT NOT NULL REFERENCES users(id),
    to_user TEXT NOT NULL REFERENCES users(id),
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL,                -- 'query' | 'reply' | 'notification'
    topic TEXT NOT NULL,               -- 'availability' | 'constraints' | 'rsvp' | 'coordination'
    body TEXT NOT NULL,                -- never contains exclusion reasons or private prefs
    processed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Wallet / ClawBank (stubbed — wired fully when social-budget feature lands)
CREATE TABLE IF NOT EXISTS user_wallets (
    user_id             TEXT PRIMARY KEY REFERENCES users(id),
    wallet_address      TEXT UNIQUE,
    clawbank_account_id TEXT,
    created_at          INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at          INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_phone          ON users(phone);
CREATE INDEX IF NOT EXISTS idx_invites_token        ON invites(token);
CREATE INDEX IF NOT EXISTS idx_invites_creator      ON invites(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_invited_by  ON contacts(invited_by_user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone       ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_cadences_relationship ON cadences(relationship_id);
CREATE INDEX IF NOT EXISTS idx_activities_cadence   ON activities(cadence_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_to    ON agent_messages(to_user, processed, created_at);
CREATE INDEX IF NOT EXISTS idx_access_audit_user    ON access_audit(user_id, accessed_at);
CREATE INDEX IF NOT EXISTS idx_inbound_unprocessed  ON inbound_messages(processed, created_at);

-- Pending actions (stores context for stateful SMS conversations)
-- When the agent sends a question and awaits user reply, it stores a pending_action.
-- The next inbound SMS from that user is checked against pending actions first.
CREATE TABLE IF NOT EXISTS pending_actions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    action_type TEXT NOT NULL,
      -- 'nudge_confirm'   → user replied yes/no to a cadence nudge
      -- 'approve_message' → user needs to approve a drafted expressive message
      -- 'confirm_booking' → user needs to confirm a venue/time
    payload     TEXT NOT NULL DEFAULT '{}',  -- JSON context
    expires_at  INTEGER NOT NULL,            -- auto-expire so stale actions don't linger
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_pending_actions_user ON pending_actions(user_id, expires_at);
