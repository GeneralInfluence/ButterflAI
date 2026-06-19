-- users/{user_id}.sqlite schema
-- Physical isolation: one file per user. A bug cannot cross user boundaries.
-- No user_id columns — the user_id is the filename itself.
-- Applied fresh for new users; existing data migrated by scripts/migrate-per-user-db.js.

-- Private data (AES-256-GCM encrypted at rest, KMS-wrapped data key)
CREATE TABLE IF NOT EXISTS private_data (
    id TEXT NOT NULL DEFAULT 'singleton' PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    wrapped_key TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Access audit log (append-only; every decrypt writes here)
CREATE TABLE IF NOT EXISTS access_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    accessed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    accessor TEXT NOT NULL,
    purpose TEXT NOT NULL,
    record_class TEXT NOT NULL,
    outside_normal_path INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_access_audit_time ON access_audit(accessed_at);

-- Conversation history (agent context across turns — most sensitive data)
CREATE TABLE IF NOT EXISTS conversation_history (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_conversation_time ON conversation_history(created_at);

-- Desires (structured social intentions; raw_text zeroed after parse)
CREATE TABLE IF NOT EXISTS desires (
    id TEXT PRIMARY KEY,
    raw_text TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    activity_type TEXT NOT NULL DEFAULT 'any',
    social_size_min INTEGER NOT NULL DEFAULT 1,
    social_size_max INTEGER NOT NULL DEFAULT 1,
    time_window_start TEXT NOT NULL,
    time_window_end TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'want',
    status TEXT NOT NULL DEFAULT 'pending',
    candidate_strategy TEXT NOT NULL DEFAULT 'any',
    candidate_ids TEXT,
    candidate_tier_min INTEGER,
    recurrence TEXT NOT NULL DEFAULT 'none',
    recurrence_end TEXT,
    horizon TEXT NOT NULL DEFAULT 'one_off',
    parent_desire_id TEXT,
    raw_text_zeroed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_desires_status ON desires(status);

-- coord_desires VIEW — excludes raw_text (coordination layer never sees it)
CREATE VIEW IF NOT EXISTS coord_desires AS
  SELECT id, category, activity_type,
         social_size_min, social_size_max,
         time_window_start, time_window_end,
         priority, status, candidate_strategy, candidate_ids, candidate_tier_min,
         recurrence, horizon, parent_desire_id, created_at
  FROM desires;

-- Desire deletion receipts
CREATE TABLE IF NOT EXISTS desire_deletions (
    id TEXT PRIMARY KEY,
    desire_id TEXT NOT NULL,
    deleted_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    reason TEXT
);

-- Relationships
CREATE TABLE IF NOT EXISTS relationships (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    contact_is_user INTEGER DEFAULT 0,
    nickname TEXT,
    notes TEXT,
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
CREATE INDEX IF NOT EXISTS idx_cadences_relationship ON cadences(relationship_id);

-- Activity history
CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    cadence_id TEXT REFERENCES cadences(id),
    participants TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    venue_name TEXT,
    venue_address TEXT,
    proposed_slots TEXT,
    scheduled_at INTEGER,
    cost_actual REAL,
    fun_score REAL,
    responses TEXT DEFAULT '{}',
    time_choices TEXT DEFAULT '{}',
    notes TEXT,
    status TEXT DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'confirmed', 'completed', 'cancelled')),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_cadence ON activities(cadence_id);

-- Onboarding intents
CREATE TABLE IF NOT EXISTS onboarding_intents (
    id TEXT PRIMARY KEY,
    contact_name TEXT NOT NULL,
    frequency TEXT NOT NULL,
    activity_type TEXT,
    group_size TEXT DEFAULT 'one_on_one',
    confirmed INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Pending actions (stateful SMS conversations)
CREATE TABLE IF NOT EXISTS pending_actions (
    id TEXT PRIMARY KEY,
    action_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_pending_actions_expiry ON pending_actions(expires_at);

-- Budget tracking
CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY,
    period TEXT NOT NULL,
    amount REAL NOT NULL,
    spent REAL DEFAULT 0,
    period_start INTEGER NOT NULL,
    period_end INTEGER NOT NULL
);

-- User preferences
CREATE TABLE IF NOT EXISTS user_preferences (
    id TEXT NOT NULL DEFAULT 'singleton' PRIMARY KEY,
    budget_per_outing REAL,
    dietary_restrictions TEXT DEFAULT '[]',
    food_allergies TEXT DEFAULT '[]',
    cuisine_loves TEXT DEFAULT '[]',
    cuisine_avoids TEXT DEFAULT '[]',
    activity_loves TEXT DEFAULT '[]',
    activity_avoids TEXT DEFAULT '[]',
    vibe TEXT DEFAULT '[]',
    preferred_areas TEXT,
    preferred_times TEXT,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Wallet / ClawBank (stubbed)
CREATE TABLE IF NOT EXISTS user_wallets (
    id TEXT NOT NULL DEFAULT 'singleton' PRIMARY KEY,
    wallet_address TEXT UNIQUE,
    clawbank_account_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Agent-to-agent messages (purged after coordination resolves)
CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    topic TEXT NOT NULL,
    body TEXT NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_processed ON agent_messages(processed, created_at);
