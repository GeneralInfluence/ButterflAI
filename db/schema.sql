-- ButterflAI core schema

-- Users (full ButterflAI accounts)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    telegram_id TEXT UNIQUE,
    telegram_username TEXT,
    clawbank_pubkey TEXT UNIQUE,       -- ClawBank wallet pubkey (agent identity)
    agent_endpoint TEXT,               -- Where their agent can be reached
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Contacts (Tier 1 — opted in to being contacted, no full account)
CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    invited_by_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    telegram_id TEXT,
    telegram_username TEXT,
    phone TEXT,                        -- future SMS support
    tier INTEGER NOT NULL DEFAULT 0,  -- 0=opted out, 1=contact mode, 2=full user
    opted_out_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Contact preferences (for Tier 1 contacts and full users)
CREATE TABLE IF NOT EXISTS contact_preferences (
    contact_id TEXT PRIMARY KEY,       -- references contacts.id OR users.id
    availability_notes TEXT,           -- "weekday lunches, weekend evenings"
    neighborhoods TEXT,                -- JSON array of preferred areas
    dietary TEXT,                      -- JSON array e.g. ["vegetarian","no nuts"]
    comm_preference TEXT DEFAULT 'telegram', -- 'telegram' | 'sms'
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Invite tokens
CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY,
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    contact_name TEXT,                 -- hint pre-filled on invite page
    contact_id TEXT REFERENCES contacts(id),  -- set once accepted/declined
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted_contact', 'accepted_full', 'opted_out', 'expired')),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    expires_at INTEGER,                -- NULL = never expires
    resolved_at INTEGER
);

-- Relationships (between users — the social graph)
CREATE TABLE IF NOT EXISTS relationships (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    contact_id TEXT NOT NULL,          -- contacts.id or users.id
    contact_is_user INTEGER DEFAULT 0, -- 1 if contact_id is a full user
    nickname TEXT,
    notes TEXT,                        -- PRIVATE: never shared
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Relationship cadences (recurring activity goals)
CREATE TABLE IF NOT EXISTS cadences (
    id TEXT PRIMARY KEY,
    relationship_id TEXT NOT NULL REFERENCES relationships(id),
    activity_type TEXT NOT NULL,       -- 'lunch' | 'dinner' | 'activity' | 'date'
    frequency TEXT NOT NULL,           -- 'weekly' | 'monthly' | 'quarterly'
    group_size TEXT DEFAULT 'one_on_one', -- 'one_on_one' | 'couple' | 'group'
    budget_per_person REAL,
    preferred_areas TEXT,              -- JSON array
    preferred_times TEXT,              -- 'weekday_lunch' | 'weekend_evening' etc.
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
    scheduled_at INTEGER,
    cost_actual REAL,
    fun_score REAL,                    -- 0.0–1.0, derived from post-activity dialogue
    notes TEXT,
    status TEXT DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'confirmed', 'completed', 'cancelled')),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Budget tracking
CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    period TEXT NOT NULL,              -- 'weekly' | 'monthly'
    amount REAL NOT NULL,
    spent REAL DEFAULT 0,
    period_start INTEGER NOT NULL,
    period_end INTEGER NOT NULL
);

-- Agent-to-agent message log
CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    from_pubkey TEXT NOT NULL,
    to_pubkey TEXT NOT NULL,
    message_type TEXT NOT NULL,        -- 'propose' | 'counter' | 'confirm' | 'decline'
    payload TEXT NOT NULL,             -- JSON
    signature TEXT NOT NULL,           -- ClawBank wallet signature
    processed INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);
CREATE INDEX IF NOT EXISTS idx_invites_creator ON invites(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_invited_by ON contacts(invited_by_user_id);
CREATE INDEX IF NOT EXISTS idx_cadences_relationship ON cadences(relationship_id);
CREATE INDEX IF NOT EXISTS idx_activities_cadence ON activities(cadence_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_pubkey, processed);
