'use strict';

/**
 * sensitive-store-encrypted.test.js — Phase 0.4 debt guardrail.
 *
 * The full crypto unification (re-keying user_private_data onto the KMS-wrapped
 * per-record scheme) is deferred to Phase 2, where the enclave re-keys all private
 * data anyway (docs/REARCHITECTURE.md Phase 2 item 10). Until then, this pins the one
 * thing that must not regress: the sensitive store persists ONLY ciphertext — the
 * plaintext must never appear in any stored column. Catches an accidental downgrade to
 * plaintext (or a broken cipher) while the store still uses the weaker single key.
 *
 * Run: DB_PATH=:memory: JWT_SECRET=test node --test tests/unit/sensitive-store-encrypted.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';

const db = require('../../db');
const sensitive = require('../../sensitive');

const USER = 'user-sens-1';
const KEY = 'health.sti_status';
const SECRET = 'UNIQUE_PLAINTEXT_MARKER_positive_result_do_not_leak';

describe('sensitive store persists only ciphertext', () => {

  test('no stored column contains the plaintext', () => {
    sensitive.storePrivateData(USER, KEY, SECRET, 'HEALTH');
    const row = db._raw()
      .prepare('SELECT encrypted_v, iv, auth_tag FROM user_private_data WHERE user_id = ? AND data_key = ?')
      .get(USER, KEY);
    assert.ok(row, 'row must exist');
    for (const col of ['encrypted_v', 'iv', 'auth_tag']) {
      assert.ok(
        !String(row[col]).includes(SECRET) && !String(row[col]).includes('positive_result'),
        `${col} must not contain plaintext`
      );
    }
  });

  test('owner can still decrypt it back', () => {
    const back = sensitive.readPrivateData(USER, KEY, 'test read');
    assert.strictEqual(back, SECRET);
  });
});
