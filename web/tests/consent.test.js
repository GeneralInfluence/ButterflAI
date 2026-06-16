/**
 * Consent gate tests
 *
 * Verifies that sms.send():
 *   1. Throws ConsentRequired and NEVER calls client.messages.create
 *      when the destination number has no consent record.
 *   2. Calls client.messages.create exactly once when a consent record exists.
 *
 * Uses:
 *   - Node built-in test runner (node:test) — no extra deps needed
 *   - Plain-JS mock DB (no SQLite needed in this environment)
 *   - Mock Twilio client
 */

'use strict';

process.env.DB_PATH   = ':memory:';  // prevent db.js from touching disk
process.env.NODE_ENV  = 'test';
// Unset Twilio creds so the module doesn't try to init the real client
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// Load sms module AFTER clearing env so no real Twilio client is created
const { send, ConsentRequired, _setDb, _setClient } = require('../sms');

// ── Plain-JS mock DB ──────────────────────────────────────────────────────────

function makeTestDb() {
  const store = new Map(); // phone → consent record

  return {
    getConsent(phone) {
      return store.get(phone) || undefined;
    },
    writeConsent(phone, source, version = '1.0') {
      store.set(phone, {
        id: store.size + 1,
        phone,
        consent_source: source,
        consented_at: Math.floor(Date.now() / 1000),
        disclosure_version: version,
      });
    },
    isOptedOut() { return false; },
  };
}

// ── Mock Twilio client ────────────────────────────────────────────────────────

function makeMockClient() {
  const calls = [];
  return {
    calls,
    messages: {
      create(params) {
        calls.push(params);
        return Promise.resolve({ sid: 'SM_MOCK_' + calls.length });
      },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('send() with NO consent record → throws ConsentRequired, create never called', async () => {
  const mockDb     = makeTestDb();
  const mockClient = makeMockClient();
  _setDb(mockDb);
  _setClient(mockClient);

  const noConsentPhone = '+15550000001';

  await assert.rejects(
    () => send(noConsentPhone, 'Hello!'),
    (err) => {
      assert.ok(
        err instanceof ConsentRequired,
        `Expected ConsentRequired, got ${err.constructor.name}: ${err.message}`
      );
      assert.equal(err.to, noConsentPhone,
        `err.to should be ${noConsentPhone}, got ${err.to}`);
      return true;
    }
  );

  assert.equal(
    mockClient.calls.length, 0,
    `client.messages.create should NEVER be called — was called ${mockClient.calls.length} time(s)`
  );
});

test('send() WITH a consent record → calls create exactly once', async () => {
  const mockDb     = makeTestDb();
  const mockClient = makeMockClient();
  _setDb(mockDb);
  _setClient(mockClient);

  const consentedPhone = '+15550000002';
  mockDb.writeConsent(consentedPhone, 'SELF_START');

  await send(consentedPhone, 'Hello!');

  assert.equal(
    mockClient.calls.length, 1,
    `client.messages.create should be called exactly once — was called ${mockClient.calls.length} time(s)`
  );
  assert.equal(
    mockClient.calls[0].to, consentedPhone,
    `create() should target ${consentedPhone}, got ${mockClient.calls[0]?.to}`
  );
});
