'use strict';

/**
 * mcp-transport.js — HTTP-based agent-to-agent transport
 *
 * The "MCP transport" is the channel by which ButterflAI agents exchange
 * coordination messages. Each ButterflAI user has an `agent_endpoint` stored in
 * the users table — the HTTPS URL of their agent's inbound MCP handler.
 *
 * Protocol
 * --------
 *   POST {agent_endpoint}/mcp/inbound
 *   Content-Type: application/json
 *   X-ButterflAI-Sig: HMAC-SHA256(secret, JSON.stringify(body))
 *   Body: the full MCP message envelope (see mcp-messages.js)
 *
 * Authentication
 * --------------
 * Each outbound message is signed with a shared HMAC key (`MCP_SHARED_SECRET`
 * env var). Both sides use the same secret during early development.
 * Before public launch: rotate to per-peer keypairs stored in user records.
 *
 * Timeouts + retries
 * ------------------
 * Single attempt, 10-second timeout. Coordination messages are best-effort:
 * if the peer is down, the session will timeout via TTL rather than crashing.
 * The coord-loop tick will notice the session is stale and escalate to human.
 *
 * Inbound handler
 * ---------------
 * `handleInboundRequest(req, res, deps)` is mounted by server.js at
 * POST /mcp/inbound. It verifies the HMAC signature, routes the message to
 * coordination.js, and returns 200 on success.
 *
 * AGENT_ID
 * --------
 * The `from_agent` field in every outbound message must be a stable agent ID.
 * Set via `AGENT_ID` env var (default: 'butterflai-default').
 */

const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const { URL } = require('url');
const coord   = require('./coordination');

const AGENT_ID      = process.env.AGENT_ID         || 'butterflai-default';
const MCP_SECRET    = process.env.MCP_SHARED_SECRET || '';
const SEND_TIMEOUT  = parseInt(process.env.MCP_SEND_TIMEOUT_MS || '10000', 10);

// ─── Signature helpers ────────────────────────────────────────────────────────

function sign(body) {
  if (!MCP_SECRET) return '';
  return crypto.createHmac('sha256', MCP_SECRET).update(body).digest('hex');
}

function verifySignature(body, sig) {
  if (!MCP_SECRET) {
    // No secret configured: accept in dev, warn
    console.warn('[mcp] MCP_SHARED_SECRET not set — skipping inbound verification');
    return true;
  }
  const expected = sign(body);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// ─── Outbound send ────────────────────────────────────────────────────────────

/**
 * Send a coordination message to a peer agent.
 *
 * @param {string} toAgentEndpoint  Full HTTPS URL, e.g. "https://peerapp.fly.dev"
 * @param {object} message          Full MCP envelope (from mcp-messages builders)
 * @returns {Promise<void>}         Resolves on 2xx, rejects on error or non-2xx
 */
function send(toAgentEndpoint, message) {
  return new Promise((resolve, reject) => {
    let targetUrl;
    try {
      targetUrl = new URL('/mcp/inbound', toAgentEndpoint);
    } catch (err) {
      return reject(new Error(`[mcp] invalid agent endpoint: ${toAgentEndpoint} — ${err.message}`));
    }

    const body    = JSON.stringify(message);
    const sig     = sign(body);
    const isHttps = targetUrl.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const options = {
      hostname: targetUrl.hostname,
      port:     targetUrl.port || (isHttps ? 443 : 80),
      path:     targetUrl.pathname,
      method:   'POST',
      headers: {
        'Content-Type':       'application/json',
        'Content-Length':     Buffer.byteLength(body),
        'X-ButterflAI-Sig':   sig,
        'X-ButterflAI-Agent': AGENT_ID
      }
    };

    const req = lib.request(options, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`[mcp] peer returned ${res.statusCode} for ${targetUrl.href}`));
      }
      res.resume();  // drain body to free socket
    });

    req.setTimeout(SEND_TIMEOUT, () => {
      req.destroy(new Error(`[mcp] send timeout after ${SEND_TIMEOUT}ms to ${toAgentEndpoint}`));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Transport object (matches stubTransport interface) ───────────────────────

/**
 * Transport that sends to `agent_endpoint` stored in the users table.
 * The `toAgent` parameter passed by coordination.js is the `agent_endpoint` URL.
 *
 * Usage:
 *   const { mcpTransport } = require('./mcp-transport');
 *   startCoordLoop({ transport: mcpTransport });
 */
const mcpTransport = {
  send(toAgentEndpoint, message) {
    // Fire-and-forget — coord-loop treats transport as best-effort
    send(toAgentEndpoint, message).catch((err) => {
      console.error(`[mcp] send failed to ${toAgentEndpoint}: ${err.message}`);
    });
  }
};

// ─── Inbound handler (mounted by server.js) ───────────────────────────────────

/**
 * Express middleware for POST /mcp/inbound.
 *
 * Verifies signature, validates the envelope shape, then delegates to
 * coordination.js handleInbound().
 *
 * `deps` is the same dependency object coordination.js expects:
 *   { getWindows, notifyUser, checkConsent }
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {object}                     deps
 */
async function handleInboundRequest(req, res, deps) {
  // Re-serialize body so we can verify the signature
  const raw = JSON.stringify(req.body);
  const sig  = req.headers['x-butterflai-sig'] || '';

  if (!verifySignature(raw, sig)) {
    console.warn('[mcp] rejected inbound — bad signature from', req.headers['x-butterflai-agent']);
    return res.status(403).json({ error: 'invalid signature' });
  }

  const message = req.body;

  // Basic envelope validation
  if (message.protocol !== 'butterflai-coord/1.0') {
    return res.status(400).json({ error: 'unsupported protocol' });
  }

  const validTypes = ['probe', 'interest', 'availability', 'proposal', 'confirm',
                      'counter', 'reject', 'cancel', 'ambient_intent', 'ambient_cancel'];
  if (!validTypes.includes(message.message_type)) {
    return res.status(400).json({ error: 'unknown message_type' });
  }

  // Check TTL — reject expired messages
  if (message.expires_at && new Date(message.expires_at) < new Date()) {
    console.warn('[mcp] rejected expired message type=%s session=%s', message.message_type, message.session_id);
    return res.status(400).json({ error: 'message expired' });
  }

  console.log(`[mcp] ← ${message.message_type} from=${message.from_agent?.slice(0, 20)}… session=${message.session_id?.slice(0, 8)}…`);

  try {
    await coord.handleInbound(mcpTransport, message, deps);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[mcp] handleInbound error:', err.message);
    return res.status(500).json({ error: 'internal error' });
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  mcpTransport,
  handleInboundRequest,
  // Exported for testing
  sign,
  verifySignature,
  send
};
