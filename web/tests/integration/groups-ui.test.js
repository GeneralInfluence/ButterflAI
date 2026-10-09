/**
 * groups-ui.test.js — create groups and add people from People → Groups (2026-10-09),
 * with each member marked on/not on ButterflAI. Owner-only.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'groups-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');

function mkUser(phone, name) {
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, ?, ?, 'complete')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}

describe('People → Groups: create, add, see who is on ButterflAI', () => {
  let sean, other, cs, co, bambamContact, offAppContact, othersContact;
  before(async () => {
    sean = mkUser('+12025559701', 'Sean');
    other = mkUser('+12025559702', 'Other');
    const bambam = mkUser('+12025559703', 'Bam Bam');
    bambamContact = db.upsertContact({ invited_by_user_id: sean.id, name: 'Bam Bam', phone: bambam.phone, tier: 0 });
    offAppContact = db.upsertContact({ invited_by_user_id: sean.id, name: 'Off App', phone: '+12025559704', tier: 0 });
    othersContact = db.upsertContact({ invited_by_user_id: other.id, name: 'Not Seans', phone: '+12025559705', tier: 0 });
    cs = await cookieFor(sean); co = await cookieFor(other);
  });

  test('create a group, add people, members flagged on/not on ButterflAI', async () => {
    const g = await request.post('/api/contacts/groups').set('Cookie', cs).send({ name: 'The Boys' });
    assert.equal(g.status, 200);
    for (const id of [bambamContact, offAppContact]) {
      assert.equal((await request.post(`/api/contacts/groups/${g.body.id}/members`).set('Cookie', cs).send({ contact_id: id })).status, 200);
    }
    const list = await request.get('/api/contacts/groups').set('Cookie', cs);
    const boys = list.body.groups.find((x) => x.name === 'The Boys');
    const flags = Object.fromEntries(boys.members.map((m) => [m.name, m.on_butterflai]));
    assert.deepEqual(flags, { 'Bam Bam': true, 'Off App': false });
  });

  test("can't add someone else's contact, or touch someone else's group", async () => {
    const g = (await request.get('/api/contacts/groups').set('Cookie', cs)).body.groups[0];
    assert.equal((await request.post(`/api/contacts/groups/${g.id}/members`).set('Cookie', cs).send({ contact_id: othersContact })).status, 404);
    assert.equal((await request.post(`/api/contacts/groups/${g.id}/members`).set('Cookie', co).send({ contact_id: othersContact })).status, 404);
  });

  test('empty name rejected; requires login', async () => {
    assert.equal((await request.post('/api/contacts/groups').set('Cookie', cs).send({ name: '  ' })).status, 400);
    assert.equal((await request.post('/api/contacts/groups').send({ name: 'x' })).status, 401);
  });
});
