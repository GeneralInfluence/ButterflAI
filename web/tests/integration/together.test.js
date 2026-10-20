/**
 * together.test.js — 🐛 #44 (Sean, 2026-10-20): "I like these things about a quick call with Allie … The
 * things that need to be done, the creating, could be … things that you want to do together like Allie
 * and I did at lunch today. We ended up just chatting about stuff and figuring it out together and having
 * it over a drink and it was a lot of fun and so that by itself with other people who are involved or
 * relevant could be its own event".
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'together-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const planops = require('../../planops');
const todos = require('../../todos');
const spells = require('../../spells');

let n = 0;
function mkUser(name) {
  const phone = `+1202532${String(2000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, city) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', 'Reno')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (o, u) => db.upsertContact({ invited_by_user_id: o.id, name: u.name, phone: u.phone, tier: 1 });
async function weekend(host, guests) {
  const e = (await planops.create(host.id, { title: `Weekend ${n}`, scheduled_at: new Date(Date.now() + 5 * 86400e3).toISOString(), contact_ids: guests.map((g) => knows(host, g)) })).eventId;
  for (const g of guests) planops.respond(db._raw().prepare('SELECT ei.id FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?').get(e, g.phone).id, 'accepted', { by: 'guest', phone: g.phone });
  return e;
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
const guests = (e) => db._raw().prepare('SELECT c.phone FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ?').all(e).map((r) => r.phone);

describe('🐛 #44: 🍻 do a Creating item together', () => {
  test('a Creating item becomes its own small plan with the people on it — tentative, no date, one per item', async () => {
    const sean = mkUser('Sean T'); const allie = mkUser('Allie T'); const bam = mkUser('Bam T');
    const e = await weekend(sean, [allie, bam]);
    const item = todos.add(allie.id, e, { text: 'Massages' }).todo;
    todos.join(sean.id, item.id);
    const c = await cookieFor(sean);
    const r = await request.post(`/api/todos/${item.id}/together`).set('Cookie', c);
    assert.equal(r.status, 200);
    const p = db._raw().prepare('SELECT * FROM social_events WHERE id = ?').get(r.body.event_id);
    assert.equal(p.title, 'Massages — together');
    assert.equal(p.host_user_id, sean.id);
    assert.equal(p.tentative, 1);
    assert.match(p.notes, /Weekend/);
    assert.deepEqual(guests(r.body.event_id), [allie.phone], 'the people on it (Allie) — not everyone in the weekend');
    assert.equal((await request.post(`/api/todos/${item.id}/together`).set('Cookie', c)).body.event_id, r.body.event_id, 'asking again opens the same plan');
    assert.equal(todos.list(sean.id, e).todos.find((t) => t.id === item.id).together_event_id, r.body.event_id);
  });
  test('nobody else on it → the plan\'s host and co-hosts; not in the plan → refused', async () => {
    const sean = mkUser('Sean U'); const mel = mkUser('Mel U'); const stranger = mkUser('Stranger U');
    const e = await weekend(sean, [mel]);
    const item = todos.add(mel.id, e, { text: 'Cake' }).todo;
    const r = await todos.together(mel.id, item.id);
    assert.ok(r.ok);
    assert.deepEqual(guests(r.event_id), [sean.phone], 'the host');
    assert.equal((await todos.together(stranger.id, item.id)).error, 'NOT_FOUND');
  });
  test('ideas know what you\'re making happen and with whom — and are never chores', async () => {
    const sean = mkUser('Sean V'); const allie = mkUser('Allie V');
    const e = await weekend(sean, [allie]);
    const item = todos.add(allie.id, e, { text: 'Pick the restaurant' }).todo;
    todos.join(sean.id, item.id);
    const seen = [];
    spells._setClient({ messages: { create: async (req) => { seen.push(req); return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"spells":[]}' }] }; } } });
    await spells.generate(sean, { force: true });
    const prompt = seen[0].messages[0].content;
    assert.match(prompt, /Things they're making happen in their plans \(and who's on them\): Pick the restaurant \(Weekend \d+, with Allie\)/);
    assert.match(prompt, /figuring it out over a drink, a coffee or a quick call with the people on it/);
    assert.match(prompt, /never an errand, a chore or a reminder/);
  });
  test('Creating shows 🍻 Together on items not done yet', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/creating.html'), 'utf8');
    assert.ok(html.includes('🍻 Together') && html.includes("url + '/together'"));
  });
});
