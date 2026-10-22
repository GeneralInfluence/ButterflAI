/**
 * surprise.test.js — 🐛 #86 (Sean, 2026-10-21). Allie: "Send Sean a mystery playlist for the Rocky Horror drive". Her
 * agent made "Mystery playlist for Rocky Horror drive" with notes "Anonymous gift for Sean … He shouldn't know it's from
 * Allie" and invited Sean; when he asked "Where did this come from?" his ButterflAI told him. The person a surprise is
 * for is never invited to it.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'surprise-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

require('../../sms')._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
require('../../server');
const db = require('../../db');
const planops = require('../../planops');
const plan = require('../../plan');
const agent = require('../../agent');

let n = 0;
function mkUser(name) {
  const phone = `+1202541${String(1000 + n++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', 1700000000)").run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
const NOTES = 'Anonymous gift for Sean before Rocky Horror Picture Show (Oct 30). He shouldn\'t know it\'s from Allie.';

describe('🐛 #86: the person a surprise is for is never invited to it', () => {
  test('Allie\'s exact plan: Sean is kept out, can\'t see it, and her agent is told why', async () => {
    const allie = mkUser('Allie M'); const sean = mkUser('Sean Gonzalez'); const mel = mkUser('Melanie Noel');
    const toSean = db.upsertContact({ invited_by_user_id: allie.id, name: 'Sean Gonzalez', phone: sean.phone, tier: 1 });
    const toMel = db.upsertContact({ invited_by_user_id: allie.id, name: 'Melanie Noel', phone: mel.phone, tier: 1 });
    const r = await planops.create(allie.id, { title: 'Mystery playlist for Rocky Horror drive', activity_type: 'playlist gift', notes: NOTES, tentative: true, contact_ids: [toSean, toMel] }, { via: 'agent' });
    assert.deepEqual(r.invites.kept_out_surprise, ['Sean Gonzalez']);
    assert.match(r.invites.surprise_note, /send_whisper/);
    assert.equal(plan.planFor(r.eventId, sean.id), null, 'Sean can\'t see it');
    assert.ok(!plan.plansFor(sean.id).some((p) => p.id === r.eventId));
    assert.ok(plan.plansFor(mel.id).some((p) => p.id === r.eventId), 'Melanie, in on it, is invited');
    await planops.invite(allie.id, r.eventId, [toSean]);
    assert.equal(plan.planFor(r.eventId, sean.id), null, 'adding him later is kept out too');
  });
  test('an ordinary plan naming someone still invites them', async () => {
    const allie = mkUser('Allie O'); const sean = mkUser('Sean O');
    const c = db.upsertContact({ invited_by_user_id: allie.id, name: 'Sean', phone: sean.phone, tier: 1 });
    const r = await planops.create(allie.id, { title: 'Drive to Rocky Horror', activity_type: 'drive', notes: 'Sean is driving.', tentative: true, contact_ids: [c] }, { via: 'agent' });
    assert.equal(r.invites.kept_out_surprise, undefined);
    assert.ok(plan.planFor(r.eventId, sean.id));
  });
  test('the rule is in the prompt', () => {
    assert.match(agent.buildSystemPrompt({ id: 'x', name: 'A', phone: '+1' }, ''), /SURPRISES: a surprise, secret or anonymous gift for someone/);
  });
  test('retro: Sean is taken off Allie\'s mystery playlist; nobody else is', async () => {
    const allie = mkUser('Allie R'); const sean = mkUser('Sean R'); const mel = mkUser('Mel R');
    const id = uuidv4();
    db._raw().prepare("INSERT INTO social_events (id, host_user_id, title, activity_type, scheduled_at, notes, tentative, date_tbd) VALUES (?, ?, 'Mystery playlist for Rocky Horror drive', 'gift', ?, ?, 1, 1)").run(id, allie.id, Math.floor(Date.now() / 1000) + 86400 * 30, NOTES);
    for (const u of [sean, mel]) {
      const c = db.upsertContact({ invited_by_user_id: allie.id, name: u.name, phone: u.phone, tier: 1 });
      db._raw().prepare("INSERT INTO event_invitations (id, event_id, contact_id, status, created_at) VALUES (?, ?, ?, 'accepted', strftime('%s','now'))").run(uuidv4(), id, c);
    }
    assert.equal(await require('../../retro').TASKS.find((x) => x.id === '2026-10-21-surprise-not-invited').run(allie), 'removed 1');
    assert.equal(plan.planFor(id, sean.id), null);
    assert.ok(plan.planFor(id, mel.id));
  });
});
