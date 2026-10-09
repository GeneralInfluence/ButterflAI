/**
 * contact-sync-group-infer.test.js
 *
 * Owner, 2026-10-09:
 *  - "Alex is already in my contacts. You should be able to see Alex Spargo." Contacts
 *    were imported from Google once (June) and never again; Google contacts with no
 *    phone were dropped. Now: the Google grant is kept (encrypted), contacts re-sync
 *    daily and when a lookup has no exact match; name-only contacts are kept.
 *  - "You should infer from our conversations that it is a group plan." A plan whose
 *    invitees include everyone in a group is that group's plan — in code.
 * No real Google calls: googleapis' People API is stubbed.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'sync-infer-test';
process.env.KMS_PROVIDER = 'local';
process.env.KMS_MASTER_KEY_HEX = 'a'.repeat(64);
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
const texts = [];
sms._setClient({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' + texts.length }; } } });

// Google's People API, stubbed: whatever `googleContacts` holds is "in Google".
let googleContacts = [];
let googleCalls = 0;
require('googleapis').google.people = () => ({ people: { connections: { list: async () => {
  googleCalls++;
  return { data: { connections: googleContacts } };
} } } });

require('../../server');
const db = require('../../db');
const agent = require('../../agent');
const contactsImport = require('../../contacts-import');

let n = 0;
function mkUser(name) {
  const phone = `+1202555${String(9100 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const person = (name, phone) => ({ names: [{ displayName: name }], phoneNumbers: phone ? [{ value: phone }] : [] });

describe('contacts stay in sync with Google', () => {
  let sean;
  before(async () => {
    sean = mkUser('Sean Sync');
    db.upsertContact({ invited_by_user_id: sean.id, name: 'Alexander Priest', phone: '+12705551307', tier: 0 });
    // Sean connected Google contacts: the grant is kept, encrypted.
    googleContacts = [person('Alexander Priest', '+1 270 555 1307')];
    await contactsImport.saveGoogleTokens(sean.id, { access_token: 'a', refresh_token: 'r' });
    const row = db._raw().prepare('SELECT ciphertext FROM contact_sync_tokens WHERE user_id = ?').get(sean.id);
    assert.ok(row && !row.ciphertext.includes('"refresh_token"'), 'stored encrypted');
  });

  test('"Alex Spargo" isn\'t found → a sync runs → she\'s found; the partial match is not offered as her', async () => {
    googleContacts.push(person('Alex Spargo', '+1 (530) 555-0142'));
    const r = await agent.executeTool('lookup_contact', { query: 'Alex Spargo' }, sean.id, sean.phone);
    assert.match(r.synced_google_contacts, /just now \(1 new\)/);
    assert.equal(r.exact_match, true);
    assert.equal(r.contacts[0].name, 'Alex Spargo');
    assert.equal(r.contacts[0].phone, '+15305550142');
  });

  test('a Google contact with no phone is kept (so the agent can ask for the number)', async () => {
    googleContacts.push(person('Robin NoPhone', null));
    await contactsImport.syncGoogle(sean.id, { force: true });
    const c = db._raw().prepare("SELECT phone FROM contacts WHERE invited_by_user_id = ? AND name = 'Robin NoPhone'").get(sean.id);
    assert.ok(c);
    assert.equal(c.phone, null);
    await contactsImport.syncGoogle(sean.id, { force: true });
    assert.equal(db._raw().prepare("SELECT count(*) c FROM contacts WHERE invited_by_user_id = ? AND name = 'Robin NoPhone'").get(sean.id).c, 1, 'not duplicated');
  });

  test('on-demand syncs are rate-limited; a strong match never triggers one', async () => {
    const before = googleCalls;
    await agent.executeTool('lookup_contact', { query: 'Nobody Here' }, sean.id, sean.phone);   // just synced → skipped
    await agent.executeTool('lookup_contact', { query: 'Alex Spargo' }, sean.id, sean.phone);   // exact → no sync
    assert.equal(googleCalls, before);
  });

  test('not connected: only partial matches → told not to assume, and how to turn on syncing', async () => {
    const other = mkUser('No Sync');
    db.upsertContact({ invited_by_user_id: other.id, name: 'Alexander Priest', phone: '+12705551308', tier: 0 });
    const r = await agent.executeTool('lookup_contact', { query: 'Alex Spargo' }, other.id, other.phone);
    assert.equal(r.exact_match, false);
    assert.match(r.tip, /do NOT assume one of them is the person/);
    assert.match(r.tip, /get_contact_import_url/);
  });
});

describe('group plans are inferred', () => {
  let sean, allie, mel, bam, gid;
  before(() => {
    sean = mkUser('Sean Group'); allie = mkUser('Allie G'); mel = mkUser('Melanie G'); bam = mkUser('Bam G');
    gid = db.upsertContactGroup(sean.id, "Favorite Mama's");
    for (const u of [allie, mel, bam]) db.addContactToGroup(gid, knows(sean, u));
  });

  test('inviting everyone in a group makes it the group\'s plan — without saying so', async () => {
    const ids = [allie, mel, bam].map((u) => knows(sean, u));
    const r = await agent.executeTool('create_social_event', { title: 'Grover Hot Springs', activity_type: 'camping trip', tentative: true,
      scheduled_at: new Date(Date.now() + 14 * 86400e3).toISOString(), contact_ids: ids }, sean.id, sean.phone);
    assert.equal(r.group, "Favorite Mama's");
    assert.equal(db._raw().prepare('SELECT group_id FROM social_events WHERE id = ?').get(r.eventId).group_id, gid);
  });

  test('a plan made before (not linked) still counts: adding Alex catches her up on it', async () => {
    const ev = await agent.executeTool('create_social_event', { title: 'Tahoe weekend', activity_type: 'trip',
      scheduled_at: new Date(Date.now() + 30 * 86400e3).toISOString() }, sean.id, sean.phone);
    // Invited one by one (e.g. before the group existed) — not linked.
    const { inviteContacts } = require('../../multiparty');
    await inviteContacts(ev.eventId, [allie, mel, bam].map((u) => knows(sean, u)));
    assert.equal(db._raw().prepare('SELECT group_id FROM social_events WHERE id = ?').get(ev.eventId).group_id, null);
    texts.length = 0;
    const alexC = db.upsertContact({ invited_by_user_id: sean.id, name: 'Alex Spargo', phone: '+15305550143', tier: 0 });
    const r = await agent.executeTool('manage_contact_group', { action: 'add_member', group_id: gid, contact_id: alexC }, sean.id, sean.phone);
    assert.deepEqual(r.caught_up_on.sort(), ['Grover Hot Springs', 'Tahoe weekend']);
    assert.equal(texts.length, 1, 'one catch-up text');
    assert.equal(db._raw().prepare('SELECT group_id FROM social_events WHERE id = ?').get(ev.eventId).group_id, gid, 'now linked');
  });

  test('a plan with only some of the group is not the group\'s plan', async () => {
    const r = await agent.executeTool('create_social_event', { title: 'Coffee', activity_type: 'coffee',
      scheduled_at: new Date(Date.now() + 2 * 86400e3).toISOString(), contact_ids: [knows(sean, allie)] }, sean.id, sean.phone);
    assert.equal(r.group, undefined);
  });
});
