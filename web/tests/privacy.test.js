'use strict';
/**
 * privacy.test.js — Behavioral privacy invariant tests (unit layer)
 *
 * Tests PRIVACY.md invariants at the module level.
 * These tests must stay green. No feature may ship that breaks them.
 * API-level tests are in tests/integration/privacy-api.test.js.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH    = ':memory:';
process.env.JWT_SECRET = 'privacy-test-secret';
process.env.NODE_ENV   = 'test';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;

const sensitive = require('../sensitive.js');
const db        = require('../db.js');
const { v4: uuidv4 } = require('uuid');

function makeUser(phone, name) {
  const id = uuidv4();
  db._raw().prepare(
    `INSERT INTO users (id, phone, name, onboarding_state) VALUES (?, ?, ?, 'done')`
  ).run(id, phone, name);
  return { id, phone, name };
}

const userA = makeUser('+15550000001', 'Alice');
const userB = makeUser('+15550000002', 'Bob');

// ── Invariant 1: Sensitive data stored separately ────────────────────────────

describe('Invariant 1 — Sensitive data stored in user_private_data, not user_preferences', () => {
  test('storePrivateData writes encrypted row to user_private_data', () => {
    sensitive.storePrivateData(userA.id, 'health.sti_status', 'all negative', 'HEALTH');
    const row = db._raw().prepare(
      'SELECT encrypted_v FROM user_private_data WHERE user_id = ? AND data_key = ?'
    ).get(userA.id, 'health.sti_status');
    assert.ok(row, 'row must exist in user_private_data');
    assert.notEqual(row.encrypted_v, 'all negative', 'value must be encrypted, not plaintext');
  });

  test('encrypted value decrypts correctly for owner', () => {
    sensitive.storePrivateData(userA.id, 'health.roundtrip', 'secret-42', 'HEALTH');
    assert.equal(sensitive.readPrivateData(userA.id, 'health.roundtrip'), 'secret-42');
  });

  test('storePrivateData never touches user_preferences', () => {
    sensitive.storePrivateData(userA.id, 'health.pref_leak_check', 'do not leak', 'HEALTH');
    const prefs = db._raw().prepare(
      'SELECT * FROM user_preferences WHERE user_id = ?'
    ).get(userA.id);
    const prefsStr = JSON.stringify(prefs || {});
    assert.ok(!prefsStr.includes('do not leak'), 'sensitive value must not appear in user_preferences');
  });
});

// ── Invariant 2: No cross-user read ──────────────────────────────────────────

describe('Invariant 2 — Sensitive data never readable by another user\'s agent without consent', () => {
  test('readPrivateDataForSharing returns not_approved without consent', () => {
    sensitive.storePrivateData(userA.id, 'health.share_gate', 'positive', 'HEALTH');
    const r = sensitive.readPrivateDataForSharing(userA.id, 'health.share_gate', userB.id);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'not_approved');
  });

  test('readPrivateDataForSharing returns value after approveSharing', () => {
    sensitive.storePrivateData(userA.id, 'health.share_approved', 'negative', 'HEALTH');
    sensitive.approveSharing(userA.id, 'health.share_approved', userB.id);
    const r = sensitive.readPrivateDataForSharing(userA.id, 'health.share_approved', userB.id);
    assert.equal(r.allowed, true);
    assert.equal(r.value, 'negative');
  });

  test('approval for userB does not grant access to userC', () => {
    const userC = makeUser('+15550000099', 'Carol');
    sensitive.storePrivateData(userA.id, 'health.third_party', 'value', 'HEALTH');
    sensitive.approveSharing(userA.id, 'health.third_party', userB.id);
    const r = sensitive.readPrivateDataForSharing(userA.id, 'health.third_party', userC.id);
    assert.equal(r.allowed, false);
  });
});

// ── Invariant 3: Exclusion reasons never in agent_messages ───────────────────

describe('Invariant 3 — Exclusion reasons and sensitive keys scrubbed from agent-to-agent payloads', () => {
  test('scrubForAgentMessage removes exclusion_reason', () => {
    const payload = { message: 'hey', exclusion_reason: 'private judgment', availability: 'free at 7' };
    const safe = sensitive.scrubForAgentMessage(payload);
    assert.ok(!('exclusion_reason' in safe), 'exclusion_reason must be removed');
    assert.equal(safe.message, 'hey');
    assert.equal(safe.availability, 'free at 7');
  });

  test('scrubForAgentMessage removes all banned sensitive keys', () => {
    const payload = {
      text: 'hi',
      exclusion_reason: 'x', health_safety_notes: 'x', sexual_health_notes: 'x',
      private_notes: 'x', mental_health_notes: 'x', financial_notes: 'x', legal_notes: 'x',
    };
    const safe = sensitive.scrubForAgentMessage(payload);
    for (const k of ['exclusion_reason','health_safety_notes','sexual_health_notes',
        'private_notes','mental_health_notes','financial_notes','legal_notes']) {
      assert.ok(!(k in safe), `${k} must be scrubbed`);
    }
    assert.equal(safe.text, 'hi');
  });
});

// ── Invariant 5: First-contact self-identification ───────────────────────────

describe('Invariant 5 — Outbound first-contact SMS self-identifies as ButterflAI with STOP opt-out', () => {
  test('multiparty.js contains ButterflAI self-identification string', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '../multiparty.js'), 'utf8');
    assert.ok(src.includes('ButterflAI'), 'multiparty.js must include "ButterflAI" self-ID');
    assert.ok(src.includes('STOP'), 'multiparty.js must include STOP opt-out instruction');
  });
});

// ── Invariant 6: Classifier uncertainty defaults to sensitive ────────────────

describe('Invariant 6 — Sensitivity classifier: uncertain defaults to sensitive', () => {
  test('STI test result → HEALTH (high confidence)', () => {
    const r = sensitive.classifyText('my STI test came back negative');
    assert.equal(r.sensitive, true);
    assert.equal(r.category, 'HEALTH');
    assert.equal(r.confidence, 'high');
  });

  test('"keep this between us" → sensitive, uncertain confidence', () => {
    const r = sensitive.classifyText('keep this between us');
    assert.equal(r.sensitive, true);
    assert.equal(r.confidence, 'uncertain');
  });

  test('court date mention → LEGAL (high confidence)', () => {
    const r = sensitive.classifyText('I have a court date next week');
    assert.equal(r.sensitive, true);
    assert.equal(r.category, 'LEGAL');
  });

  test('financial struggle → FINANCIAL (high confidence)', () => {
    const r = sensitive.classifyText("I'm struggling with debt");
    assert.equal(r.sensitive, true);
    assert.equal(r.category, 'FINANCIAL');
  });

  test('therapist mention → MENTAL_HEALTH (high confidence)', () => {
    const r = sensitive.classifyText("I started seeing a therapist for anxiety");
    assert.equal(r.sensitive, true);
    assert.equal(r.category, 'MENTAL_HEALTH');
  });

  test('general preference → not sensitive', () => {
    const r = sensitive.classifyText('I love hiking and Italian food');
    assert.equal(r.sensitive, false);
  });
});

// ── Invariant 7: Sensitive mode ───────────────────────────────────────────────

describe('Invariant 7 — Sensitive mode flag routes all content to private store', () => {
  test('isSensitiveMode defaults to false', () => {
    const u = makeUser('+15551111111', 'Dave');
    assert.equal(sensitive.isSensitiveMode(u.id), false);
  });

  test('setSensitiveMode(true) activates', () => {
    const u = makeUser('+15552222222', 'Eve');
    sensitive.setSensitiveMode(u.id, true);
    assert.equal(sensitive.isSensitiveMode(u.id), true);
  });

  test('setSensitiveMode(false) deactivates', () => {
    const u = makeUser('+15553333333', 'Frank');
    sensitive.setSensitiveMode(u.id, true);
    sensitive.setSensitiveMode(u.id, false);
    assert.equal(sensitive.isSensitiveMode(u.id), false);
  });
});

// ── Encryption integrity ──────────────────────────────────────────────────────

describe('Encryption integrity (AES-256-GCM)', () => {
  test('encrypt/decrypt roundtrip', () => {
    const plain = 'Very sensitive health info';
    const enc = sensitive.encrypt(plain);
    assert.notEqual(enc.encrypted_v, plain);
    assert.ok(enc.iv && enc.auth_tag);
    assert.equal(sensitive.decrypt(enc.encrypted_v, enc.iv, enc.auth_tag), plain);
  });

  test('tampered ciphertext fails decryption', () => {
    const enc = sensitive.encrypt('secret');
    const buf = Buffer.from(enc.encrypted_v, 'base64');
    buf[0] ^= 0xff;
    assert.throws(() => sensitive.decrypt(buf.toString('base64'), enc.iv, enc.auth_tag));
  });
});

// ── Access audit log ──────────────────────────────────────────────────────────

describe('Access audit log — every read/write/share is recorded', () => {
  test('storePrivateData logs a write event', () => {
    const u = makeUser('+15554444444', 'Grace');
    sensitive.storePrivateData(u.id, 'health.log_write', 'val', 'HEALTH');
    const log = sensitive.getAccessLog(u.id);
    assert.ok(log.find(e => e.action === 'write' && e.data_key === 'health.log_write'),
      'write must be in audit log');
  });

  test('readPrivateData logs a read event', () => {
    const u = makeUser('+15555555555', 'Hank');
    sensitive.storePrivateData(u.id, 'health.log_read', 'val', 'HEALTH');
    sensitive.readPrivateData(u.id, 'health.log_read');
    const log = sensitive.getAccessLog(u.id);
    assert.ok(log.find(e => e.action === 'read' && e.data_key === 'health.log_read'),
      'read must be in audit log');
  });

  test('denied share attempt is logged', () => {
    const u = makeUser('+15556666666', 'Iris');
    sensitive.storePrivateData(u.id, 'health.log_deny', 'val', 'HEALTH');
    sensitive.readPrivateDataForSharing(u.id, 'health.log_deny', userB.id);
    const log = sensitive.getAccessLog(u.id);
    assert.ok(log.find(e => e.action === 'share' && e.context?.includes('denied')),
      'denied share must be logged');
  });
});
