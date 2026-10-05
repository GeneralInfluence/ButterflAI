/**
 * anthropic-client.test.js — credential selection for the Anthropic client.
 *
 * Covers: API key precedence, Workload Identity Federation via GitHub Actions
 * and Fly Machine OIDC (end to end against loopback fakes of the identity
 * provider, the token exchange and /v1/messages), misconfiguration, and the
 * no-credentials case never falling through to a local `ant` profile.
 *
 * No real external calls: every endpoint is a local server.
 */

'use strict';

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAnthropicClient, resolveAuth, hasAnthropicCredentials, AUDIENCE } = require('../../anthropic-client');

const FAKE_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';
const FAKE_ACCESS = 'sk-ant-oat01-test-access-token';
const FED = {
  ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
  ANTHROPIC_ORGANIZATION_ID: '00000000-0000-0000-0000-000000000000',
  ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
};

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => resolve(d));
  });
}

describe('resolveAuth', () => {
  test('API key wins, even when federation is also configured', () => {
    assert.equal(resolveAuth({ ANTHROPIC_API_KEY: 'sk-ant-x', ...FED, ANTHROPIC_IDENTITY_TOKEN: FAKE_JWT }).mode, 'api_key');
  });

  test('no credentials at all → none', () => {
    const a = resolveAuth({});
    assert.equal(a.mode, 'none');
    assert.match(a.error, /No Anthropic credentials/);
    assert.equal(hasAnthropicCredentials({}), false);
  });

  test('half-configured federation → none with a clear error', () => {
    const a = resolveAuth({ ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_x' });
    assert.equal(a.mode, 'none');
    assert.match(a.error, /ANTHROPIC_ORGANIZATION_ID/);
  });

  test('federation with no identity token source → none', () => {
    const a = resolveAuth({ ...FED }, { flySocketPath: '/nonexistent/socket' });
    assert.equal(a.mode, 'none');
    assert.match(a.error, /no identity token source/);
  });

  test('token file / inline token → federation:file', () => {
    assert.equal(resolveAuth({ ...FED, ANTHROPIC_IDENTITY_TOKEN_FILE: '/tmp/x' }).mode, 'federation:file');
    assert.equal(resolveAuth({ ...FED, ANTHROPIC_IDENTITY_TOKEN: FAKE_JWT }).mode, 'federation:file');
  });

  test('GitHub Actions OIDC env → federation:github', () => {
    const env = { ...FED, ACTIONS_ID_TOKEN_REQUEST_URL: 'http://x/?a=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't' };
    assert.equal(resolveAuth(env).mode, 'federation:github');
  });

  test('Fly is only selected when the machine socket exists', () => {
    assert.equal(resolveAuth({ ...FED, FLY_APP_NAME: 'butterflai' }, { flySocketPath: '/nonexistent/socket' }).mode, 'none');
  });
});

describe('createAnthropicClient — no credentials', () => {
  test('calls fail with our error instead of resolving a local profile', async () => {
    const client = createAnthropicClient({});
    await assert.rejects(
      client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      /No Anthropic credentials/,
    );
  });
});

describe('createAnthropicClient — federation end to end (loopback fakes)', () => {
  let server, baseURL, sockDir, sockServer, sockPath;
  const seen = { ghAuth: null, ghAudience: null, exchange: null, messagesAuth: null, flyAud: null };

  before(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/gh-token') {
        seen.ghAuth = req.headers.authorization;
        seen.ghAudience = url.searchParams.get('audience');
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ value: FAKE_JWT }));
      }
      if (url.pathname === '/v1/oauth/token') {
        seen.exchange = JSON.parse(await readBody(req));
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ access_token: FAKE_ACCESS, expires_in: 600, token_type: 'Bearer' }));
      }
      if (url.pathname === '/v1/messages') {
        await readBody(req);
        seen.messagesAuth = req.headers.authorization;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({
          id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
      }
      res.statusCode = 404; res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseURL = `http://127.0.0.1:${server.address().port}`;

    // Fake Fly Machines API socket.
    sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-sock-'));
    sockPath = path.join(sockDir, 'api.sock');
    sockServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/tokens/oidc') {
        seen.flyAud = JSON.parse(await readBody(req)).aud;
        return res.end(FAKE_JWT);
      }
      res.statusCode = 404; res.end();
    });
    await new Promise((r) => sockServer.listen(sockPath, r));
  });

  after(() => {
    server.close();
    sockServer.close();
    fs.rmSync(sockDir, { recursive: true, force: true });
  });

  async function ping(client) {
    const msg = await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    return msg.content[0].text;
  }

  test('GitHub Actions: fetches OIDC token, exchanges it, sends Bearer token', async () => {
    const env = {
      ...FED,
      ANTHROPIC_BASE_URL: baseURL,
      ACTIONS_ID_TOKEN_REQUEST_URL: `${baseURL}/gh-token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh-request-token',
    };
    assert.equal(await ping(createAnthropicClient(env)), 'pong');
    assert.equal(seen.ghAuth, 'Bearer gh-request-token');
    assert.equal(seen.ghAudience, AUDIENCE);
    assert.equal(seen.exchange.grant_type, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(seen.exchange.assertion, FAKE_JWT);
    assert.equal(seen.exchange.federation_rule_id, 'fdrl_test');
    assert.equal(seen.exchange.organization_id, FED.ANTHROPIC_ORGANIZATION_ID);
    assert.equal(seen.exchange.service_account_id, 'svac_test');
    assert.equal(seen.messagesAuth, `Bearer ${FAKE_ACCESS}`);
  });

  test('Fly Machine: fetches OIDC token over the socket with our audience', async () => {
    seen.exchange = null; seen.messagesAuth = null;
    const env = { ...FED, ANTHROPIC_BASE_URL: baseURL, FLY_APP_NAME: 'butterflai' };
    const client = createAnthropicClient(env, { flySocketPath: sockPath });
    assert.equal(await ping(client), 'pong');
    assert.equal(seen.flyAud, AUDIENCE);
    assert.equal(seen.exchange.assertion, FAKE_JWT);
    assert.equal(seen.messagesAuth, `Bearer ${FAKE_ACCESS}`);
  });
});

describe('model defaults', () => {
  test('DEFAULT_MODEL is a current model, not a retired claude-3 id', () => {
    const { DEFAULT_MODEL } = require('../../anthropic-client');
    assert.doesNotMatch(DEFAULT_MODEL, /^claude-3/);
  });

  // Regression: desires.js defaulted to claude-3-5-haiku-20241022, which 404s.
  // App code must take its fallback from DEFAULT_MODEL, never hardcode one.
  test('no app module hardcodes a retired claude-3 model id', () => {
    const webDir = path.join(__dirname, '..', '..');
    const offenders = fs.readdirSync(webDir)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /['"]claude-3[^'"]*['"]/.test(
        // ignore comments that mention the old id as a warning
        fs.readFileSync(path.join(webDir, f), 'utf8').replace(/\/\/.*$/gm, '')));
    assert.deepEqual(offenders, []);
  });
});
