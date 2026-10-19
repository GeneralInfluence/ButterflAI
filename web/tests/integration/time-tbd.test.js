/**
 * time-tbd.test.js — 🐛 #22 (Sean, 2026-10-19): "Why is there a Rocky Horror Picture Show on
 * the 30th and the 31st? I only said the 30th. I also didn't give a time so we don't know if
 * it's 7:00 or some other time." And: asked to add Allie, Alexandria and Melanie, the agent
 * texted them (there was no way to add people to an existing plan) — the plan had no guests.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'time-tbd-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
require('../../server');
const db = require('../../db');
const agent = require('../../agent');
const planops = require('../../planops');
const plan = require('../../plan');
const datetime = require('../../datetime');

let n = 0;
function mkUser(name) {
  const phone = `+1202541${String(7000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (o, u) => db.upsertContact({ invited_by_user_id: o.id, name: u.name, phone: u.phone, tier: 1 });
const THE_30TH = datetime.resolveDateOnly('October 30', 'America/Los_Angeles').date;

/** One turn: the user says `text`; the model calls `tool` with `input`. */
async function turn(u, text, tool, input, extra = {}) {
  let out = null;
  agent._setAnthropic({ messages: { create: async (req) => {
    const tr = Array.isArray(req.messages.at(-1).content) && req.messages.at(-1).content.find((b) => b.type === 'tool_result');
    if (tr) { out = JSON.parse(tr.content); return { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }; }
    return { id: 'a', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: tool, input }] };
  } } });
  db.storeInboundMessage({ from_phone: u.phone, from_type: 'user', from_id: u.id, channel: 'webchat', text, ...extra });
  await agent.tick();
  return out;
}

describe('🐛 #22: the 30th is one day, and no time he didn\'t give', () => {
  test('"the weekend of the 30th …" with the model adding "Saturday … evening" → Fri the 30th, time TBD', async () => {
    const sean = mkUser('Sean T');
    const r = await turn(sean, "the weekend of the 30th we got tickets to The Rocky Horror Picture Show", 'create_social_event',
      { title: 'Rocky Horror Picture Show', activity_type: 'show', when: 'Saturday, October 30 evening', tentative: true });
    const p = plan.planFor(r.eventId, sean.id);
    assert.deepEqual(p.days, [THE_30TH], 'one day, the 30th');
    assert.equal(p.dates.time_tbd, true);
    assert.match(p.dates.label, /· time TBD$/);
    assert.doesNotMatch(p.dates.label, /7:00/);
  });
  test('a scheduled_at with a made-up time becomes that day, time TBD', async () => {
    const sean = mkUser('Sean T2');
    const r = await turn(sean, 'Rocky Horror on october 30', 'create_social_event',
      { title: 'Rocky Horror', scheduled_at: `${THE_30TH}T19:00:00-07:00` });
    assert.equal(plan.planFor(r.eventId, sean.id).dates.time_tbd, true);
  });
  test('when he does say a time, it\'s kept; setting a time later clears "time TBD"', async () => {
    const sean = mkUser('Sean T3');
    const r = await turn(sean, 'Rocky Horror october 30 at 8pm', 'create_social_event', { title: 'Rocky Horror 8', when: 'October 30 at 8pm' });
    assert.equal(plan.planFor(r.eventId, sean.id).dates.time_tbd, undefined);
    const e = (await turn(sean, 'show is on october 30', 'create_social_event', { title: 'Show TBD', when: 'October 30' })).eventId;
    planops.update(sean.id, e, { when: 'October 30 at 9pm' });
    const p = plan.planFor(e, sean.id);
    assert.equal(p.dates.time_tbd, undefined);
    assert.match(p.dates.label, /9:00 PM/);
  });
  test('Google/Apple Calendar get an all-day entry for a time-TBD day', async () => {
    const sean = mkUser('Sean T4');
    const e = (await planops.create(sean.id, { title: 'All day thing', when: 'October 30' })).eventId;
    const [entry] = require('../../calmirror').desired(sean.id, e);
    assert.deepEqual(entry.body.start, { date: THE_30TH });
  });
});

describe('adding people to an existing plan', () => {
  test('"add them both as well as Melanie" → they are guests on the plan (not just texted)', async () => {
    const sean = mkUser('Sean A'); const allie = mkUser('Allie A'); const alex = mkUser('Alexandria A'); const mel = mkUser('Melanie A');
    const e = (await planops.create(sean.id, { title: 'Rocky Horror', when: 'October 30' })).eventId;
    const ids = [allie, alex, mel].map((u) => knows(sean, u));
    const r = await turn(sean, 'Yes, add them both as well as Melanie', 'update_event', { event_id: e, invite_contact_ids: ids });
    assert.equal(r.ok, true);
    assert.deepEqual(plan.planFor(e, sean.id).people.map((x) => x.name).sort(), ['Alexandria', 'Allie', 'Melanie']);
    assert.ok(plan.planFor(e, allie.id), 'Allie sees the plan');
  });
  test('only the host adds people (for now); others are told to ask the host', async () => {
    const sean = mkUser('Sean B'); const mel = mkUser('Melanie B'); const bam = mkUser('Bam B');
    const e = (await planops.create(sean.id, { title: "Melanie's Party", contact_ids: [knows(sean, mel)] })).eventId;
    const r = await turn(mel, 'add Bam', 'update_event', { event_id: e, invite_contact_ids: [knows(mel, bam)] });
    assert.equal(r.error, 'HOST_INVITES');
  });
});

describe('retro for 🐛 #22', () => {
  const task = (id) => require('../../retro').TASKS.find((t) => t.id === id);
  test('Oct 30 – Nov 1 → Fri Oct 30, time TBD; Allie, Alexandria and Melanie invited; correction offered', async () => {
    const sean = mkUser('Sean R'); const allie = mkUser('Allie R'); const alex = mkUser('Alexandria R'); const mel = mkUser('Melanie R');
    for (const u of [allie, alex, mel]) knows(sean, u);
    const e = (await planops.create(sean.id, { title: 'Rocky Horror Picture Show', proposed_dates: [{ from: '2026-10-30', to: '2026-11-01' }] })).eventId;
    db._raw().prepare("INSERT INTO conversation_history (id, user_id, role, text) VALUES (?, ?, 'assistant', ?)").run(uuidv4(), sean.id, '📤 To Allie (in ButterflAI): Rocky Horror Picture Show this weekend — Fri Oct 30 through Sun Nov 1. You all have tickets.');
    assert.match(await task('2026-10-19-rocky-horror-just-the-30th').run(sean), /^Oct 30, time TBD; invited 3/);
    const p = plan.planFor(e, sean.id);
    assert.deepEqual([p.dates.kind, p.dates.time_tbd, p.dates.proposals.length], ['set', true, 0]);
    assert.match(p.dates.label, /^Fri, Oct 30 · time TBD$/);
    assert.equal(p.people.length, 3);
    assert.equal(await task('2026-10-19-rocky-horror-just-the-30th').run(sean), 'not as left', 'once');
    assert.equal(await task('2026-10-19-rocky-horror-correction').run(sean), 'offered');
  });
});
