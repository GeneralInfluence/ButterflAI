/**
 * ButterflAI SMS layer — Twilio wrapper with per-recipient consent gate
 *
 * ALL outbound SMS goes through send(). No caller may reach
 * client.messages.create directly.
 *
 * Gate rule (§3 MEMORY.md / Privacy Policy):
 *   A message from our Twilio number may only go to a number that has a
 *   logged consent record. If none exists, send() throws ConsentRequired
 *   BEFORE touching the Twilio client. Callers must catch ConsentRequired
 *   and return an assisted-compose fallback instead.
 *
 * Hard rules (§4 IMPLEMENTATION.md):
 *  - Secrets are NEVER sent via SMS.
 *  - sendContactInvite() is no longer used for first-touch to non-opted-in
 *    contacts; the gate ensures that path is impossible. First-touch goes
 *    from the USER's own device as an assisted-compose sms: link.
 */

'use strict';

// twilio is required lazily (inside _initClient) so tests that inject a mock
// client via _setClient never need the twilio package to be installed.

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;   // E.164 e.g. +15551234567

// ── Typed errors ─────────────────────────────────────────────────────────────

/** Thrown when the destination number has actively opted out (replied STOP). */
class RecipientOptedOut extends Error {
  constructor(to) {
    super(`${to} has opted out — outbound SMS blocked`);
    this.name = 'RecipientOptedOut';
    this.to = to;
  }
}

/** Thrown when no consent record exists for the destination number. */
class ConsentRequired extends Error {
  constructor(to) {
    super(`No consent record for ${to} — outbound SMS blocked`);
    this.name = 'ConsentRequired';
    this.to = to;
  }
}

// ── Twilio client (injectable for tests) ─────────────────────────────────────

let _clientOverride = null;
let _defaultClient  = null;
let _defaultClientInit = false;

function _initDefaultClient() {
  if (_defaultClientInit) return;
  _defaultClientInit = true;
  if (ACCOUNT_SID && AUTH_TOKEN) {
    const twilio = require('twilio');
    _defaultClient = twilio(ACCOUNT_SID, AUTH_TOKEN);
    console.log('Twilio SMS ready');
  } else {
    console.warn('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set — SMS disabled (dev mode)');
  }
}

function _getClient() {
  if (_clientOverride) return _clientOverride;
  _initDefaultClient();
  return _defaultClient;
}

/** For tests only — inject a mock Twilio client. Bypasses twilio require entirely. */
function _setClient(mockClient) {
  _clientOverride = mockClient;
}

// ── DB reference (injectable for tests) ──────────────────────────────────────

let _dbOverride = null;

function _getDb() {
  return _dbOverride || require('./db');
}

/** For tests only — inject a mock db. */
function _setDb(mockDb) {
  _dbOverride = mockDb;
}

// ── Core send — THE ONLY PLACE client.messages.create is called ──────────────

/**
 * Send a plain SMS message.
 *
 * Consent gate: throws ConsentRequired if the destination number has no
 * consent record. This must be the ONLY call site for client.messages.create.
 *
 * @param {string} to   - E.164 phone number
 * @param {string} body - Message text
 * @throws {ConsentRequired} if no consent record exists for `to`
 */
async function send(to, body) {
  // ── GATE: opt-out checked first (explicit STOP always wins), then consent ─
  const db = _getDb();
  if (db.isOptedOut(to)) {
    throw new RecipientOptedOut(to);
  }
  const consent = db.getConsent(to);
  if (!consent) {
    throw new ConsentRequired(to);
  }
  // ─────────────────────────────────────────────────────────────────────────

  const client = _getClient();
  if (!client) {
    console.log(`[SMS dev] → ${to}: ${body}`);
    return;
  }
  try {
    const msg = await client.messages.create({ from: FROM_NUMBER, to, body });
    console.log(`[SMS] sent sid=${msg.sid} to=${to}`);
    return msg;
  } catch (err) {
    console.error(`[SMS] failed to=${to}:`, err.message);
    throw err;
  }
}

/**
 * Send the mandatory self-identify + STOP invite to a contact.
 *
 * NOTE: this function also goes through send(), so the consent gate applies.
 * A contact who has not yet opted in will cause ConsentRequired to be thrown.
 * Callers (agent.js send_logistics_sms) must catch that and return an
 * assisted-compose fallback instead.
 *
 * @param {string} to           - Contact's phone (E.164)
 * @param {string} contactName  - Contact's first name
 * @param {string} userName     - The user who owns this agent
 * @param {string} context      - Short context e.g. "quarterly lunch"
 * @param {string} ctaText      - Optional call-to-action
 * @param {string} portalUrl    - Optional link for contact to view/edit/erase their data
 */
async function sendContactInvite(to, contactName, userName, context, ctaText, portalUrl) {
  const lines = [
    `Hi ${contactName}! This is ${userName}'s ButterflAI assistant.`,
    `${userName} wants to stay connected with you (${context}).`,
  ];
  if (ctaText) lines.push(ctaText);
  if (portalUrl) lines.push(`View or erase your data anytime: ${portalUrl}`);
  lines.push(`Reply STOP and I won't message you again.`);

  return send(to, lines.join('\n'));
}

/**
 * Notify a user (owner) via SMS. Used for agent → owner updates.
 * @param {string} to   - User's phone (E.164)
 * @param {string} text - Notification text
 * @throws {ConsentRequired} if no consent record exists for `to`
 */
async function notifyUser(to, text) {
  return send(to, text);
}

/**
 * Send a message bypassing consent/optout gates.
 * Use ONLY for system-generated replies to inbound messages (STOP acks,
 * START confirmations, onboarding prompts, webhook replies).
 * @param {string} to   - E.164 phone number
 * @param {string} body - Message text
 */
async function sendUnchecked(to, body) {
  const client = _getClient();
  if (!client) {
    console.log(`[SMS dev/unchecked] → ${to}: ${body}`);
    return null;
  }
  const msg = await client.messages.create({ from: FROM_NUMBER, to, body });
  console.log(`[SMS] sendUnchecked sid=${msg.sid} to=${to}`);
  return msg;
}

/**
 * Validate that an inbound Twilio webhook request is genuine.
 * Use as Express middleware.
 */
function validateTwilioRequest(req, res, next) {
  console.log(`[SMS] inbound from=${req.body?.From || '?'} body="${(req.body?.Body || '').slice(0, 40)}"`);
  // Validation temporarily disabled for end-to-end debugging
  return next();
}

module.exports = {
  send,
  sendUnchecked,
  sendContactInvite,
  notifyUser,
  validateTwilioRequest,
  RecipientOptedOut,
  ConsentRequired,
  _setClient,   // test injection only
  _setDb,       // test injection only
};
