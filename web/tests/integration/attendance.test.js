/**
 * attendance.test.js — "Did you make it?" asks about real plans (2026-10-13).
 * The gate used to read the old `activities` table, which nothing writes, so nobody was
 * ever asked and lift was never measured. Now: plans you were in, asked in the app (Home +
 * push) or by text if notifications are off; answering measures lift and resets the
 * "it's been a while" cadences with the people who were there.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'attendance-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
const texts = [];
sms._setClient({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' + texts.length }; } } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const multiparty = require('../../multiparty');
const cadence = require('../../cadence');
const home = require('../../home');

let n = 0;
function mkUser(name) {
  const phone = `+1202553${String(3000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
function pastPlan(host, guests, hoursAgo, { status = 'accepted', title = 'Dinner ' + n } = {}) {
  const id = multiparty.createEvent(host.id, { title, activity_type: 'dinner', scheduled_at: Math.floor(Date.now() / 1000) - hoursAgo * 3600, duration_mins: 120 });
  for (const g of guests) db._raw().prepare('INSERT INTO event_invitations (id, event_id, contact_id, status) VALUES (?, ?, ?, ?)').run(uuidv4(), id, knows(host, g), status);
  return id;
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}

describe('which plans are asked about', () => {
  test('ended 12h–7 days ago, you hosted or said yes, not asked before', () => {
    const sean = mkUser('Sean Ask'); const allie = mkUser('Allie Ask'); const bam = mkUser('Bam Ask');
    const done = pastPlan(sean, [allie], 30, { title: 'Done Dinner' });
    pastPlan(sean, [allie], 3, { title: 'Too Recent' });          // ended < 12h ago
    pastPlan(sean, [allie], 24 * 10, { title: 'Too Old' });        // > 7 days
    const declined = pastPlan(sean, [bam], 30, { status: 'declined', title: 'Bam Said No' });
    assert.deepEqual(cadence.plansToConfirm(sean).map((p) => p.title).sort(), ['Bam Said No', 'Done Dinner']);
    assert.deepEqual(cadence.plansToConfirm(allie).map((p) => p.id), [done]);
    assert.equal(cadence.plansToConfirm(bam).some((p) => p.id === declined), false, "a guest who said no isn't asked");
  });
});

describe('asking', () => {
  test('notifications off → one text (Y / N / skip), answered by text', async () => {
    const sean = mkUser('Sean Text'); const allie = mkUser('Allie Text');
    const id = pastPlan(sean, [allie], 30, { title: 'Text Dinner' });
    texts.length = 0;
    await cadence.runAttendanceGate();
    const t = texts.find((m) => m.to === allie.phone);
    assert.match(t.body, /Did you make it to Text Dinner/);
    const ac = db.getAttendanceConfirmation(id, allie.id);
    assert.ok(ac, 'asked once');
    await cadence.runAttendanceGate();
    assert.equal(texts.filter((m) => m.to === allie.phone).length, 1, 'never asked twice');
  });

  test('notifications on → no text; Home asks, with Yes / No / Skip', async () => {
    const sean = mkUser('Sean Push'); const allie = mkUser('Allie Push');
    db.upsertPushSubscription({ id: uuidv4(), user_id: allie.id, endpoint: 'https://push.example/' + allie.id, p256dh: 'k', auth: 'a' });
    const id = pastPlan(sean, [allie], 30, { title: 'Push Dinner' });
    texts.length = 0;
    await cadence.runAttendanceGate();
    assert.equal(texts.filter((m) => m.to === allie.phone).length, 0);
    const item = home.feedFor(allie.id).items.find((i) => i.type === 'checkin' && i.event_id === id);
    assert.ok(item, 'on Home');
    assert.equal(home.feedFor(allie.id).summary.happenings.needs_you, true);
  });
});

describe('answering', () => {
  test('Yes in the app: recorded, lift measured, cadences with the people there reset', async () => {
    const sean = mkUser('Sean Yes'); const allie = mkUser('Allie Yes');
    // Allie has a monthly cadence with Sean, last fulfilled 2 months ago.
    const relId = uuidv4();
    db.createRelationship({ id: relId, user_id: allie.id, contact_id: knows(allie, sean), contact_is_user: 0 });
    const cadId = uuidv4();
    db.createCadence({ id: cadId, relationship_id: relId, activity_type: 'dinner', frequency: 'monthly', group_size: 'one_on_one' });
    db._raw().prepare('UPDATE cadences SET last_fulfilled_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 60 * 86400, cadId);
    const id = pastPlan(sean, [allie], 30, { title: 'Yes Dinner' });
    db.upsertPushSubscription({ id: uuidv4(), user_id: allie.id, endpoint: 'https://push.example/y' + allie.id, p256dh: 'k', auth: 'a' });
    await cadence.runAttendanceGate();
    const ac = db.getAttendanceConfirmation(id, allie.id);
    const res = await request.post(`/api/attendance/${ac.id}`).set('Cookie', await cookieFor(allie)).send({ attended: true });
    assert.equal(res.status, 200);
    assert.equal(db.getAttendanceConfirmation(id, allie.id).attended, 1);
    const evDate = db._raw().prepare('SELECT scheduled_at FROM social_events WHERE id = ?').get(id).scheduled_at;
    assert.equal(db._raw().prepare('SELECT last_fulfilled_at FROM cadences WHERE id = ?').get(cadId).last_fulfilled_at, evDate);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(db._raw().prepare('SELECT count(*) c FROM lift_observations WHERE event_id = ?').get(id).c >= 4, 'lift measured for the plan');
    assert.equal(home.feedFor(allie.id).items.some((i) => i.type === 'checkin' && i.event_id === id), false, 'off Home');
  });

  test("someone else's check-in can't be answered", async () => {
    const sean = mkUser('Sean Own'); const allie = mkUser('Allie Own'); const bam = mkUser('Bam Own');
    const id = pastPlan(sean, [allie], 30, { title: 'Own Dinner' });
    await cadence.runAttendanceGate();
    const ac = db.getAttendanceConfirmation(id, allie.id);
    const res = await request.post(`/api/attendance/${ac.id}`).set('Cookie', await cookieFor(bam)).send({ attended: false });
    assert.equal(res.status, 404);
    assert.equal(db.getAttendanceConfirmation(id, allie.id).attended, null);
  });

  test('/api/dashboard/upcoming lists plans (not the old activities table)', async () => {
    const sean = mkUser('Sean Up');
    const id = multiparty.createEvent(sean.id, { title: 'Soon Plan', activity_type: 'dinner', scheduled_at: Math.floor(Date.now() / 1000) + 3 * 86400 });
    const res = await request.get('/api/dashboard/upcoming').set('Cookie', await cookieFor(sean));
    assert.deepEqual(res.body.upcoming.map((p) => p.id), [id]);
  });
});
