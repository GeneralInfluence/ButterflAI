/**
 * feedback-cases.test.js — every 🐛 becomes a test (owner, 2026-10-13).
 *
 * Replays every case in tests/fixtures/feedback/*.json: rebuilds the plan from the
 * anonymized case (people as stand-ins, dates shifted so they're as far from today as they
 * were from the day it was reported), then checks the fixture's "expect" against the plan
 * as the reporter sees it (plan.js). Also: how cases are captured and kept.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'feedback-cases-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const planops = require('../../planops');
const plan = require('../../plan');

const DIR = path.join(__dirname, '../fixtures/feedback');
let n = 0;
function mkUser(name) {
  const phone = `+1202549${String(4000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const shift = (d, days) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); };
const get = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Rebuild the case's plan and return it as the reporter ("Viewer") sees it. */
async function replay(fx) {
  const c = fx.case;
  const offset = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(fx.reported || c.reported)) / 86400000);
  const users = new Map();
  const userFor = (name) => { if (!users.has(name)) users.set(name, mkUser(`${name} ${fx.feedback_id ?? 'x'}${n}`)); return users.get(name); };
  const viewer = userFor('Viewer');
  const p = c.plan;
  const host = p.role === 'host' ? viewer : userFor(p.host);
  const d = p.dates || {};
  const input = { title: p.title, activity_type: p.what || 'hangout', venue_name: p.place || undefined, notes: p.notes || undefined, tentative: p.tentative };
  if (d.kind === 'proposed') input.proposed_dates = d.proposals.map((o) => ({ from: shift(o.from, offset), to: shift(o.to, offset) }));
  else if (d.kind === 'set' && d.days?.length) input.scheduled_at = `${shift(d.days[0], offset)}T19:00:00-07:00`;
  else if (d.kind === 'open') input.flexible_time = true;
  const made = await planops.create(host.id, input);
  assert.ok(made.eventId, `${fx.feedback_id ?? 'example'}: plan rebuilt (${made.error || ''})`);
  const guests = [...p.people.map((x) => x.name), ...(p.role === 'guest' ? ['Viewer'] : [])].filter((x) => x !== p.host);
  await planops.invite(host.id, made.eventId, guests.map((g) => knows(host, userFor(g))));
  const inv = (u) => db._raw().prepare('SELECT ei.id FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?').get(made.eventId, u.phone)?.id;
  for (const person of p.people) {
    const u = userFor(person.name);
    if (person.deferring_to?.length) {
      planops.deferOn(u.id, { invitation_id: inv(u), defer_to: person.deferring_to.map((x) => (x === 'you' ? p.host === 'Viewer' ? 'Viewer' : p.host : x)) });
    } else if (person.status === 'accepted' || person.status === 'declined') {
      planops.respond(inv(u), person.status, { by: 'guest', phone: u.phone });
    }
  }
  if (p.role === 'guest' && p.invitation && p.invitation.status !== 'invited') planops.respond(inv(viewer), p.invitation.status, { by: 'guest', phone: viewer.phone });
  return plan.planFor(made.eventId, viewer.id);
}

describe('every 🐛 case still holds', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  test('there are cases (and each says what should be true)', () => {
    assert.ok(files.length >= 1);
    for (const f of files) {
      const fx = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      assert.ok(fx.case?.plan && Object.keys(fx.expect || {}).length, `${f}: needs case.plan and at least one expectation`);
    }
  });
  for (const f of files) {
    test(f, async () => {
      const fx = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      const rebuilt = await replay(fx);
      for (const [key, want] of Object.entries(fx.expect)) {
        if (key.endsWith('~')) assert.ok(String(get(rebuilt, key.slice(0, -1)) ?? '').includes(want), `${f}: ${key} ${JSON.stringify(want)} in ${JSON.stringify(get(rebuilt, key.slice(0, -1)))}`);
        else assert.deepEqual(get(rebuilt, key), want, `${f}: ${key}`);
      }
    });
  }
});

describe('capturing cases', () => {
  async function cookieFor(u) {
    await request.post('/auth/otp/send').send({ phone: u.phone });
    const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
    return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
  }
  test('a 🐛 on a plan saves an anonymized case: stand-ins, no phones, ids or links', async () => {
    const sean = mkUser('Sean Gonzalez'); const allie = mkUser('Allie McLaine');
    const r = await planops.create(sean.id, { title: "Allie's Birthday at Sully's", tentative: true, proposed_dates: [{ from: shift(new Date().toISOString().slice(0, 10), 10), to: shift(new Date().toISOString().slice(0, 10), 11) }],
      contact_ids: [knows(sean, allie)], notes: `Call Allie at ${allie.phone} or allie@example.com, see https://butterflai.social/app/events?event=${uuidv4()}` });
    db._raw().prepare(`INSERT INTO conversation_history (id, user_id, role, text, event_id) VALUES (?, ?, 'user', ?, ?)`).run(uuidv4(), sean.id, 'Allie McLaine says Saturday works', r.eventId);
    const res = await request.post('/api/feedback').set('Cookie', await cookieFor(sean)).send({ note: 'Allie is missing from the calendar', page: '/app/events', state: { screen: 'events', event_id: r.eventId } });
    assert.equal(res.status, 200);
    const row = db._raw().prepare('SELECT case_json FROM feedback WHERE id = ?').get(res.body.id);
    const c = JSON.parse(row.case_json);
    const text = row.case_json;
    for (const bad of ['Sean', 'Allie', 'McLaine', 'Gonzalez', allie.phone, 'allie@example.com', 'butterflai.social', r.eventId]) assert.ok(!text.includes(bad), `no ${bad}`);
    assert.equal(c.plan.title, "Aspen's Birthday at Sully's");
    assert.equal(c.note, 'Aspen is missing from the calendar');
    assert.equal(c.plan.host, 'Viewer');
    assert.deepEqual(c.plan.people.map((x) => x.name), ['Aspen']);
    assert.match(c.plan.notes, /Call Aspen at <phone> or <email>, see <link>/);
    assert.equal(c.conversation.at(-1).text, 'Aspen says Saturday works');
    assert.ok(c.history.some((h) => h.field === 'created'));
  });

  test('a case can be replayed straight from what was captured', async () => {
    const sean = mkUser('Sean Replay'); const bam = mkUser('Bam Replay');
    const r = await planops.create(sean.id, { title: 'Replay Dinner', scheduled_at: `${shift(new Date().toISOString().slice(0, 10), 5)}T19:00:00-07:00`, contact_ids: [knows(sean, bam)] });
    planops.respond(db._raw().prepare('SELECT id FROM event_invitations WHERE event_id = ?').get(r.eventId).id, 'accepted', { by: 'guest', phone: bam.phone });
    const c = require('../../feedbackcase').build(sean.id, { state: { event_id: r.eventId } });
    const rebuilt = await replay({ feedback_id: 't', reported: c.reported, case: c, expect: {} });
    assert.equal(rebuilt.stage, c.plan.stage);
    assert.deepEqual(rebuilt.interested, c.plan.people.filter((x) => x.status === 'accepted').map((x) => x.name));
  });

  test('"fixed" needs the test that covers it; the case outlives the screenshot', async () => {
    const admin = mkUser('Admin Person');
    process.env.ADMIN_PHONE = admin.phone;
    const cookie = await cookieFor(admin);
    const id = db.createFeedback({ user_id: admin.id, rating: 'down', user_note: 'x', context_json: '[{"role":"user","text":"hi"}]', state_json: '{}' });
    db._raw().prepare("UPDATE feedback SET case_json = '{\"version\":1}', created_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) - 91 * 86400, id);
    const no = await request.patch(`/api/admin/feedback/${id}`).set('Cookie', cookie).send({ status: 'fixed' });
    assert.equal(no.status, 400);
    assert.equal(no.body.error, 'TEST_REQUIRED');
    const yes = await request.patch(`/api/admin/feedback/${id}`).set('Cookie', cookie).send({ status: 'fixed', test_ref: `tests/fixtures/feedback/${id}.json` });
    assert.equal(yes.status, 200);
    require('../../coord-loop').tickPurge();
    const row = db._raw().prepare('SELECT state_json, context_json, case_json FROM feedback WHERE id = ?').get(id);
    assert.equal(row.state_json, null);
    assert.equal(row.context_json, null, 'the raw conversation (real names) goes at 90 days too');
    assert.equal(row.case_json, '{"version":1}', 'the anonymized case stays');
  });
});
