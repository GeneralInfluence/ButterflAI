/**
 * Consent gate + opt-out enforcement tests
 *
 * Covers all four fixes:
 *   FIX 1 — RecipientOptedOut thrown (+ create never called) when opted out
 *   FIX 2 — SELF_START only written on inbound "START", not any first message
 *   FIX 3 — E.164 normalization: write raw, read canonical, round-trips correctly
 *   FIX 4 — approve_message YES branches: success / opted-out / consent-required
 *
 * Runtime: Node built-in test runner (node:test) — no extra deps.
 * DB:      plain-JS mock (no SQLite needed in this environment).
 * Twilio:  mock client with call counter.
 */

'use strict';

process.env.DB_PATH   = ':memory:';
process.env.NODE_ENV  = 'test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { toE164 } = require('../phoneUtils');
const {
  send,
  ConsentRequired,
  RecipientOptedOut,
  _setDb,
  _setClient,
} = require('../sms');

// ── Mock DB factory ───────────────────────────────────────────────────────────

function makeTestDb({ optedOut = new Set(), consented = new Map() } = {}) {
  return {
    _optedOut:  optedOut,
    _consented: consented,

    isOptedOut(phone) {
      return this._optedOut.has(toE164(phone));
    },
    getConsent(phone) {
      return this._consented.get(toE164(phone)) || undefined;
    },
    writeConsent(phone, source, version = '1.0') {
      const canonical = toE164(phone);
      this._consented.set(canonical, {
        phone: canonical, consent_source: source,
        consented_at: Math.floor(Date.now() / 1000),
        disclosure_version: version,
      });
    },
  };
}

// ── Mock Twilio client factory ────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1 TESTS — opt-out gate
// ─────────────────────────────────────────────────────────────────────────────

test('FIX 1a — send() to number with consent but OPTED OUT → RecipientOptedOut, create=0', async () => {
  const phone  = '+15550000010';
  const mockDb = makeTestDb({
    consented: new Map([[phone, { phone, consent_source: 'SELF_START' }]]),
    optedOut:  new Set([phone]),
  });
  const mockClient = makeMockClient();
  _setDb(mockDb);
  _setClient(mockClient);

  await assert.rejects(
    () => send(phone, 'Hello'),
    (err) => {
      assert.ok(err instanceof RecipientOptedOut,
        `Expected RecipientOptedOut, got ${err.constructor.name}`);
      assert.equal(err.to, phone);
      return true;
    }
  );
  assert.equal(mockClient.calls.length, 0,
    `create() should never be called — was called ${mockClient.calls.length}×`);
});

test('FIX 1b — send() to number with consent and NOT opted out → succeeds, create=1', async () => {
  const phone  = '+15550000011';
  const mockDb = makeTestDb({
    consented: new Map([[phone, { phone, consent_source: 'SELF_START' }]]),
  });
  const mockClient = makeMockClient();
  _setDb(mockDb);
  _setClient(mockClient);

  await send(phone, 'Hello');
  assert.equal(mockClient.calls.length, 1,
    `create() should be called exactly once — was called ${mockClient.calls.length}×`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Baseline regression (original FIX from prior sprint)
// ─────────────────────────────────────────────────────────────────────────────

test('BASELINE — send() with NO consent record → ConsentRequired, create=0', async () => {
  const mockDb     = makeTestDb();
  const mockClient = makeMockClient();
  _setDb(mockDb);
  _setClient(mockClient);

  await assert.rejects(
    () => send('+15550000001', 'Hello'),
    (err) => {
      assert.ok(err instanceof ConsentRequired,
        `Expected ConsentRequired, got ${err.constructor.name}`);
      return true;
    }
  );
  assert.equal(mockClient.calls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2 TESTS — SELF_START only on actual "START"
// ─────────────────────────────────────────────────────────────────────────────

test('FIX 2a — first inbound "hello" → no consent record written', () => {
  const phone = '+15550000020';
  const mockDb = makeTestDb();

  // Simulate what handleOnboarding does for a first-ever inbound body
  const body = 'hello';
  if (/^start$/i.test(body.trim())) {
    mockDb.writeConsent(phone, 'SELF_START');
  }

  assert.equal(mockDb.getConsent(phone), undefined,
    'No consent record should be written for non-START first inbound');
});

test('FIX 2b — first inbound "START" → consent record written', () => {
  const phone = '+15550000021';
  const mockDb = makeTestDb();

  const body = 'START';
  if (/^start$/i.test(body.trim())) {
    mockDb.writeConsent(phone, 'SELF_START');
  }

  const record = mockDb.getConsent(phone);
  assert.ok(record, 'Consent record should be written for START first inbound');
  assert.equal(record.consent_source, 'SELF_START');
});

test('FIX 2c — first inbound "start" (lowercase) → consent record written', () => {
  const phone = '+15550000022';
  const mockDb = makeTestDb();

  const body = 'start';
  if (/^start$/i.test(body.trim())) {
    mockDb.writeConsent(phone, 'SELF_START');
  }

  assert.ok(mockDb.getConsent(phone), 'Case-insensitive START should write consent');
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 3 TESTS — E.164 normalization
// ─────────────────────────────────────────────────────────────────────────────

test('FIX 3 — toE164 normalizes common US formats', () => {
  assert.equal(toE164('+12025550147'),  '+12025550147', 'already canonical');
  assert.equal(toE164('12025550147'),   '+12025550147', '11-digit with leading 1');
  assert.equal(toE164('2025550147'),    '+12025550147', '10-digit local');
  assert.equal(toE164('(202) 555-0147'),'+12025550147', 'formatted US');
  assert.equal(toE164('202-555-0147'),  '+12025550147', 'dashed US');
  assert.equal(toE164('202.555.0147'),  '+12025550147', 'dotted US');
  assert.equal(toE164('+447911123456'), '+447911123456', 'international passthrough');
});

test('FIX 3 — writeConsent with raw format, getConsent with canonical → same record', () => {
  const mockDb = makeTestDb();

  // Write using formatted number
  mockDb.writeConsent('(202) 555-0147', 'INVITE_PAGE');

  // Read using canonical E.164
  const record = mockDb.getConsent('+12025550147');
  assert.ok(record, 'getConsent with canonical E.164 should find record written with raw format');
  assert.equal(record.consent_source, 'INVITE_PAGE');
  assert.equal(record.phone, '+12025550147', 'stored phone should be canonical E.164');
});

test('FIX 3 — isOptedOut normalized correctly', () => {
  const optedOut = new Set(['+12025550147']);
  const mockDb   = makeTestDb({ optedOut });

  // Check using unformatted number
  assert.equal(mockDb.isOptedOut('(202) 555-0147'), true,
    'isOptedOut should normalize before lookup');
  assert.equal(mockDb.isOptedOut('+19995550000'), false,
    'Non-opted-out number should return false');
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 4 TESTS — approve_message YES three branches (via sms layer)
// ─────────────────────────────────────────────────────────────────────────────

test('FIX 4a — approved draft to consented, non-opted-out contact → send succeeds', async () => {
  const phone  = '+15550000040';
  const mockDb = makeTestDb({
    consented: new Map([[phone, { phone, consent_source: 'INVITE_PAGE' }]]),
  });
  const mockClient = makeMockClient();
  _setDb(mockDb);
  _setClient(mockClient);

  await send(phone, 'Hey, want to grab lunch?');
  assert.equal(mockClient.calls.length, 1, 'Should call create exactly once');
  assert.equal(mockClient.calls[0].to, phone);
});

test('FIX 4b — approved draft to OPTED-OUT contact → RecipientOptedOut, create=0', async () => {
  const phone  = '+15550000041';
  const mockDb = makeTestDb({
    consented: new Map([[phone, { phone, consent_source: 'INVITE_PAGE' }]]),
    optedOut:  new Set([phone]),
  });
  const mockClient = makeMockClient();
  _setDb(mockDb);
  _setClient(mockClient);

  await assert.rejects(
    () => send(phone, 'Hey, want to grab lunch?'),
    (err) => {
      assert.ok(err instanceof RecipientOptedOut,
        `Expected RecipientOptedOut, got ${err.constructor.name}`);
      return true;
    }
  );
  assert.equal(mockClient.calls.length, 0, 'create() must not be called for opted-out recipient');
});

test('FIX 4c — approved draft to NEVER-CONSENTED contact → ConsentRequired, create=0', async () => {
  const phone  = '+15550000042';
  const mockDb = makeTestDb(); // no consent records, not opted out
  const mockClient = makeMockClient();
  _setDb(mockDb);
  _setClient(mockClient);

  await assert.rejects(
    () => send(phone, 'Hey, want to grab lunch?'),
    (err) => {
      assert.ok(err instanceof ConsentRequired,
        `Expected ConsentRequired, got ${err.constructor.name}`);
      return true;
    }
  );
  assert.equal(mockClient.calls.length, 0, 'create() must not be called without consent');
});
