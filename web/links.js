/**
 * links.js — the app's real links, and a code-level check that the agent never sends
 * a made-up one.
 *
 * 2026-10-09: helping Melanie log back in, the agent sent "butterflai.app/login",
 * "app.butterflai.com/login", "butterflai.social/login" (wrong page) and a literal
 * "[ButterflAI login]" placeholder; it also told Sean "butterfly.com". The model was
 * never given the real links, and nothing checked. Now:
 *  - LINKS are the only ButterflAI links; they're put in the system prompt verbatim
 *  - checkOutbound(): a message to another person with a wrong ButterflAI address or a
 *    "[…]" placeholder is refused before sending, with the right links in the error
 *  - fixReply(): wrong ButterflAI addresses in replies to the user are corrected
 */

'use strict';

const BASE = (process.env.BASE_URL || 'https://butterflai.social').replace(/\/+$/, '');
const HOST = new URL(BASE).host;

const LINKS = {
  login: `${BASE}/app/login`,
  app: `${BASE}/app`,
  chat: `${BASE}/app/chat`,
  settings: `${BASE}/app/settings`,
  events: `${BASE}/app/events`,
  contacts: `${BASE}/app/contacts`,
};

// Real top-level paths. Anything else on our host is a guess.
const REAL_PATHS = /^\/(?:$|app(?:\/|$)|join(?:\/|$|\?)|invite\/|r\/|event\/|auth\/|portal|contacts-import|privacy|terms)/;

// Any address that looks like ours: butterflai.social, butterflai.app, app.butterflai.com,
// butterfly.com, www.butterflai.ai/…  (with or without scheme)
const OUR_ADDRESS = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)*butterfl(?:ai|y)\.[a-z]{2,})(\/[^\s)<>"']*)?/gi;
const PLACEHOLDER = /\[[^\]\n]{1,60}\](?!\()/;

function linksForPrompt() {
  return `APP LINKS — use these exact links, never make one up: log in ${LINKS.login} · the app ${LINKS.app} · chat ${LINKS.chat} · settings ${LINKS.settings}. Never use placeholders like "[login link]".`;
}

function badAddresses(text) {
  const bad = [];
  for (const m of String(text || '').matchAll(OUR_ADDRESS)) {
    const host = m[1].toLowerCase();
    const path = (m[2] || '/').replace(/[.,!?;:]+$/, '');
    if (host !== HOST || !REAL_PATHS.test(path)) bad.push(m[0].replace(/[.,!?;:]+$/, ''));
  }
  return bad;
}

/** Check a message going to someone else. { ok } or { ok:false, error, message }. */
function checkOutbound(text) {
  const t = String(text || '');
  if (PLACEHOLDER.test(t)) {
    return { ok: false, error: 'PLACEHOLDER_IN_MESSAGE', action_status: 'NOT_SENT',
      message: `The message contains a placeholder (${t.match(PLACEHOLDER)[0]}) — put the real thing in. ${linksForPrompt()}` };
  }
  const bad = badAddresses(t);
  if (bad.length) {
    return { ok: false, error: 'WRONG_LINK', action_status: 'NOT_SENT',
      message: `${bad.join(', ')} is not a real ButterflAI link. ${linksForPrompt()}` };
  }
  return { ok: true };
}

/** Correct wrong ButterflAI addresses in a reply to the user. */
function fixReply(text) {
  return String(text || '').replace(OUR_ADDRESS, (whole, host, path = '') => {
    const p = path.replace(/[.,!?;:]+$/, '');
    const trailing = path.slice(p.length);
    if (host.toLowerCase() === HOST && REAL_PATHS.test(p || '/')) return whole;
    if (/^\/(?:log-?in|signin|sign-in)\b/i.test(p)) return LINKS.login + trailing;
    if (REAL_PATHS.test(p || '/')) return `${BASE}${p}${trailing}`;
    return LINKS.app + trailing;
  });
}

module.exports = { LINKS, HOST, linksForPrompt, checkOutbound, fixReply, badAddresses };
