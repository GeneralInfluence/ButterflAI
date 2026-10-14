/**
 * calendar-mirror.test.js — a person's Google Calendar reflects their ButterflAI calendar
 * (owner, 2026-10-13), and a new guest sees the plan's Creating list.
 * Google is a stand-in that records what would be written.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'calendar-mirror-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const planops = require('../../planops');
const todos = require('../../todos');
const calmirror = require('../../calmirror');
const retro = require('../../retro');

// Stand-in Google Calendar: { userId: Map(gid → body) }
const cals = {}; const connected = new Set(); let calls = 0; let gidN = 0;
calmirror._setGoogle({
  connected: (u) => connected.has(u),
  upsert: async (u, gid, body) => { calls++; const m = (cals[u] ||= new Map()); const id = gid && m.has(gid) ? gid : 'g' + (++gidN); m.set(id, body); return id; },
  remove: async (u, gid) => { calls++; cals[u]?.delete(gid); },
});
const entries = (u) => [...(cals[u.id] || new Map()).values()];

let n = 0;
function mkUser(name, { google = true } = {}) {
  const phone = `+1202559${String(7000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', ?)`)
    .run(uuidv4(), name, phone, Date.UTC(2026, 8, 1) / 1000);
  db.writeConsent(phone, 'INVITE_PAGE');
  const u = db.getUserByPhone(phone);
  if (google) connected.add(u.id);
  return u;
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const invOf = (eventId, u) => db._raw().prepare(`SELECT ei.id FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?`).get(eventId, u.phone).id;
const inDays = (d) => new Date(Date.now() + d * 86400e3).toISOString();
const day = (d) => inDays(d).slice(0, 10);
const settle = () => calmirror.flush();

describe('Google Calendar follows ButterflAI', () => {
  test('a dated plan goes on the host’s calendar and moves when the date moves (same entry)', async () => {
    const sean = mkUser('Sean Cal');
    const r = await planops.create(sean.id, { title: 'Dinner at Sully’s', scheduled_at: inDays(5), venue_name: 'Sully’s' });
    await settle();
    assert.equal(entries(sean).length, 1);
    const [e] = entries(sean);
    assert.equal(e.summary, 'Dinner at Sully’s');
    assert.equal(e.location, 'Sully’s');
    assert.equal(e.status, 'confirmed');
    assert.equal(e.extendedProperties.private.butterflai_event, r.eventId);
    planops.update(sean.id, r.eventId, { scheduled_at: inDays(6) });
    await settle();
    assert.equal(entries(sean).length, 1, 'updated in place, not duplicated');
    assert.equal(entries(sean)[0].start.dateTime, new Date(inDays(6)).toISOString().replace(/\.\d+Z$/, '.000Z').slice(0, 16) + entries(sean)[0].start.dateTime.slice(16));
  });

  test('proposed dates show as tentative all-day options; choosing a date replaces them', async () => {
    const sean = mkUser('Sean Prop');
    const r = await planops.create(sean.id, { title: 'Bday Weekend', proposed_dates: [{ from: day(20), to: day(21) }, { from: day(27), to: day(28) }] });
    await settle();
    const opts = entries(sean);
    assert.equal(opts.length, 2);
    assert.ok(opts.every((o) => o.summary === 'Bday Weekend (proposed)' && o.status === 'tentative' && o.transparency === 'transparent' && o.start.date));
    planops.update(sean.id, r.eventId, { scheduled_at: inDays(20) });
    await settle();
    assert.equal(entries(sean).length, 1);
    assert.ok(entries(sean)[0].start.dateTime);
  });

  test('a guest: tentative "(invited)" until they answer; firm when in; gone when out', async () => {
    const sean = mkUser('Sean Host'); const allie = mkUser('Allie Guest');
    const r = await planops.create(sean.id, { title: 'Movie Night', scheduled_at: inDays(4), contact_ids: [knows(sean, allie)] });
    await settle();
    assert.equal(entries(allie)[0].summary, 'Movie Night (invited)');
    assert.equal(entries(allie)[0].status, 'tentative');
    planops.respond(invOf(r.eventId, allie), 'accepted', { by: 'guest', phone: allie.phone });
    await settle();
    assert.equal(entries(allie)[0].summary, 'Movie Night');
    assert.equal(entries(allie)[0].transparency, 'opaque');
    planops.respond(invOf(r.eventId, allie), 'declined', { by: 'guest', phone: allie.phone });
    await settle();
    assert.equal(entries(allie).length, 0);
    assert.equal(entries(sean).length, 1, "the host's stays");
  });

  test('cancelling removes it from everyone’s calendar', async () => {
    const sean = mkUser('Sean Cancel'); const allie = mkUser('Allie Cancel');
    const r = await planops.create(sean.id, { title: 'Hike', scheduled_at: inDays(3), contact_ids: [knows(sean, allie)] });
    planops.respond(invOf(r.eventId, allie), 'accepted', { by: 'guest', phone: allie.phone });
    await settle();
    planops.update(sean.id, r.eventId, { cancel: true });
    await settle();
    assert.equal(entries(sean).length + entries(allie).length, 0);
  });

  test('date TBD shows nothing; nothing is rewritten when nothing changed', async () => {
    const sean = mkUser('Sean Tbd');
    const r = await planops.create(sean.id, { title: 'Someday Trip' });
    await settle();
    assert.equal(entries(sean).length, 0);
    planops.update(sean.id, r.eventId, { notes: 'bring a tent' });
    const before = calls;
    await settle();
    assert.equal(calls, before, 'no Google calls');
  });

  test('without Google connected nothing is written; a failure is retried', async () => {
    const pat = mkUser('Pat NoCal', { google: false });
    await planops.create(pat.id, { title: 'Pat Plan', scheduled_at: inDays(2) });
    await settle();
    assert.equal(entries(pat).length, 0);
    const kim = mkUser('Kim Flaky');
    const real = calmirror._setGoogle;
    let fail = true;
    calmirror._setGoogle({ connected: () => true, upsert: async () => { if (fail) throw new Error('rate limited'); return 'gk'; }, remove: async () => {} });
    const r = await planops.create(kim.id, { title: 'Kim Plan', scheduled_at: inDays(2) });
    await settle();
    assert.match(db._raw().prepare('SELECT last_error FROM calendar_mirror WHERE user_id = ? AND event_id = ?').get(kim.id, r.eventId).last_error, /rate limited/);
    fail = false;
    await settle();
    assert.equal(db._raw().prepare('SELECT dirty FROM calendar_mirror WHERE user_id = ? AND event_id = ?').get(kim.id, r.eventId).dirty, 0);
    real({ connected: (u) => connected.has(u), upsert: async (u, gid, body) => { calls++; const m = (cals[u] ||= new Map()); const id = gid && m.has(gid) ? gid : 'g' + (++gidN); m.set(id, body); return id; },
      remove: async (u, gid) => { calls++; cals[u]?.delete(gid); } });
  });

  test('Settings: turning it off removes ButterflAI entries; on puts them back', async () => {
    const sean = mkUser('Sean Toggle');
    await planops.create(sean.id, { title: 'Toggle Plan', scheduled_at: inDays(8) });
    await settle();
    assert.equal(entries(sean).length, 1);
    await request.post('/auth/otp/send').send({ phone: sean.phone });
    const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(sean.phone);
    const cookie = (await request.post('/auth/otp/verify').send({ phone: sean.phone, code })).headers['set-cookie'][0];
    assert.equal((await request.patch('/api/user/calendar-mirror').set('Cookie', cookie).send({ on: false })).status, 200);
    await settle();
    assert.equal(entries(sean).length, 0);
    await request.patch('/api/user/calendar-mirror').set('Cookie', cookie).send({ on: true });
    await settle();
    assert.equal(entries(sean).length, 1);
  });

  test('the RSVP tool no longer makes its own (soon stale) calendar entry', async () => {
    const sean = mkUser('Sean Tool'); const allie = mkUser('Allie Tool');
    const r = await planops.create(sean.id, { title: 'Tool Plan', scheduled_at: inDays(9), contact_ids: [knows(sean, allie)] });
    const out = await agent.executeTool('confirm_coordination_invite', { invitation_id: invOf(r.eventId, allie), status: 'accepted', add_to_calendar: true }, allie.id, allie.phone);
    assert.equal(out.calendar, 'on_calendar_automatically');
    await settle();
    assert.equal(entries(allie).length, 1, 'one entry — the mirrored one');
  });

  test('retro: plans people are already in go onto their calendar, and they are told once', async () => {
    const sean = mkUser('Sean Retro');
    const id = multiparty().createEvent(sean.id, { title: 'Old Plan', activity_type: 'dinner', scheduled_at: Math.floor(Date.now() / 1000) + 9 * 86400 });   // made before mirroring
    const t = retro.TASKS.find((x) => x.id === '2026-10-13-plans-onto-google-calendar');
    assert.equal(await t.run(sean), 'marked 1');
    assert.equal(entries(sean).some((e) => e.extendedProperties.private.butterflai_event === id), true);
    assert.match(db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND kind = 'notice' ORDER BY rowid DESC").get(sean.id).text, /now on your Google Calendar/);
  });
});
function multiparty() { return require('../../multiparty'); }

describe('a new guest sees Creating', () => {
  test('invited to a plan with to-dos: one notice in its chat with the list', async () => {
    const sean = mkUser('Sean Todo'); const allie = mkUser('Allie Todo'); const bam = mkUser('Bam Todo');
    const r = await planops.create(sean.id, { title: 'Grover Trip', scheduled_at: inDays(15), contact_ids: [knows(sean, bam)] });
    todos.add(sean.id, r.eventId, { text: 'Book the campsite', assignee: 'Bam' });
    todos.add(sean.id, r.eventId, { text: 'Bring the cooler' });
    await planops.invite(sean.id, r.eventId, [knows(sean, allie)]);
    const note = db._raw().prepare("SELECT text, event_id FROM conversation_history WHERE user_id = ? AND kind = 'notice' ORDER BY rowid DESC").get(allie.id);
    assert.equal(note.event_id, r.eventId);
    assert.match(note.text, /Creating for Grover Trip — 2 to do/);
    assert.match(note.text, /☐ Book the campsite \(Bam\)/);
    assert.match(note.text, /☐ Bring the cooler — anyone can take it/);
  });
  test('no to-dos, no notice', async () => {
    const sean = mkUser('Sean Empty'); const allie = mkUser('Allie Empty');
    await planops.create(sean.id, { title: 'Empty Plan', scheduled_at: inDays(15), contact_ids: [knows(sean, allie)] });
    assert.equal(db._raw().prepare("SELECT count(*) c FROM conversation_history WHERE user_id = ? AND kind = 'notice' AND text LIKE '%Creating for%'").get(allie.id).c, 0);
  });
});

// The migration runner splits on ';' — a semicolon in a comment breaks the file (049/050
// both had one; 050's made calendar_mirror silently never exist).
describe('migrations', () => {
  test('no semicolons in SQL comments', () => {
    const fs = require('node:fs'); const path = require('node:path');
    for (const dir of ['../../db/migrations', '../../../db/migrations']) {
      const d = path.join(__dirname, dir);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.sql') && x >= '049')) {
        const bad = fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter((l) => /^\s*--.*;/.test(l));
        assert.deepEqual(bad, [], f);
      }
    }
  });
});
