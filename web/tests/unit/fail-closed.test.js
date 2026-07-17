'use strict';

/**
 * fail-closed.test.js — secrets must fail closed, never fall back to a public default.
 *
 * docs/REARCHITECTURE.md Phase 0:
 *  - sensitive.js encryption key: removed the hardcoded 'dev-insecure-key' default. If
 *    neither ENCRYPTION_KEY nor JWT_SECRET is set, encrypt/decrypt must THROW rather than
 *    silently encrypt real data under a constant.
 *  - mcp-transport.js: an unsigned inbound agent message must be REJECTED in production
 *    when MCP_SHARED_SECRET is unset (was: accepted with a warning).
 *
 * Run: DB_PATH=:memory: node --test tests/unit/fail-closed.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

process.env.DB_PATH  = ':memory:';
process.env.NODE_ENV = 'test';

// Helper: run fn with a patched env, always restoring the original values.
function withEnv(patch, fn) {
  const keys = Object.keys(patch);
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) {
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try { return fn(); }
  finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('sensitive.js encryption key fails closed', () => {
  const sensitive = require('../../sensitive');

  test('throws when neither ENCRYPTION_KEY nor JWT_SECRET is set', () => {
    withEnv({ ENCRYPTION_KEY: undefined, JWT_SECRET: undefined }, () => {
      assert.throws(() => sensitive.encrypt('top secret'), /Refusing to run/);
    });
  });

  test('works (round-trips) with a dedicated ENCRYPTION_KEY', () => {
    withEnv({ ENCRYPTION_KEY: 'x'.repeat(40), JWT_SECRET: undefined }, () => {
      const e = sensitive.encrypt('top secret');
      assert.strictEqual(sensitive.decrypt(e.encrypted_v, e.iv, e.auth_tag), 'top secret');
    });
  });

  test('still falls back to JWT_SECRET (existing data stays decryptable)', () => {
    withEnv({ ENCRYPTION_KEY: undefined, JWT_SECRET: 'legacy-jwt-secret' }, () => {
      const e = sensitive.encrypt('top secret');
      assert.strictEqual(sensitive.decrypt(e.encrypted_v, e.iv, e.auth_tag), 'top secret');
    });
  });
});

describe('mcp-transport verifySignature fails closed', () => {
  // MCP_SHARED_SECRET is read at module load; require it here with the secret unset.
  const { verifySignature } = withEnv({ MCP_SHARED_SECRET: undefined }, () => require('../../mcp-transport'));

  test('rejects unsigned inbound in production when no shared secret', () => {
    withEnv({ NODE_ENV: 'production' }, () => {
      assert.strictEqual(verifySignature('{"x":1}', ''), false);
    });
  });

  test('stays lenient outside production (dev/test)', () => {
    withEnv({ NODE_ENV: 'test' }, () => {
      assert.strictEqual(verifySignature('{"x":1}', ''), true);
    });
  });
});
