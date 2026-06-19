-- Migration 003: Desire coordination tables
--
-- coordination_sessions: one session per desire × coordination attempt
-- coord_session_peers:   one row per peer agent involved in a session
-- desires:               structured desires parsed from user input
--
-- Privacy notes:
--   - raw_text is in the desires table but NEVER read by coordination.js
--   - coord_session_peers stores only availability data received from peers
--     (available_days, offered_windows) — not their reasons or preferences
--   - purge_after enforces hard deletion after the event

CREATE TABLE IF NOT EXISTS desires (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  raw_text        TEXT NOT NULL,          -- private, never read by coord layer
  category        TEXT NOT NULL,          -- enum: social | active | dining | ...
  activity_type   TEXT NOT NULL DEFAULT 'any',
  social_size_min INTEGER NOT NULL DEFAULT 1,
  social_size_max INTEGER NOT NULL DEFAULT 1,
  time_window_start TEXT NOT NULL,        -- YYYY-MM-DD
  time_window_end   TEXT NOT NULL,        -- YYYY-MM-DD
  priority        TEXT NOT NULL DEFAULT 'want',  -- must | want | nice_to_have
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | negotiating | scheduled | done | dropped
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- The coordination layer ONLY queries this view — raw_text is excluded
CREATE VIEW IF NOT EXISTS coord_desires AS
  SELECT id, user_id, category, activity_type,
         social_size_min, social_size_max,
         time_window_start, time_window_end,
         priority, status, created_at
  FROM desires;

CREATE TABLE IF NOT EXISTS coordination_sessions (
  id                    TEXT PRIMARY KEY,  -- UUID
  desire_id             TEXT NOT NULL,
  initiator_user_id     TEXT NOT NULL,
  role                  TEXT NOT NULL DEFAULT 'initiator',  -- initiator | responder
  state                 TEXT NOT NULL DEFAULT 'pending',
  -- States: pending | probing | availability | proposed | pending_human_ok
  --         | scheduled | escalate_human | dropped | cancelled
  round                 INTEGER NOT NULL DEFAULT 0,
  agreed_slot_start     TEXT,             -- ISO when confirmed
  agreed_slot_duration  INTEGER,          -- minutes
  agreed_activity       TEXT,             -- enum value
  escalation_reason     TEXT,             -- internal only, never sent to peers
  expires_at            TEXT NOT NULL,    -- ISO
  purge_after           TEXT NOT NULL,    -- event_date + 7 days, hard delete after this
  created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at            INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS coord_session_peers (
  id                  TEXT PRIMARY KEY,   -- UUID
  session_id          TEXT NOT NULL REFERENCES coordination_sessions(id),
  peer_agent_id       TEXT NOT NULL,      -- MCP public key of the other agent
  peer_user_id        TEXT,               -- if known (for consent checking)
  state               TEXT NOT NULL DEFAULT 'probing',
  -- States: probing | interested | not_interested | windows_sent | windows_received
  --         | proposed | confirmed | counter | rejected | cancelled
  available_days      TEXT,               -- JSON: ["thu","fri"] — from their interest response
  offered_windows     TEXT,               -- JSON: [{day,period,earliest,latest}] — their windows
  matched_windows     TEXT,               -- JSON: intersection computed locally
  proposed_slot_start TEXT,              -- ISO
  proposed_slot_dur   INTEGER,           -- minutes
  rounds_used         INTEGER NOT NULL DEFAULT 0,
  last_msg_at         INTEGER,
  created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Received ambient signals from peer agents
CREATE TABLE IF NOT EXISTS ambient_signals (
  id            TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  category      TEXT NOT NULL,
  area          TEXT,                  -- neighborhood slug or null
  date          TEXT NOT NULL,         -- YYYY-MM-DD
  period        TEXT NOT NULL,         -- enum
  certainty     TEXT NOT NULL,         -- enum
  open_to_company INTEGER NOT NULL DEFAULT 1,  -- boolean
  expires_at    TEXT NOT NULL,         -- end of day by default
  received_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
