/**
 * plan-parts.test.js — plans inside plans, and ＋ that makes the plan (owner, 2026-10-23). At Friday lunch Melanie and
 * Allie told their ButterflAIs the Friday plan for Melanie's birthday weekend: "Sean to take boys to press start at 5pm
 * … Allie and Mel will be watching practical magic". ＋ filed it as items on the weekend; "make this a separate event"
 * couldn't include Allie ("I don't have Allie in your contacts" — five times); Sean only got "Melanie changed the
 * details". Owner: a part of a plan has everyone in the bigger plan.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'plan-parts-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const supertest = require('supertest');

require('../../sms')._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const planops = require('../../planops');
const plan = require('../../plan');
const newplan = require('../../newplan');

let k = 0;
function mkUser(name) {
  const phone = `+1202544${String(1000 + k++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', 1700000000)").run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
const save = (owner, other, name = other.name) => db.upsertContact({ invited_by_user_id: owner.id, name, phone: other.phone, tier: 1 });
// Sean hosts the weekend; Melanie (saved by Sean, has Sean saved) and Allie (saved by Sean only — not Melanie's contact).
async function weekend() {
  const sean = mkUser('Sean W'), mel = mkUser('Melanie W'), allie = mkUser('Allie W');
  save(mel, sean, 'Sean');
  const r = await planops.create(sean.id, { title: `Melanie's Birthday Weekend ${k}`, activity_type: 'birthday', tentative: true, contact_ids: [save(sean, mel), save(sean, allie)] }, { via: 'agent' });
  db._raw().prepare("UPDATE event_invitations SET status = 'accepted' WHERE event_id = ?").run(r.eventId);
  return { sean, mel, allie, weekendId: r.eventId };
}
const invited = (eventId) => db._raw().prepare('SELECT c.phone FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ?').all(eventId).map((r) => r.phone).sort();
const WORDS = 'Sean to take boys to press start at 5pm Mel will bring the car and kids around 4-4:30 Allie and Mel will be watching practical magic';

describe('＋ makes the plan; a part has everyone in the bigger plan', () => {
  test('Melanie taps ＋ from the weekend: a new plan, part of it — Sean AND Allie are in, without Melanie having Allie\'s number', async () => {
    const { sean, mel, allie, weekendId } = await weekend();
    const c = await cookieFor(mel);
    const r = await request.post('/api/plans/new').set('Cookie', c).send({ text: WORDS, part_of: weekendId });
    assert.equal(r.status, 200);
    assert.equal(r.body.part_of, weekendId);
    assert.deepEqual(invited(r.body.event_id), [allie.phone, sean.phone].sort(), 'everyone in the weekend');
    assert.equal(plan.planFor(r.body.event_id, mel.id).part_of.id, weekendId);
    assert.ok(plan.planFor(weekendId, sean.id).parts.some((p) => p.id === r.body.event_id), 'the weekend shows its part');
    assert.ok(plan.planFor(r.body.event_id, allie.id), 'Allie sees it');
    // Allie's number stays hers: not in Melanie's People, not in what her agent sees.
    const list = (await request.get('/api/contacts/list').set('Cookie', c)).body.contacts;
    assert.ok(!list.some((x) => x.phone === allie.phone));
  });
  test('＋ outside any plan: the read finds it\'s part of the weekend; a day only if she said one; never folded into an existing plan', async () => {
    const { mel, weekendId } = await weekend();
    newplan._setClient({ messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify({ title: 'Press Start + Practical Magic', what: 'evening', when: 'Saturday 5pm', part_of: weekendId }) }] }) } });
    const made = await newplan.make(mel.id, 'Allie and Mel will be watching practical magic');   // no day, no time in her words
    assert.equal(made.part_of, weekendId);
    const e = db._raw().prepare('SELECT title, date_tbd FROM social_events WHERE id = ?').get(made.event_id);
    assert.deepEqual([e.title, e.date_tbd], ['Press Start + Practical Magic', 1], 'the invented "Saturday 5pm" isn\'t used');
    // She said a time but no day: the time stands, the model's "Saturday" doesn't — it's today.
    const timed = await newplan.make(mel.id, WORDS);
    newplan._setClient(null);
    const tz = 'America/Los_Angeles';
    const at = db._raw().prepare('SELECT scheduled_at FROM social_events WHERE id = ?').get(timed.event_id).scheduled_at;
    assert.equal(new Date(at * 1000).toLocaleDateString('en-CA', { timeZone: tz }), new Date().toLocaleDateString('en-CA', { timeZone: tz }));
    const again = await newplan.make(mel.id, 'Press Start + Practical Magic');
    assert.notEqual(again.event_id, made.event_id); assert.match(again.title, /\(\d\)$/, 'a new plan, never folded into the one with that name');
  });
  test('"make this a separate event" in the weekend\'s discussion: the agent\'s plan is part of the weekend', async () => {
    const { sean, mel, allie, weekendId } = await weekend();
    db._raw().prepare('UPDATE inbound_messages SET processed = 1').run();
    db.storeInboundMessage({ from_phone: mel.phone, from_type: 'user', from_id: mel.id, channel: 'webchat', text: `${WORDS} make this a separate event`, event_id: weekendId });
    let i = 0;
    agent._setAnthropic({ messages: { create: async () => (i++ === 0
      ? { id: 'a', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'create_social_event', input: { title: 'Practical Magic', activity_type: 'movie', when: 'tomorrow 5pm' } }] }
      : { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Made it.' }] }) } });
    await agent.tick();
    const pm = db._raw().prepare("SELECT id, parent_id FROM social_events WHERE host_user_id = ? AND title = 'Practical Magic'").get(mel.id);
    assert.equal(pm.parent_id, weekendId);
    assert.deepEqual(invited(pm.id), [allie.phone, sean.phone].sort());
  });
  test('lookup_contact finds someone you share a plan with — no number shown', async () => {
    const { mel, allie, weekendId } = await weekend();
    const r = await agent.executeTool('lookup_contact', { query: 'Allie' }, mel.id, mel.phone);
    const a = r.contacts.find((x) => x.name === 'Allie W');
    assert.ok(a, JSON.stringify(r));
    assert.equal(a.phone, undefined);
    assert.match(a.why, /in Melanie's Birthday Weekend/);
    assert.equal(a.on_butterflai, true);
    assert.ok(weekendId);
  });
  test('the bigger plan\'s people follow into its parts: someone added later is invited; someone removed leaves', async () => {
    const { sean, mel, weekendId } = await weekend();
    const part = await planops.create(mel.id, { title: 'Friday evening', activity_type: 'evening', part_of: weekendId }, { via: 'app' });
    const bam = mkUser('Bam W');
    await planops.invite(sean.id, weekendId, [save(sean, bam)]);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(invited(part.eventId).includes(bam.phone), 'Bam is in the part too');
    const inv = db._raw().prepare('SELECT ei.id FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?').get(weekendId, bam.phone);
    planops.removeGuest(sean.id, weekendId, inv.id);
    assert.ok(!invited(part.eventId).includes(bam.phone), 'and leaves it');
  });
  test('sharing a plan doesn\'t make people close: no whispers, no wishes matching, no shares, unless they saved each other', async () => {
    const { mel, allie, weekendId } = await weekend();
    await planops.create(mel.id, { title: 'Friday evening', activity_type: 'evening', part_of: weekendId }, { via: 'app' });
    assert.equal(db._raw().prepare('SELECT hidden FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(mel.id, allie.phone).hidden, 1);
    const fs = require('fs'); const path = require('path');
    for (const f of ['whispers.js', 'wishes.js', 'outnow.js', 'feeling.js', 'spells.js']) assert.match(fs.readFileSync(path.join(__dirname, '../../', f), 'utf8'), /COALESCE\((\w\.)?hidden, 0\) = 0/, f);
    save(mel, allie, 'Allie');   // saving her makes it a real contact
    assert.equal(db._raw().prepare('SELECT hidden FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(mel.id, allie.phone).hidden, 0);
  });
  test('only someone in the bigger plan can make a part of it', async () => {
    const { weekendId } = await weekend();
    const stranger = mkUser('Stranger W');
    assert.equal((await planops.create(stranger.id, { title: 'Crash it', activity_type: 'x', part_of: weekendId }, { via: 'app' })).error, 'PART_OF_NOT_FOUND');
  });
});

// Owner, 2026-10-23: "the person might just be in another event, hit plus, and be thinking about a general event. And
// so they should be able to switch between the two."
describe('part of the plan, or its own — their choice', () => {
  test('＋ inside a plan offers both; "Separate plan" makes a plan of its own (no invites from the bigger plan)', async () => {
    const js = require('fs').readFileSync(require('path').join(__dirname, '../../public/feedback.js'), 'utf8');
    assert.match(js, /🧩 Part of \$\{inPlanTitle[\s\S]*✨ Separate plan/);
    assert.match(js, /\.\.\.\(partChoice \? \{ part_of: partChoice \} : \{ separate: true \}\)/);
    const { mel, weekendId } = await weekend();
    newplan._setClient({ messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify({ title: 'Girls night', what: 'night', when: null, part_of: weekendId }) }] }) } });
    const r = await request.post('/api/plans/new').set('Cookie', await cookieFor(mel)).send({ text: 'girls night sometime', separate: true });
    newplan._setClient(null);
    assert.equal(r.body.part_of, null);
    assert.deepEqual(invited(r.body.event_id), [], 'nobody from the weekend');
  });
  test('a part can be made a separate plan later (its people stay)', async () => {
    const { sean, mel, allie, weekendId } = await weekend();
    const part = await planops.create(mel.id, { title: 'Friday evening x', activity_type: 'evening', part_of: weekendId }, { via: 'app' });
    const r = await request.patch(`/api/events/${part.eventId}`).set('Cookie', await cookieFor(mel)).send({ part_of: null });
    assert.equal(r.status, 200);
    assert.equal(plan.planFor(part.eventId, mel.id).part_of, null);
    assert.deepEqual(invited(part.eventId), [allie.phone, sean.phone].sort());
    assert.match(require('fs').readFileSync(require('path').join(__dirname, '../../public/app/events.html'), 'utf8'), /make it a separate plan/);
  });
});
