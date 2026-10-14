/**
 * weekend-regressions.test.js — Sean, 2026-10-13: "all the events for the weekend of
 * October 23-25 were deleted, Bam Bam was shown as interested when he said he was going to
 * go, Melanie said she wants a massage and was asked if that's a solo thing."
 * (The plans weren't deleted: Home showed only one Happening, so Melanie's weekend was
 * hidden behind Liam's party, and undated plans sorted at random.)
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'weekend-regressions-test';
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
const home = require('../../home');

let n = 0;
function mkUser(name) {
  const phone = `+1202547${String(7000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
const inv = (e, u) => db._raw().prepare('SELECT ei.id FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?').get(e, u.phone).id;
async function weekend() {
  const sean = mkUser('Sean W'); const bam = mkUser('Bam W'); const mel = mkUser('Melanie W');
  const ids = [bam, mel].map((u) => knows(sean, u));
  const m = await planops.create(sean.id, { title: "Melanie's Birthday Weekend", proposed_dates: [{ from: day(10), to: day(11) }], contact_ids: ids });
  const l = await planops.create(sean.id, { title: "Liam's Birthday Party", proposed_dates: [{ from: day(12), to: day(12) }], contact_ids: ids });
  return { sean, bam, mel, m: m.eventId, l: l.eventId };
}

describe('"the weekend plans were deleted" — Home showed only one', () => {
  test('both plans are on Home, soonest first (by their proposed dates)', async () => {
    const w = await weekend();
    const items = home.feedFor(w.sean.id).items.filter((i) => i.type === 'event').map((i) => i.title);
    assert.deepEqual(items, ["Melanie's Birthday Weekend", "Liam's Birthday Party"]);
    const bamItems = home.feedFor(w.bam.id).items.map((i) => i.title);
    assert.ok(bamItems.includes("Melanie's Birthday Weekend") && bamItems.includes("Liam's Birthday Party"));
  });
  test('Home shows what needs you and the next two weeks of plans, not just one', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/dashboard.html'), 'utf8');
    assert.ok(html.includes('function homeHappenings(items)') && html.includes('.slice(0, 4)'));
  });
});

describe('"Bam Bam was shown as interested when he said he was going"', () => {
  test('"Let everyone know I\'m going" → going, everywhere', async () => {
    const w = await weekend();
    let i = 0;
    const steps = [{ id: 'a', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'confirm_coordination_invite', input: { invitation_id: inv(w.m, w.bam), status: 'accepted' } }] },
      { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: "Done — you're going." }] }];
    agent._setAnthropic({ messages: { create: async () => steps[Math.min(i++, steps.length - 1)] } });
    db.storeInboundMessage({ from_phone: w.bam.phone, from_type: 'user', from_id: w.bam.id, channel: 'webchat', text: "Let everyone know I'm going on Friday. I'm sitting with Melanie." });
    await agent.tick();
    const p = plan.planFor(w.m, w.sean.id);
    assert.deepEqual(p.going, ['Bam']);
    assert.equal(p.people.find((x) => x.name === 'Bam').going, true);
    assert.equal(plan.planFor(w.m, w.bam.id).invitation.going, true);
  });
  test('"interested" stays interested; going can be set later from the app', async () => {
    const w = await weekend();
    planops.respond(inv(w.l, w.mel), 'accepted', { by: 'guest', phone: w.mel.phone });
    assert.equal(plan.planFor(w.l, w.sean.id).people.find((x) => x.name === 'Melanie').going, false);
    const r = planops.respond(inv(w.l, w.mel), 'accepted', { by: 'guest', phone: w.mel.phone, going: true });
    assert.equal(r.unchanged, false, 'going is a change worth telling the host about');
    assert.equal(plan.planFor(w.l, w.sean.id).people.find((x) => x.name === 'Melanie').going, true);
  });
  test("the host's notice uses the plan's dates, not an undated plan's placeholder time", async () => {
    const w = await weekend();
    planops.respond(inv(w.m, w.bam), 'accepted', { by: 'guest', phone: w.bam.phone, going: true });
    const note = db._raw().prepare("SELECT text FROM inbound_messages WHERE from_id = ? AND text LIKE '[Agent-to-Agent RSVP]%' ORDER BY rowid DESC").get(w.sean.id).text;
    assert.match(note, /\(proposed\)/);
    assert.doesNotMatch(note, /\d{1,2}:\d{2} [AP]M/);
  });
});

describe('"Melanie said she wants a massage and was asked if that\'s a solo thing"', () => {
  test('in a plan\'s discussion, what they say is about that plan', () => {
    const p = agent.buildSystemPrompt({ name: 'X', phone: '+1' }, '');
    assert.ok(p.includes("YOUR USER IS IN A PLAN'S DISCUSSION: what they say there is about that plan"));
    assert.ok(p.includes("never ask whether it's a solo thing"));
    assert.ok(p.includes('GOING VS INTERESTED'));
  });
});

describe('earlier-chat plans: never offer to set up one they are already in', () => {
  test('the offer sees plans they are invited to, with dates and whose they are', async () => {
    const w = await weekend();
    let prompt = '';
    require('../../retro')._setClient({ messages: { create: async (req) => { prompt = req.messages[0].content; return { content: [{ type: 'text', text: '{"plans":[]}' }] }; } } });
    for (const [r, t] of [['user', 'grover is happening'], ['user', 'oct 23 to 25']]) db._raw().prepare(`INSERT INTO conversation_history (id, user_id, role, text) VALUES (?, ?, ?, ?)`).run(uuidv4(), w.bam.id, r, t);
    await require('../../retro').TASKS.find((x) => x.id === '2026-10-10-plans-from-past-chats').run(w.bam);
    assert.match(prompt, /"Melanie's Birthday Weekend \(.*\(proposed\), Sean's plan\)"/);
  });
});

describe('what already happened (retro)', () => {
  const retro = require('../../retro');
  const task = (id) => retro.TASKS.find((t) => t.id === id);
  test('a yes from someone who said "I\'m going" in the plan becomes going', async () => {
    const w = await weekend();
    planops.respond(inv(w.m, w.bam), 'accepted', { by: 'guest', phone: w.bam.phone });   // stored as a plain yes before this fix
    db._raw().prepare(`INSERT INTO conversation_history (id, user_id, role, text, event_id) VALUES (?, ?, 'user', ?, ?)`).run(uuidv4(), w.bam.id, "Let everyone know I'm going on Friday", w.m);
    assert.equal(task('2026-10-13-going-not-just-interested').run(w.bam), 'going 1');
    assert.deepEqual(plan.planFor(w.m, w.sean.id).going, ['Bam']);
  });
  test('someone offered a plan they were already in hears which plans already exist', async () => {
    const w = await weekend();
    db._raw().prepare(`INSERT INTO conversation_history (id, user_id, role, text, created_at) VALUES (?, ?, 'assistant', ?, ?)`)
      .run(uuidv4(), w.bam.id, "I now keep a plan for everything we talk about… • Grover Hot Springs — Oct 23-24", Math.floor(Date.now() / 1000));
    assert.equal(await task('2026-10-13-correct-setup-offers').run(w.bam), 'corrected (2)');
    const last = db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? ORDER BY rowid DESC").get(w.bam.id).text;
    assert.match(last, /already in — Melanie's Birthday Weekend \(.+\(proposed\), Sean's plan\)/);
  });
});
