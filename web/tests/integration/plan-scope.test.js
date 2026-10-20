/**
 * plan-scope.test.js — a change stays inside the plan being discussed (Sean, 2026-10-13:
 * "updates to Liam's birthday affected Melanie's birthday. We have some sort of
 * architecture issue"). In Liam's Birthday Party's discussion Sean wrote "the time is from
 * noon till closing which is 6:00…"; the agent updated Liam's party AND rewrote Melanie's
 * Birthday Weekend (dropped "Friday: massage", her proposed dates, set a wrong date).
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'plan-scope-test';
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

let n = 0;
function mkUser(name) {
  const phone = `+1202545${String(5000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', ?)`)
    .run(uuidv4(), name, phone, Date.UTC(2026, 8, 1) / 1000);
  return db.getUserByPhone(phone);
}
const row = (id) => db._raw().prepare('SELECT * FROM social_events WHERE id = ?').get(id);
const LIAM_SAID = "the time is from noon till closing which is 6:00 but I don't expect the kids to last that long it'll probably just go to 3 hours at most";

async function twoPlans() {
  const sean = mkUser('Sean Scope');
  const mel = await planops.create(sean.id, { title: "Melanie's Birthday Weekend", proposed_dates: [{ from: '2027-01-08', to: '2027-01-09' }],
    notes: 'Friday: massage. Saturday: Hot springs, dinner at Sassafras' });
  const liam = await planops.create(sean.id, { title: "Liam's Birthday Party", proposed_dates: [{ from: '2027-01-10', to: '2027-01-10' }], notes: 'Reservation made.' });
  return { sean, mel: mel.eventId, liam: liam.eventId };
}
async function turn(user, eventId, text, toolCalls) {
  let i = 0; const results = [];
  const steps = [{ id: 'a', stop_reason: 'tool_use', content: toolCalls.map((c, k) => ({ type: 'tool_use', id: 't' + k, name: c.name, input: c.input })) },
    { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] }];
  agent._setAnthropic({ messages: { create: async (req) => {
    for (const m of req.messages || []) for (const c of Array.isArray(m.content) ? m.content : []) if (c.type === 'tool_result') { try { results.push(JSON.parse(c.content)); } catch (_) {} }
    return steps[Math.min(i++, steps.length - 1)];
  } } });
  db.storeInboundMessage({ from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'webchat', text, event_id: eventId });
  await agent.tick();
  return results;
}

describe("a change stays inside the plan being discussed", () => {
  test("exact regression: in Liam's discussion, Melanie's plan can't be changed", async () => {
    const w = await twoPlans();
    const before = row(w.mel);
    const results = await turn(w.sean, w.liam, LIAM_SAID, [
      { name: 'update_event', input: { event_id: w.liam, scheduled_at: '2027-01-10T12:00:00-08:00', notes: 'Noon–6, kids ~3 hours' } },
      { name: 'update_event', input: { event_id: w.mel, notes: "Carson City Hot Springs + massage. Flexible — kids likely won't stay", scheduled_at: '2027-01-02T10:00:00-08:00' } },
    ]);
    assert.equal(results[0].ok, true, "Liam's party is updated");
    assert.equal(results[1].error, 'OTHER_PLAN');
    assert.match(results[1].message, /talking about "Liam's Birthday Party"\. Don't change "Melanie's Birthday Weekend"/);
    const after = row(w.mel);
    for (const k of ['notes', 'proposed_dates', 'date_tbd', 'flexible_time', 'scheduled_at']) assert.equal(after[k], before[k], `Melanie's ${k} untouched`);
  });

  test('to-dos too', async () => {
    const w = await twoPlans();
    const r = await turn(w.sean, w.liam, 'add balloons', [{ name: 'manage_todos', input: { event_id: w.mel, action: 'add', items: ['Balloons'] } }]);
    assert.equal(r[0].error, 'OTHER_PLAN');
  });

  test("naming the other plan allows it", async () => {
    const w = await twoPlans();
    const r = await turn(w.sean, w.liam, "also, Melanie's weekend dinner is at Sassafras", [{ name: 'update_event', input: { event_id: w.mel, venue_name: 'Sassafras' } }]);
    assert.equal(r[0].ok, true);
    assert.equal(row(w.mel).venue_name, 'Sassafras');
  });

  test('outside a plan (All), the agent can work on any plan', async () => {
    const w = await twoPlans();
    const r = await turn(w.sean, null, 'set the weekend notes', [{ name: 'update_event', input: { event_id: w.mel, notes: 'x' } }]);
    assert.equal(r[0].ok, true);
  });
});

describe('undo from the change log', () => {
  test('revert puts every field back as it was before that moment, and logs it', async () => {
    const w = await twoPlans();
    const before = row(w.mel);
    // via 'app': since 🐛 #25 the agent can't drop a multi-day range by setting one date (WOULD_DROP_DAYS).
    planops.update(w.sean.id, w.mel, { notes: 'wrong', scheduled_at: '2027-01-02T10:00:00-08:00', flexible_time: true }, { via: 'app' });
    const at = db._raw().prepare("SELECT created_at FROM plan_changes WHERE event_id = ? AND field = 'notes' ORDER BY id DESC").get(w.mel).created_at;
    const r = planops.revert(w.sean.id, w.mel, { at });
    assert.equal(r.ok, true);
    const after = row(w.mel);
    for (const k of ['notes', 'proposed_dates', 'date_tbd', 'flexible_time', 'scheduled_at']) assert.equal(String(after[k]), String(before[k]), k);
    assert.ok(planops.history(w.mel).some((h) => h.via === 'undo' && h.field === 'notes'));
  });

  test('the repair for Melanie\'s weekend: exactly that change, once', async () => {
    const sean = mkUser('Sean Repair');
    const m = await planops.create(sean.id, { title: "Melanie's Birthday Weekend", proposed_dates: [{ from: '2026-10-23', to: '2026-10-24' }],
      notes: 'Friday: massage. Saturday: Hot springs, dinner at Sassafras' });
    planops.update(sean.id, m.eventId, { notes: "Carson City Hot Springs + massage + dinner at Sassafras Eclectic Food Joint. Flexible — kids likely won't stay",
      scheduled_at: '2026-10-17T13:00:00-07:00', flexible_time: true, proposed_dates: [] }, { via: 'agent' });   // the old bad change (dropping the range is explicit since 🐛 #25)
    const task = require('../../retro').TASKS.find((t) => t.id === '2026-10-14-undo-melanie-changes-from-liams-chat');
    assert.match(task.run(sean), /^reverted /);
    const e = row(m.eventId);
    assert.equal(e.notes, 'Friday: massage. Saturday: Hot springs, dinner at Sassafras');
    assert.equal(e.proposed_dates, '[{"from":"2026-10-23","to":"2026-10-24"}]');
    assert.equal(e.date_tbd, 1);
    assert.equal(e.flexible_time, 0);
    assert.equal(require('../../plan').planFor(m.eventId, sean.id).dates.label.includes('(proposed)'), true);
    assert.equal(task.run(sean), 'already undone', 'running again changes nothing');
  });
});

describe('the rule the agent reads', () => {
  test('ONE PLAN AT A TIME', () => {
    assert.ok(agent.buildSystemPrompt({ name: 'X', phone: '+1' }, '').includes("ONE PLAN AT A TIME: in a plan's discussion, change only that plan"));
  });
});

// Sean, 2026-10-13: "yes, it should be locked in, but how do we ensure this going forward
// without me having to use my admin ability?" — the agent said "locked in for Sunday at
// noon" and left the plan tentative and 2 hours (he said ~3).
describe('what the reply says about a plan must be what is stored', () => {
  test('"locked in" while still tentative, and a length that wasn\'t saved → both sent back; the plan ends up locked in, 3 hours', async () => {
    const w = await twoPlans();
    let i = 0; const challenges = [];
    const steps = [
      { id: 'a', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'update_event', input: { event_id: w.liam, scheduled_at: '2027-01-10T12:00:00-08:00' } }] },
      { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: "Done. Liam's Birthday Party locked in for Sunday at noon." }] },
      { id: 'c', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'update_event', input: { event_id: w.liam, tentative: false } }] },
      { id: 'd', stop_reason: 'end_turn', content: [{ type: 'text', text: "Locked in for Sunday at noon." }] },
      { id: 'e', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't3', name: 'update_event', input: { event_id: w.liam, duration_mins: 180 } }] },
      { id: 'f', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Locked in: Sunday at noon, about 3 hours.' }] },
    ];
    agent._setAnthropic({ messages: { create: async (req) => {
      const last = req.messages.at(-1); if (typeof last.content === 'string' && last.content.startsWith('[System check')) challenges.push(last.content);
      return steps[Math.min(i++, steps.length - 1)];
    } } });
    db.storeInboundMessage({ from_phone: w.sean.phone, from_type: 'user', from_id: w.sean.id, channel: 'webchat', text: LIAM_SAID, event_id: w.liam });
    await agent.tick();
    assert.ok(challenges.some((c) => /still tentative/.test(c)), 'the false "locked in" was sent back');
    assert.ok(challenges.some((c) => /duration_mins/.test(c)), 'the missing length was sent back');
    const e = row(w.liam);
    assert.equal(e.tentative, 0);
    assert.equal(e.duration_mins, 180);
  });
});

describe('the host fixes their own plan in the app', () => {
  const supertest = require('supertest');
  const request = supertest(require('../../server').app);
  async function cookieFor(u) {
    db.writeConsent(u.phone, 'INVITE_PAGE');
    await request.post('/auth/otp/send').send({ phone: u.phone });
    const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
    return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
  }
  test('Lock it in; see who changed what; undo the last change; nobody else can', async () => {
    const w = await twoPlans();
    const cookie = await cookieFor(w.sean);
    planops.update(w.sean.id, w.liam, { scheduled_at: '2027-01-10T12:00:00-08:00' }, { via: 'agent' });
    assert.equal((await request.patch(`/api/events/${w.liam}`).set('Cookie', cookie).send({ tentative: false })).status, 200);
    assert.equal(row(w.liam).tentative, 0);
    const ch = (await request.get(`/api/events/${w.liam}/changes`).set('Cookie', cookie)).body.changes;
    assert.equal(ch[0].by, 'You');
    assert.ok(ch.some((c) => c.by === 'ButterflAI' && c.fields.includes('the date/time')));
    // The agent rewrites the notes; the host undoes it.
    planops.update(w.sean.id, w.liam, { notes: 'wrong notes' }, { via: 'agent' });
    const u = await request.post(`/api/events/${w.liam}/undo`).set('Cookie', cookie);
    assert.equal(u.status, 200);
    assert.equal(row(w.liam).notes, 'Reservation made.');
    const other = mkUser('Not Host Scope');
    assert.equal((await request.post(`/api/events/${w.liam}/undo`).set('Cookie', await cookieFor(other))).status, 403);
  });
  // Shown to everyone who can change the plan, not just the host (2026-10-19, 🐛 #20 — was p.host.is_you).
  test('the plan summary shows the plan controls to everyone who can change it', () => {
    const ev = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/events.html'), 'utf8');
    assert.ok(ev.includes("${p.can_edit ? hostControls(p) : ''}") && ev.includes('🔒 Lock it in') && ev.includes('↩︎ Undo last change') && ev.includes('Recent changes'));
  });
});

describe("Liam's party, locked in (retro)", () => {
  test('locked in for 3 hours only if still exactly as found', async () => {
    const sean = mkUser('Sean Liam Lock');
    const r = await planops.create(sean.id, { title: "Liam's Birthday Party", scheduled_at: new Date(Date.UTC(2026, 9, 25, 19) * 1).toISOString(), tentative: true });
    const task = require('../../retro').TASKS.find((t) => t.id === '2026-10-14-lock-in-liams-party');
    assert.match(task.run(sean), /^locked in/);
    assert.equal(row(r.eventId).tentative, 0);
    assert.equal(row(r.eventId).duration_mins, 180);
    assert.equal(task.run(sean), 'not as found');
  });
});
