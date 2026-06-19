-- main.sqlite schema
-- Identity, routing, contacts, and coordination metadata.
-- Sensitive per-user data (conversation history, desires, private notes) lives in
-- users/{user_id}.sqlite. A WHERE clause bug here leaks contact names, not conversations.

-- Users (identity + auth)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT UNIQUE,
    onboarding_state TEXT NOT NULL DEFAULT 'new',
    onboarding_data TEXT NOT NULL DEFAULT '{}',
    telegram_id TEXT UNIQUE,
    telegram_username TEXT,
    telegram_chat_id TEXT,
    clawbank_pubkey TEXT UNIQUE,
    agent_endpoint TEXT,
    onboarded INTEGER NOT NULL DEFAULT 0,
    agent_notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Contacts (scoped by invited_by_user_id; phone lookup needed for inbound SMS routing)
CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    invited_by_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    phone TEXT,
    telegram_id TEXT,
    telegram_username TEXT,
    telegram_chat_id TEXT,
    tier INTEGER NOT NULL DEFAULT 0,
    opted_out_at INTEGER,
    imported_from TEXT,
    import_source TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Contact preferences (non-sensitive; co-located with contacts for join simplicity)
CREATE TABLE IF NOT EXISTS contact_preferences (
    contact_id TEXT PRIMARY KEY,
    availability_notes TEXT,
    neighborhoods TEXT,
    dietary TEXT,
    comm_preference TEXT DEFAULT 'sms',
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
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

-- SMS opt-out registry
CREATE TABLE IF NOT EXISTS sms_optouts (
    phone        TEXT PRIMARY KEY,
    opted_out_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    source       TEXT DEFAULT 'stop_reply'
);

-- Consent ledger
CREATE TABLE IF NOT EXISTS consent_records (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    phone            TEXT NOT NULL,
    consent_source   TEXT NOT NULL,
    disclosure_version TEXT NOT NULL DEFAULT '1.0',
    consented_at     INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Inbound message queue (processed by agent loop)
CREATE TABLE IF NOT EXISTS inbound_messages (
    id TEXT PRIMARY KEY,
    from_phone TEXT,
    from_telegram_id TEXT,
    from_type TEXT NOT NULL CHECK (from_type IN ('contact', 'user')),
    from_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'sms'
        CHECK (channel IN ('sms', 'telegram', 'webchat', 'eval', 'agent',
                           'agent_query', 'agent_reply', 'coord_notify')),
    text TEXT NOT NULL,
    processed INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Coordination sessions (state machine metadata — not user content)
-- Kept in main so inbound MCP messages can be routed without knowing userId.
CREATE TABLE IF NOT EXISTS coordination_sessions (
    id TEXT PRIMARY KEY,
    desire_id TEXT NOT NULL,
    initiator_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'initiator' CHECK (role IN ('initiator', 'responder')),
    state TEXT NOT NULL DEFAULT 'pending',
    round INTEGER NOT NULL DEFAULT 1,
    agreed_slot_start TEXT,
    agreed_slot_duration INTEGER,
    agreed_activity TEXT,
    escalation_reason TEXT,
    expires_at TEXT NOT NULL,
    purge_after TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Coordination session peers (availability windows — coordination metadata)
CREATE TABLE IF NOT EXISTS coord_session_peers (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES coordination_sessions(id),
    peer_agent_id TEXT NOT NULL,
    peer_user_id TEXT,
    state TEXT NOT NULL DEFAULT 'probing',
    available_days TEXT,
    offered_windows TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Ambient social signals (anonymized by design — no user identity)
CREATE TABLE IF NOT EXISTS ambient_signals (
    id TEXT PRIMARY KEY,
    from_agent_id TEXT,
    category TEXT NOT NULL,
    area TEXT,
    date TEXT NOT NULL,
    period TEXT NOT NULL,
    certainty TEXT NOT NULL,
    open_to_company INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_phone          ON users(phone);
CREATE INDEX IF NOT EXISTS idx_invites_token        ON invites(token);
CREATE INDEX IF NOT EXISTS idx_invites_creator      ON invites(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_invited_by  ON contacts(invited_by_user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone       ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_consent_phone        ON consent_records(phone);
CREATE INDEX IF NOT EXISTS idx_inbound_unprocessed  ON inbound_messages(processed, created_at);
CREATE INDEX IF NOT EXISTS idx_coord_sessions_state ON coordination_sessions(state);
CREATE INDEX IF NOT EXISTS idx_coord_peers_session  ON coord_session_peers(session_id);
CREATE INDEX IF NOT EXISTS idx_ambient_date         ON ambient_signals(date);
