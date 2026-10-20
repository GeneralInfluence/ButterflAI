/**
 * signup-name.test.js — owner, 2026-10-20: "What is it that Alexandria needs to do in order to
 * finish signing up? I mean, she's using the app. She gets notices." Logging in with a code
 * made her "New user", not finished; finishing meant an old wizard (name + 3 contacts + how often).
 * Now sign-up is just your name, asked once in the app.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'signup-name-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');
const fs = require('node:fs');
const path = require('node:path');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');

async function login(phone) {
  await request.post('/auth/otp/send').send({ phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(phone);
  return (await request.post('/auth/otp/verify').send({ phone, code })).headers['set-cookie'][0];
}

describe('sign-up is just your name', () => {
  test('a first login is a full account that is asked its name; saving it is all it takes', async () => {
    const phone = '+12025340001';
    const cookie = await login(phone);
    const u = db.getUserByPhone(phone);
    assert.equal(u.onboarding_state, 'complete', 'not "new"');
    assert.equal((await request.get('/api/user/me').set('Cookie', cookie)).body.needs_name, true);
    assert.equal((await request.patch('/api/user/me').set('Cookie', cookie).send({ name: 'New user' })).status, 400, 'not a placeholder');
    assert.equal((await request.patch('/api/user/me').set('Cookie', cookie).send({ name: '  Alexandria   Spargo ' })).status, 200);
    const me = (await request.get('/api/user/me').set('Cookie', cookie)).body;
    assert.deepEqual([me.name, me.needs_name], ['Alexandria Spargo', false]);
  });
  test('every app screen asks (once) if the name is a placeholder; the old wizard and banner are gone', async () => {
    for (const f of ['dashboard', 'chat', 'events', 'contacts', 'settings']) {
      assert.ok(fs.readFileSync(path.join(__dirname, `../../public/app/${f}.html`), 'utf8').includes('<script src="/name-prompt.js"></script>'), f);
    }
    const prompt = fs.readFileSync(path.join(__dirname, '../../public/name-prompt.js'), 'utf8');
    assert.ok(prompt.includes('if (!me || !me.needs_name) return;') && prompt.includes('What’s your name?'));
    const dash = fs.readFileSync(path.join(__dirname, '../../public/app/dashboard.html'), 'utf8');
    assert.ok(!dash.includes('onboarding-banner') && !dash.includes('Finish setup'));
    const cookie = await login('+12025340002');
    const r = await request.get('/app/onboarding').set('Cookie', cookie);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/app/dashboard');
  });
  test('retro: someone already using it (Alexandria — in a plan, getting notices) counts as signed up', async () => {
    const id = uuidv4();
    db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'New user', '+12025340003', 'new')").run(id);
    db.appendConversation(id, 'assistant', '💡 Bam suggests …', null, 'notice');
    const task = require('../../retro').TASKS.find((t) => t.id === '2026-10-20-using-it-means-signed-up');
    assert.equal(task.run(db.getUser(id)), 'signed up');
    assert.equal(db.getUser(id).onboarding_state, 'complete');
    const idle = uuidv4();
    db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'New user', '+12025340004', 'new')").run(idle);
    assert.equal(task.run(db.getUser(idle)), 'not using it');
  });
});

describe('the name the person who invited them saved', () => {
  test('Sean saved her as Alexandria Spargo and invited her to a plan → her first login already has that name, no prompt', async () => {
    const seanId = uuidv4();
    db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Sean I', '+12025340010', 'complete')").run(seanId);
    const cid = db.upsertContact({ invited_by_user_id: seanId, name: 'Alexandria Spargo', phone: '+12025340011', tier: 1 });
    const planops = require('../../planops');
    const e = (await planops.create(seanId, { title: 'Rocky Horror', contact_ids: [cid] })).eventId;
    assert.ok(e);
    const cookie = await login('+12025340011');
    const me = (await request.get('/api/user/me').set('Cookie', cookie)).body;
    assert.deepEqual([me.name, me.needs_name], ['Alexandria Spargo', false]);
    // …and she can change it any time
    await request.patch('/api/user/me').set('Cookie', cookie).send({ name: 'Alex' });
    assert.equal((await request.get('/api/user/me').set('Cookie', cookie)).body.name, 'Alex');
  });
  test('an existing "New user" gets it too (retro, and on next open); nobody knowing the name → asked', async () => {
    const hostId = uuidv4();
    db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Host I', '+12025340012', 'complete')").run(hostId);
    db.upsertContact({ invited_by_user_id: hostId, name: 'Bammy', phone: '+12025340013', tier: 1 });
    const id = uuidv4();
    db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'New user', '+12025340013', 'complete')").run(id);
    const task = require('../../retro').TASKS.find((t) => t.id === '2026-10-20-names-from-inviters');
    assert.equal(task.run(db.getUser(id)), 'named Bammy');
    const nobody = uuidv4();
    db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'New user', '+12025340014', 'complete')").run(nobody);
    assert.equal(task.run(db.getUser(nobody)), 'kept');
    assert.equal(require('../../people').knownName('+12025340014'), null);
  });
});
