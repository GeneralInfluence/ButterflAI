'use strict';

/**
 * contact-directory.test.js — Phase 1: the main contact_directory is maintained on every
 * contact write. This is the additive routing foundation for the (later) per-user contacts
 * move: it lets a contact_id / phone resolve to the owning user without scanning shards.
 * No read path uses it yet, so this only asserts population + getContactOwner.
 *
 * Run: DB_PATH=:memory: JWT_SECRET=test node --test tests/unit/contact-directory.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH  = ':memory:';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'contact-dir-test';
delete process.env.SPLIT_MODE;

const db = require('../../db');
const { v4: uuid } = require('uuid');

function mkUser(phone) {
  const id = uuid();
  db._raw().prepare("INSERT INTO users (id, phone, name, onboarding_state) VALUES (?, ?, 'U', 'done')").run(id, phone);
  return id;
}

describe('contact_directory is maintained on contact writes', () => {
  const owner = mkUser('+15558880001');

  test('createContact populates the directory + getContactOwner resolves', () => {
    const cid = uuid();
    db.createContact({ id: cid, invited_by_user_id: owner, name: 'Kaylee', phone: '+15558880002', tier: 2 });
    const row = db._raw().prepare('SELECT * FROM contact_directory WHERE contact_id = ?').get(cid);
    assert.equal(row.owner_user_id, owner);
    assert.equal(row.phone, '+15558880002');
    assert.equal(db.getContactOwner(cid), owner);
  });

  test('upsertContact populates the directory (new + existing)', () => {
    const id1 = db.upsertContact({ invited_by_user_id: owner, name: 'Marcus', phone: '+15558880003' });
    assert.equal(db.getContactOwner(id1), owner);
    // upsert same phone → same contact, directory still consistent
    const id2 = db.upsertContact({ invited_by_user_id: owner, name: 'Marcus L', phone: '+15558880003' });
    assert.equal(id2, id1);
    assert.equal(db._raw().prepare('SELECT count(*) c FROM contact_directory WHERE contact_id = ?').get(id1).c, 1);
  });

  test('updateContact keeps the directory phone in sync', () => {
    const cid = uuid();
    db.createContact({ id: cid, invited_by_user_id: owner, name: 'Priya', phone: '+15558880004', tier: 2 });
    db.updateContact(cid, { phone: '+15558880099' });
    assert.equal(db._raw().prepare('SELECT phone FROM contact_directory WHERE contact_id = ?').get(cid).phone, '+15558880099');
  });

  test('getContactOwner returns null for an unknown contact', () => {
    assert.equal(db.getContactOwner('no-such-contact'), null);
  });
});
