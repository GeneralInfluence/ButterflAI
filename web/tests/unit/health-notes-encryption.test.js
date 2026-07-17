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

describe('get_contact_hard_constraints enforces PER-EDGE consent (Invariant 2)', () => {
  const owner = makeUser('+15551110010', 'Contact Owner');   // the contact, who is also a user
  const asker = makeUser('+15551110011', 'The Asker');       // requesting user
  const other = makeUser('+15551110012', 'Third Party');     // a different requester
  let contactId;

  before(() => {
    sensitive.storePrivateData(owner.id, KEY, 'on PrEP, HIV negative', 'HEALTH');
    contactId = uuidv4();
    db.createContact({ id: contactId, invited_by_user_id: asker.id, name: 'Contact Owner', phone: owner.phone, tier: 2 });
  });

  test('withholds by default — no global toggle grants access', async () => {
    const r = await executeTool('get_contact_hard_constraints', { contact_id: contactId }, asker.id, asker.phone);
    assert.equal(r.health_safety_notes, null);
    assert.match(r.health_sharing_note, /has not approved/);
  });

  test('shares only after the owner approved THIS requester specifically', async () => {
    sensitive.approveSharing(owner.id, KEY, asker.id);
    const r = await executeTool('get_contact_hard_constraints', { contact_id: contactId }, asker.id, asker.phone);
    assert.equal(r.health_safety_notes, 'on PrEP, HIV negative');
  });

  test('approval for the asker does NOT leak to a different user (per-edge)', () => {
    // owner approved asker (above) but never `other`.
    const shared = sensitive.readPrivateDataForSharing(owner.id, KEY, other.id);
    assert.equal(shared.allowed, false);
  });

  test('revocation withdraws access', async () => {
    assert.equal(sensitive.revokeSharing(owner.id, KEY, asker.id), true);
    const r = await executeTool('get_contact_hard_constraints', { contact_id: contactId }, asker.id, asker.phone);
    assert.equal(r.health_safety_notes, null);
  });

  test('every share attempt is logged against the requester', () => {
    const log = sensitive.getAccessLog(owner.id, 20);
    assert.ok(log.some(e => e.accessor_id === asker.id && e.action === 'share'), 'accessor must be logged');
  });

  test('the DEPRECATED global health_sharing_approved flag does NOT grant access', async () => {
    // Fresh pair with a VALID address-book contact (so the scoping check passes) and the
    // global toggle ON — but no per-edge approval. Must still be denied. Guards against a
    // regression that re-introduces the global gate before the per-edge check.
    const gOwner = makeUser('+15551110013', 'Global Owner');
    const gAsker = makeUser('+15551110014', 'Global Asker');
    sensitive.storePrivateData(gOwner.id, KEY, 'should stay private', 'HEALTH');
    db.upsertPreferences(gOwner.id, { health_sharing_approved: 1 });      // global toggle ON
    const cid = uuidv4();
    db.createContact({ id: cid, invited_by_user_id: gAsker.id, name: 'Global Owner', phone: gOwner.phone, tier: 2 });
    const r = await executeTool('get_contact_hard_constraints', { contact_id: cid }, gAsker.id, gAsker.phone);
    assert.equal(r.health_safety_notes, null, 'global flag must NOT release the note');
    assert.match(r.health_sharing_note || '', /has not approved/);
  });
});

describe('approve_private_sharing / revoke_private_sharing tools', () => {
  const owner = makeUser('+15551110050', 'Tool Owner');
  const friend = makeUser('+15551110051', 'Tool Friend');
  let cid;

  before(() => {
    sensitive.storePrivateData(owner.id, KEY, 'lactose intolerant + on meds', 'HEALTH');
    cid = uuidv4();
    db.createContact({ id: cid, invited_by_user_id: owner.id, name: 'Tool Friend', phone: friend.phone, tier: 2 });
  });

  test('approve_private_sharing grants per-edge access; revoke removes it', async () => {
    const a = await executeTool('approve_private_sharing', { contact_id: cid, data_key: KEY }, owner.id, owner.phone);
    assert.equal(a.approved, true);
    assert.deepEqual(sensitive.listSharingApprovals(owner.id, KEY), [friend.id]);
    assert.equal(sensitive.readPrivateDataForSharing(owner.id, KEY, friend.id).allowed, true);

    const r = await executeTool('revoke_private_sharing', { contact_id: cid, data_key: KEY }, owner.id, owner.phone);
    assert.equal(r.revoked, true);
    assert.equal(sensitive.readPrivateDataForSharing(owner.id, KEY, friend.id).allowed, false);
  });

  test('approving a non-existent datum is an error, not a silent grant', async () => {
    const a = await executeTool('approve_private_sharing', { contact_id: cid, data_key: 'health.nonexistent' }, owner.id, owner.phone);
    assert.ok(a.error);
  });
});

describe('clearing + scoping (adversarial review follow-ups)', () => {
  test('an empty health_safety_notes value DELETES the encrypted note (user can clear it)', async () => {
    const u = makeUser('+15551110030', 'Clearer');
    await executeTool('update_preferences', { health_safety_notes: 'temporary note' }, u.id, u.phone);
    assert.equal(sensitive.readPrivateData(u.id, KEY), 'temporary note');
    await executeTool('update_preferences', { health_safety_notes: '   ' }, u.id, u.phone);
    assert.equal(sensitive.readPrivateData(u.id, KEY), null, 'blank value must clear the note');
    assert.equal(sensitive.hasPrivateData(u.id, KEY), false);
  });

  test('a sensitive sibling field rejects the call WITHOUT committing the health note', async () => {
    const u = makeUser('+15551110031', 'Partial');
    const r = await executeTool('update_preferences',
      { health_safety_notes: 'HIV negative', extra_notes: 'I have severe depression and take antidepressants' },
      u.id, u.phone);
    assert.equal(r.error, 'SENSITIVE_DATA_DETECTED');
    assert.equal(sensitive.hasPrivateData(u.id, KEY), false, 'health note must NOT be stored when the call is rejected');
  });

  test('get_contact_hard_constraints refuses a contact_id not in the requester\'s address book', async () => {
    const owner = makeUser('+15551110040', 'Owner40');
    const other = makeUser('+15551110041', 'Other41');   // owns the contact
    const asker = makeUser('+15551110042', 'Asker42');    // does NOT own it
    const cid = uuidv4();
    db.createContact({ id: cid, invited_by_user_id: other.id, name: 'Owner40', phone: owner.phone, tier: 2 });
    sensitive.storePrivateData(owner.id, KEY, 'confidential', 'HEALTH');
    db.upsertPreferences(owner.id, { health_sharing_approved: 1 });
    const r = await executeTool('get_contact_hard_constraints', { contact_id: cid }, asker.id, asker.phone);
    assert.match(r.error || '', /not in your address book/);
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

  test('does NOT clobber an existing encrypted note with stale plaintext', () => {
    const u = makeUser('+15551110021', 'Coexist User');
    // Authoritative, current value already encrypted...
    sensitive.storePrivateData(u.id, KEY, 'CURRENT: HIV- on PrEP', 'HEALTH');
    // ...and a stale plaintext value lingering in the column.
    db.upsertPreferences(u.id, { health_safety_notes: 'STALE: old panel 2024' });

    sensitive.migratePlaintextHealthNotes();

    assert.equal(sensitive.readPrivateData(u.id, KEY), 'CURRENT: HIV- on PrEP', 'encrypted value must be preserved, not clobbered');
    assert.equal(plaintextInPrefs(u.id) ?? null, null, 'stale plaintext still cleared');
  });
});
