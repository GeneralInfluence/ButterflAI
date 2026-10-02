/**
 * anthropic-client.js — the one place the Anthropic client is constructed.
 *
 * Two credential sources, in this order:
 *   1. ANTHROPIC_API_KEY — local dev, the simulator, and prod until the
 *      federation cutover. Always wins when set (matches SDK precedence).
 *   2. Workload Identity Federation — short-lived tokens, no stored key.
 *      Requires ANTHROPIC_FEDERATION_RULE_ID + ANTHROPIC_ORGANIZATION_ID
 *      (ANTHROPIC_SERVICE_ACCOUNT_ID / ANTHROPIC_WORKSPACE_ID optional) plus an
 *      identity-token source, checked in order:
 *        - ANTHROPIC_IDENTITY_TOKEN_FILE / ANTHROPIC_IDENTITY_TOKEN
 *        - GitHub Actions OIDC (ACTIONS_ID_TOKEN_REQUEST_URL, nightly eval)
 *        - Fly Machine OIDC (FLY_APP_NAME + the /.fly/api socket, prod)
 *
 * Nothing else. The SDK's implicit fallback to a local `ant` profile is
 * disabled on purpose: tests and keyless environments must never pick up a
 * developer's login and make real, billed calls.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const { oidcFederationProvider } = require('@anthropic-ai/sdk/lib/credentials/oidc-federation');
const { identityTokenFromFile, identityTokenFromValue } = require('@anthropic-ai/sdk/lib/credentials/identity-token');

// The `aud` claim requested from every identity provider. Federation rules in
// the Claude Console must match this exact value.
const AUDIENCE = 'https://api.anthropic.com';
const DEFAULT_FLY_SOCKET = '/.fly/api';

function looksLikeJwt(s) {
  return typeof s === 'string' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(s);
}

// Fly Machines mint OIDC tokens over a local unix socket. Each call returns a
// fresh token (15-minute lifetime), so jti replay protection is never tripped.
function flyIdentityToken(socketPath) {
  return () => new Promise((resolve, reject) => {
    const body = JSON.stringify({ aud: AUDIENCE });
    const req = http.request({
      socketPath,
      path: '/v1/tokens/oidc',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 10_000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        const token = data.trim();
        if (res.statusCode !== 200) return reject(new Error(`Fly OIDC token request failed: HTTP ${res.statusCode}`));
        // Never echo the response — it would be a credential.
        if (!looksLikeJwt(token)) return reject(new Error('Fly OIDC token request returned something that is not a JWT'));
        resolve(token);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Fly OIDC token request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

// GitHub Actions OIDC. The request URL stays valid for the whole job, so we
// fetch a fresh token on every exchange instead of writing it to a file.
function githubIdentityToken(env) {
  return async () => {
    const url = `${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(AUDIENCE)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
    if (!res.ok) throw new Error(`GitHub OIDC token request failed: HTTP ${res.status}`);
    const { value } = await res.json();
    if (!looksLikeJwt(value)) throw new Error('GitHub OIDC token request returned something that is not a JWT');
    return value;
  };
}

/**
 * Decide which credential source applies. Pure apart from one existsSync for
 * the Fly socket. Returns { mode, identityTokenProvider?, error? } where mode is
 * 'api_key' | 'federation:file' | 'federation:github' | 'federation:fly' | 'none'.
 */
function resolveAuth(env = process.env, { flySocketPath = DEFAULT_FLY_SOCKET } = {}) {
  if (env.ANTHROPIC_API_KEY) return { mode: 'api_key' };

  const wantsFederation = env.ANTHROPIC_FEDERATION_RULE_ID || env.ANTHROPIC_ORGANIZATION_ID;
  if (!wantsFederation) return { mode: 'none', error: 'No Anthropic credentials configured (set ANTHROPIC_API_KEY or the ANTHROPIC_FEDERATION_* variables)' };
  if (!env.ANTHROPIC_FEDERATION_RULE_ID || !env.ANTHROPIC_ORGANIZATION_ID) {
    return { mode: 'none', error: 'Workload identity federation needs both ANTHROPIC_FEDERATION_RULE_ID and ANTHROPIC_ORGANIZATION_ID' };
  }

  if (env.ANTHROPIC_IDENTITY_TOKEN_FILE) {
    return { mode: 'federation:file', identityTokenProvider: identityTokenFromFile(env.ANTHROPIC_IDENTITY_TOKEN_FILE) };
  }
  if (env.ANTHROPIC_IDENTITY_TOKEN) {
    return { mode: 'federation:file', identityTokenProvider: identityTokenFromValue(env.ANTHROPIC_IDENTITY_TOKEN) };
  }
  if (env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return { mode: 'federation:github', identityTokenProvider: githubIdentityToken(env) };
  }
  if (env.FLY_APP_NAME && fs.existsSync(flySocketPath)) {
    return { mode: 'federation:fly', identityTokenProvider: flyIdentityToken(flySocketPath) };
  }
  return { mode: 'none', error: 'Workload identity federation is configured but no identity token source was found (token file, GitHub Actions OIDC, or Fly Machine OIDC)' };
}

function createAnthropicClient(env = process.env, opts = {}) {
  const auth = resolveAuth(env, opts);
  const baseURL = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

  if (auth.mode === 'api_key') return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL });

  if (auth.mode.startsWith('federation:')) {
    return new Anthropic({
      baseURL,
      apiKey: null,      // explicit null: don't let the SDK re-read env keys
      authToken: null,
      credentials: oidcFederationProvider({
        identityTokenProvider: auth.identityTokenProvider,
        federationRuleId: env.ANTHROPIC_FEDERATION_RULE_ID,
        organizationId: env.ANTHROPIC_ORGANIZATION_ID,
        serviceAccountId: env.ANTHROPIC_SERVICE_ACCOUNT_ID || undefined,
        workspaceId: env.ANTHROPIC_WORKSPACE_ID || undefined,
        baseURL,
        fetch,
      }),
    });
  }

  // No credentials: an explicit provider that always fails, so the SDK never
  // falls through to a local profile. Calls fail at request time, as before.
  return new Anthropic({
    baseURL,
    apiKey: null,
    authToken: null,
    credentials: async () => { throw new Error(auth.error); },
  });
}

function hasAnthropicCredentials(env = process.env, opts = {}) {
  return resolveAuth(env, opts).mode !== 'none';
}

module.exports = { createAnthropicClient, resolveAuth, hasAnthropicCredentials, AUDIENCE };
