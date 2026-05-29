/**
 * ButterflAI SMS layer — Twilio wrapper
 *
 * All outbound SMS goes through here.
 * Hard rules (§3 IMPLEMENTATION.md):
 *  - Every first-contact outbound MUST call sendContactInvite() which includes the self-identify header.
 *  - STOP is handled in server.js before anything else; never message an opted-out number.
 *  - Secrets (keys, recovery phrases) are NEVER sent via SMS.
 */

'use strict';

const twilio = require('twilio');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;   // E.164 e.g. +15551234567

let client;
if (ACCOUNT_SID && AUTH_TOKEN) {
  client = twilio(ACCOUNT_SID, AUTH_TOKEN);
  console.log('Twilio SMS ready');
} else {
  console.warn('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set — SMS disabled (dev mode)');
}

/**
 * Send a plain SMS message.
 * @param {string} to   - E.164 phone number
 * @param {string} body - Message text
 */
async function send(to, body) {
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
 * This MUST be used for every first outbound message to a non-consenting party.
 *
 * Shape (§4.2): "Hi {contactName}! This is {userName}'s ButterflAI assistant.
 *   {userName} wants to stay connected with you ({context}).
 *   {ctaText}
 *   Reply STOP and I won't message you again."
 *
 * @param {string} to           - Contact's phone (E.164)
 * @param {string} contactName  - Contact's first name
 * @param {string} userName     - The user who owns this agent
 * @param {string} context      - Short context e.g. "quarterly lunch"
 * @param {string} ctaText      - Optional call-to-action e.g. "Set up your own ButterflAI: https://…"
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
 */
async function notifyUser(to, text) {
  return send(to, text);
}

/**
 * Validate that an inbound Twilio webhook request is genuine.
 * Use as Express middleware.
 */
function validateTwilioRequest(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next(); // skip in dev

  const twilioSignature = req.headers['x-twilio-signature'];
  const url = process.env.BASE_URL + req.originalUrl;
  const params = req.body;

  const valid = twilio.validateRequest(AUTH_TOKEN, twilioSignature, url, params);
  if (!valid) {
    console.warn(`[SMS] Invalid Twilio signature — rejected. BASE_URL="${process.env.BASE_URL}" reconstructed_url="${url}"`);
    return res.status(403).send('Forbidden');
  }
  next();
}

module.exports = { send, sendContactInvite, notifyUser, validateTwilioRequest };
