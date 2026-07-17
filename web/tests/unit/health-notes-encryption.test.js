'use strict';

/**
 * health-notes-encryption.test.js — PRIVACY.md Invariant 1 for health_safety_notes.
 *
 * health_safety_notes was stored PLAINTEXT in user_preferences (a real Invariant 1
 * violation, caught by the Guardian). It now lives ENCRYPTED in user_private_data under
 * the canonical key, while staying shareable via the consent gate. These tests exercise
 * the real handlers (update_preferences, get_contact_hard_constraints) and the startup
 * migration.
 *
 * Run: DB_PATH=:memory: JWT_SECRET=test node --test tests/unit/health-notes-encryption.test.js
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH    = ':memory:';
process.env.JWT_SECRET = 'health-test-secret';
process.env.NODE_ENV   = 'test';
delete process.env.ANTHROPIC_API_KEY;

const { v4: uuidv4 } = require('uuid');
const db        = require('../../db');
const sensitive = require('../../sensitive');
const { executeTool } = require('../../agent');

const KEY = sensitive.HEALTH_NOTES_KEY;
const raw = () => db._raw();
const plaintextInPrefs = uid => {
  const p = raw().prepare('SELECT health_safety_notes FROM user_preferences WHERE user_id = ?').get(uid);
  return p ? p.health_safety_notes : undefined;
};

function makeUser(phone, name) {
  const id = uuidv4();
  raw().prepare(`INSERT INTO users (id, phone, name, onboarding_state) VALUES (?, ?, ?, 'done')`).run(id, phone, name);
  return { id, phone, name };
}

describe('update_preferences routes health notes to the encrypted store', () => {
  const u = makeUser('+15551110001', 'Health Owner');

  before(async () => {
    await executeTool('update_preferences',
      { health_safety_notes: 'STI panel all negative 2026-06', neighborhood: 'the Mission' },
      u.id, u.phone);
  });

  test('the health note is NOT in plaintext user_preferences', () => {
    assert.equal(plaintextInPrefs(u.id) ?? null, null, 'plaintext column must be null');
    const prefs = raw().prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(u.id);
    assert.ok(!JSON.stringify(prefs).includes('STI panel'), 'health note must not appear anywhere in prefs');
  });

  test('the health note IS encrypted in user_private_data and decrypts for the owner', () => {
    const row = raw().prepare('SELECT encrypted_v FROM user_private_data WHERE user_id = ? AND data_key = ?').get(u.id, KEY);
    assert.ok(row, 'encrypted row must exist');
    assert.ok(!row.encrypted_v.includes('STI'), 'stored value must be ciphertext');
    assert.equal(sensitive.readPrivateData(u.id, KEY), 'STI panel all negative 2026-06');
  });

  test('non-sensitive fields still land in plaintext prefs', () => {
    const prefs = raw().prepare('SELECT neighborhood FROM user_preferences WHERE user_id = ?').get(u.id);
    assert.equal(prefs.neighborhood, 'the Mission');
  });
});

describe('get_contact_hard_constraints honors the health consent gate (reading encrypted)', () => {
  const owner = makeUser('+15551110010', 'Contact Owner');   // the contact, who is also a user
  const asker = makeUser('+15551110011', 'The Asker');       // requesting user
  let contactId;

  before(() => {
    sensitive.storePrivateData(owner.id, KEY, 'on PrEP, HIV negative', 'HEALTH');
    contactId = uuidv4();
    db.createContact({ id: contactId, invited_by_user_id: asker.id, name: 'Contact Owner', phone: owner.phone, tier: 2 });
  });

  test('shares the note when the owner approved (health_sharing_approved=1)', async () => {
    db.upsertPreferences(owner.id, { health_sharing_approved: 1 });
    const r = await executeTool('get_contact_hard_constraints', { contact_id: contactId }, asker.id, asker.phone);
    assert.equal(r.health_safety_notes, 'on PrEP, HIV negative');
  });

  test('withholds the note (null + explanation) when NOT approved', async () => {
    db.upsertPreferences(owner.id, { health_sharing_approved: 0 });
    const r = await executeTool('get_contact_hard_constraints', { contact_id: contactId }, asker.id, asker.phone);
    assert.equal(r.health_safety_notes, null);
    assert.match(r.health_sharing_note, /has not approved/);
  });

  test('logs the shared read against the requesting user as accessor', () => {
    db.upsertPreferences(owner.id, { health_sharing_approved: 1 });
    sensitive.readPrivateDataAsAccessor(owner.id, KEY, asker.id, 'test share');
    const log = sensitive.getAccessLog(owner.id, 10);
    assert.ok(log.some(e => e.accessor_id === asker.id && e.action === 'share'), 'accessor must be logged');
  });
});

describe('migratePlaintextHealthNotes moves legacy plaintext to the encrypted store', () => {
  const legacy = makeUser('+15551110020', 'Legacy User');

  test('moves plaintext -> encrypted and NULLs the column; is idempotent', () => {
    // Simulate a legacy row written before the fix.
    db.upsertPreferences(legacy.id, { health_safety_notes: 'legacy: peanut anaphylaxis' });
    assert.equal(plaintextInPrefs(legacy.id), 'legacy: peanut anaphylaxis');

    const { migrated } = sensitive.migratePlaintextHealthNotes();
    assert.ok(migrated >= 1);

    assert.equal(plaintextInPrefs(legacy.id) ?? null, null, 'plaintext column must be cleared');
    assert.equal(sensitive.readPrivateData(legacy.id, KEY), 'legacy: peanut anaphylaxis', 'value preserved, encrypted');

    // Idempotent: a second run finds nothing.
    assert.equal(sensitive.migratePlaintextHealthNotes().migrated, 0);
  });
});
