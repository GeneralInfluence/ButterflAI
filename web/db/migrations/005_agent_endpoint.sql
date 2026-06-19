-- Migration 005: agent_endpoint on users
-- Each ButterflAI user has an MCP agent endpoint (their agent's public identifier).
-- The coordination loop uses this to find peer agents to probe.
-- Set at onboarding or when the user's agent registers itself.
ALTER TABLE users ADD COLUMN agent_endpoint TEXT;
