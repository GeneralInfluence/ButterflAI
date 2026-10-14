/**
 * feedback-backlog.test.js — 🐛 reports from before cases existed, each with the test it
 * needed and didn't have (owner, 2026-10-13: "each caterpillar should become a new test").
 * The other early reports are covered by the tests named in their test_ref.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'feedback-backlog-test';
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
  const phone = `+1202548${String(8000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const toolUse = (name, input) => ({ id: 'm' + Math.random(), stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't' + Math.random(), name, input }] });
const endText = (text) => ({ id: 'm' + Math.random(), stop_reason: 'end_turn', content: [{ type: 'text', text }] });

// 🐛 #11 (Sean, 2026-10-12): "Why would Liam's birthday party be combined with Melanie's?"
describe('🐛 #11: only combine plans the user named', () => {
  const SAID = "Melanie's birthday weekend and the grover Hot Springs is really just one event decided that we are not going to the hot springs right now and that Saturday go to the Carson City Hot Springs instead";
  test('exact regression: offering to fold in a plan they never mentioned is refused', async () => {
    const sean = mkUser('Sean Merge');
    const mel = await planops.create(sean.id, { title: "Melanie's Birthday Weekend", tentative: true });
    const liam = await planops.create(sean.id, { title: "Liam's Birthday Party", tentative: true });
    const results = [];
    let i = 0;
    const steps = [toolUse('merge_plans', { keep_event_id: mel.eventId, merge_event_id: liam.eventId }), endText('ok')];
    // What the tool returned is what the model gets back next (tool_result).
    agent._setAnthropic({ messages: { create: async (req) => {
      for (const m of req.messages || []) for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type === 'tool_result') { try { results.push(JSON.parse(typeof c.content === 'string' ? c.content : c.content[0].text)); } catch (_) {} }
      }
      return steps[Math.min(i++, steps.length - 1)];
    } } });
    db.storeInboundMessage({ from_phone: sean.phone, from_type: 'user', from_id: sean.id, channel: 'webchat', text: SAID });
    await agent.tick();
    assert.equal(results[0]?.error, 'PLAN_NOT_NAMED');
    assert.match(results[0].message, /Liam's Birthday Party/);
    assert.match(results[0].message, /update the plan they named instead/);
  });

  test('both named → the usual "ask first" proposal', () => {
    assert.equal(agent.planNamedIn(SAID, "Melanie's Birthday Weekend"), true);
    assert.equal(agent.planNamedIn(SAID, 'Grover Hot Springs camping'), true);
    assert.equal(agent.planNamedIn(SAID, "Liam's Birthday Party"), false, '"birthday" alone does not name it');
    assert.equal(agent.planNamedIn('combine it with Mel’s thing', "Melanie's Birthday Weekend"), true, 'a short form of the name counts');
    assert.equal(agent.planNamedIn('grover is the same thing as melanies birthday weekend', "Melanie's Birthday Weekend"), true, 'no apostrophe');
  });
});

// 🐛 #2 (Sean, 2026-10-06): "I just said I want to send her a message that we should hang
// out but you then ask what I want. You should see that already."
describe('🐛 #2: write the message from the gist', () => {
  test('the agent writes it when given the gist, instead of asking what to say', () => {
    const p = agent.buildSystemPrompt({ name: 'X', phone: '+1' }, '');
    assert.ok(p.includes('WRITE IT FOR THEM: when your user gives the gist of a message'));
    assert.ok(p.includes('never ask "what do you want to say?"'));
  });
});

// The early reports are linked to their tests in migration 056 — every test named there
// must exist, so a link can't point at nothing.
describe('the 11 early reports point at real tests', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/056_feedback_backlog_tests.sql'), 'utf8');
  const early = [...sql.matchAll(/test_ref = '((?:[^']|'')+)'/g)].map((m) => m[1].replace(/''/g, "'"));
  test('11 reports, each linked', () => assert.equal(early.length, 11));
  // Later reports are linked in tests/fixtures/feedback-links.json (feedbacklinks.js).
  const links = require('../../feedbacklinks').load();
  const refs = [...early, ...Object.entries(links).filter(([k]) => /^\d+$/.test(k)).map(([, l]) => l.test)];
  for (const ref of refs) {
    for (const part of ref.split(' + ')) {
      test(part, () => {
        const [file, ...names] = part.split(' › ');
        const src = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
        for (const name of names) {
          const want = name.replace(/\s*\(.*\)\s*$/, '').replace(/["“”]/g, '').slice(0, 40);   // "(…)" = description, not the name
          assert.ok(src.replace(/\\(["'])/g, '$1').replace(/["“”]/g, '').includes(want), `${file} has "${want}"`);
        }
      });
    }
  }
});

describe('later reports are linked from links.json', () => {
  const feedbacklinks = require('../../feedbacklinks');
  test('a listed report with a matching note gets its test and is marked fixed; anything else is untouched', () => {
    const u = mkUser('Links Person');
    const a = db.createFeedback({ user_id: u.id, rating: 'down', user_note: 'The calendar hides my plan details' });
    const b = db.createFeedback({ user_id: u.id, rating: 'down', user_note: 'Something else entirely' });
    const n = feedbacklinks.apply({ [a]: { note_starts: 'The calendar hides', test: 'tests/x.test.js › y' }, [b]: { note_starts: 'Not this note', test: 'tests/z.test.js' } });
    assert.equal(n, 1);
    const ra = db._raw().prepare('SELECT status, test_ref FROM feedback WHERE id = ?').get(a);
    assert.deepEqual([ra.status, ra.test_ref], ['fixed', 'tests/x.test.js › y']);
    assert.equal(db._raw().prepare('SELECT status FROM feedback WHERE id = ?').get(b).status, 'new');
  });
});

// 🐛 #13 (Sean, 2026-10-13): "I should be able to scroll and see the whole calendar." The
// phone-only bottom padding lost to a later general `main` rule (24px, not 80px), so the
// bottom of Events and Settings sat behind the bottom bar. Checked on every app screen.
describe('🐛 #13: every screen clears the bottom bar', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const dir = path.join(__dirname, '../../public/app');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
    test(f, () => {
      const s = fs.readFileSync(path.join(dir, f), 'utf8');
      const general = [...s.matchAll(/\n\s*main\s*\{[^}]*padding:\s*\d/g)].map((m) => m.index);
      const mobile = [...s.matchAll(/(^|[^\w-])main\s*\{\s*padding-bottom/gm)].map((m) => m.index);
      // A phone rule written as plain "main" must come after the general one, or use "body main".
      if (general.length && mobile.length) assert.ok(Math.min(...mobile) > Math.max(...general) || s.includes('body main { padding-bottom'), `${f}: the phone padding is overridden`);
    });
  }
});

// 🐛 #15 (Sean, 2026-10-13): "It says Saturday plans, but the massages were meant for Friday,
// that's why Melanie clicked on Friday before giving her input."
describe('🐛 #15: the day you tapped goes with what you say', () => {
  test('a message from a plan opened on Friday carries Friday; the agent is told', async () => {
    const supertest = require('supertest');
    const request = supertest(require('../../server').app);
    const sean = mkUser('Sean Day'); const mel = mkUser('Melanie Day');
    const r = await planops.create(sean.id, { title: 'Day Weekend', proposed_dates: [{ from: '2027-01-08', to: '2027-01-09' }],
      contact_ids: [db.upsertContact({ invited_by_user_id: sean.id, name: mel.name, phone: mel.phone, tier: 1 })] });
    await request.post('/auth/otp/send').send({ phone: mel.phone });
    const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(mel.phone);
    const cookie = (await request.post('/auth/otp/verify').send({ phone: mel.phone, code })).headers['set-cookie'][0];
    await request.post('/api/chat/send').set('Cookie', cookie).send({ text: 'thinking about getting a massage', event_id: r.eventId, day: '2027-01-08' });
    await request.post('/api/chat/send').set('Cookie', cookie).send({ text: 'a day it does not cover', event_id: r.eventId, day: '2027-03-01' });
    const rows = db._raw().prepare("SELECT text, context_day FROM inbound_messages WHERE from_id = ? ORDER BY rowid").all(mel.id);
    assert.deepEqual(rows.map((x) => x.context_day), ['2027-01-08', null], 'only a day the plan covers');
    const systems = [];
    agent._setAnthropic({ messages: { create: async (req) => { systems.push(JSON.stringify(req.system)); return { id: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }; } } });
    await agent.tick();
    assert.ok(systems.some((x) => x.includes('They opened it from Friday, Jan 8 on the calendar')));
  });
  test('the calendar passes the tapped day into the discussion', () => {
    const fs = require('node:fs'); const path = require('node:path');
    const ev = fs.readFileSync(path.join(__dirname, '../../public/app/events.html'), 'utf8');
    const chat = fs.readFileSync(path.join(__dirname, '../../public/app/chat.html'), 'utf8');
    assert.ok(ev.includes('openSummary(events[0].id, iso)') && ev.includes("'&day=' + summaryDay"));
    assert.ok(chat.includes('...(topicDay ? { day: topicDay } : {})'));
  });
});

// Owner, 2026-10-13: "the tests should ensure the massage is on Friday." Melanie's exact
// path: she taps Friday Oct 23 on the calendar, opens her birthday weekend's discussion and
// writes "thinking about getting a massage". Whatever the model writes, the item it adds is
// stored on Friday, and that's what everyone in the plan sees.
describe('🐛 #15: the massage is on Friday', () => {
  async function melaniesWeekend() {
    const sean = mkUser('Sean Fri'); const mel = mkUser('Melanie Fri');
    const r = await planops.create(sean.id, { title: "Melanie's Birthday Weekend", proposed_dates: [{ from: '2027-01-08', to: '2027-01-09' }],   // Fri–Sat
      contact_ids: [db.upsertContact({ invited_by_user_id: sean.id, name: mel.name, phone: mel.phone, tier: 1 })] });
    return { sean, mel, eventId: r.eventId };
  }
  async function sayFromFriday(user, eventId, text, toolInput) {
    let i = 0;
    const steps = [{ id: 'a', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'manage_todos', input: { event_id: eventId, action: 'add', ...toolInput } }] },
      { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Added to the weekend.' }] }];
    agent._setAnthropic({ messages: { create: async () => steps[Math.min(i++, steps.length - 1)] } });
    db.storeInboundMessage({ from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'webchat', text, event_id: eventId, context_day: '2027-01-08' });
    await agent.tick();
  }
  const todosOf = (u, eventId) => require('../../todos').list(u.id, eventId).todos;

  test('opened from Friday: the massage is stored on Friday, and shows as Friday to everyone', async () => {
    const w = await melaniesWeekend();
    await sayFromFriday(w.mel, w.eventId, 'thinking about getting a massage', { items: ['Massages for everyone'] });   // the model didn't say a day
    const [t] = todosOf(w.mel, w.eventId);
    assert.equal(t.day, '2027-01-08', 'Friday');
    assert.notEqual(t.day, '2027-01-09', 'not Saturday');
    assert.equal(todosOf(w.sean, w.eventId)[0].shown, 'Fri, Jan 8: Massages for everyone', 'the host sees it on Friday');
    const home = require('../../home').feedFor(w.sean.id).creating.find((c) => c.todo_id === t.id);
    assert.match(home.text, /^Fri, Jan 8: /, 'and on Home');
  });

  test('the model picking Saturday when she never said Saturday is overruled: Friday', async () => {
    const w = await melaniesWeekend();
    await sayFromFriday(w.mel, w.eventId, 'thinking about getting a massage', { items: ['Get a massage'], day: '2027-01-09' });
    assert.equal(todosOf(w.mel, w.eventId)[0].day, '2027-01-08');
  });

  test('if they name another day, that day wins', async () => {
    const w = await melaniesWeekend();
    await sayFromFriday(w.mel, w.eventId, 'dinner on Saturday?', { items: ['Book dinner'], day: '2027-01-09' });
    assert.equal(todosOf(w.mel, w.eventId)[0].day, '2027-01-09');
  });

  test('a day the plan doesn\'t cover is never stored', async () => {
    const w = await melaniesWeekend();
    const r = require('../../todos').add(w.mel.id, w.eventId, { text: 'Brunch', day: '2027-02-01' });
    assert.equal(r.todo.day, null);
  });

  test('added from the plan chat\'s own box while on Friday: Friday too', async () => {
    const w = await melaniesWeekend();
    const supertest = require('supertest');
    const request = supertest(require('../../server').app);
    await request.post('/auth/otp/send').send({ phone: w.mel.phone });
    const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(w.mel.phone);
    const cookie = (await request.post('/auth/otp/verify').send({ phone: w.mel.phone, code })).headers['set-cookie'][0];
    const res = await request.post(`/api/events/${w.eventId}/todos`).set('Cookie', cookie).send({ text: 'Massage', day: '2027-01-08' });
    assert.equal(res.body.todo.day, '2027-01-08');
  });
});

// 🐛 #14 (Melanie, 2026-10-13): "no not solo, i mentioned this in my bday weekend group because
// its a group idea" — covered by weekend-regressions.test.js (plan discussion rule).

describe('case anonymizer: generic words in account names stay words', () => {
  test('"New user" as an account name does not turn "the user" into a stand-in', async () => {
    const sean = mkUser('Sean Anon'); const nu = mkUser('New user');
    const r = await planops.create(sean.id, { title: 'Anon Plan', tentative: true, contact_ids: [db.upsertContact({ invited_by_user_id: sean.id, name: nu.name, phone: nu.phone, tier: 1 })] });
    const { scrub } = require('../../feedbackcase').anonymizer(sean, r.eventId);
    assert.equal(scrub('inform the user proactively'), 'inform the user proactively');
  });
});

// CI run 2026-10-13: the model asked mid-reply ("Are you thinking about adding it…? If it's
// for the birthday trip, …") — no "?" at the end — and recorded nothing. The guard makes it
// record first whenever nothing was done on the plan.
describe('🐛 #15: an idea that only gets a question is recorded anyway', () => {
  test('question mid-reply, nothing recorded → the agent is made to record it (on Friday)', async () => {
    const sean = mkUser('Sean Guard'); const mel = mkUser('Melanie Guard');
    const r = await planops.create(sean.id, { title: 'Guard Weekend', proposed_dates: [{ from: '2027-01-08', to: '2027-01-09' }],
      contact_ids: [db.upsertContact({ invited_by_user_id: sean.id, name: mel.name, phone: mel.phone, tier: 1 })] });
    let i = 0; const seen = [];
    const steps = [
      { id: 'a', stop_reason: 'end_turn', content: [{ type: 'text', text: "Great idea! Are you thinking about adding it to the weekend, or is it separate? If it's for the trip, I can note it." }] },
      { id: 'b', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'manage_todos', input: { event_id: r.eventId, action: 'add', items: ['Get a massage'] } }] },
      { id: 'c', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done — it\'s on the Creating list for Friday.' }] },
    ];
    agent._setAnthropic({ messages: { create: async (req) => { seen.push(req.messages.at(-1)); return steps[Math.min(i++, steps.length - 1)]; } } });
    db.storeInboundMessage({ from_phone: mel.phone, from_type: 'user', from_id: mel.id, channel: 'webchat', text: 'thinking about getting a massage', event_id: r.eventId, context_day: '2027-01-08' });
    await agent.tick();
    assert.ok(seen.some((m) => typeof m.content === 'string' && m.content.includes("brought up an idea in this plan's discussion")), 'challenged');
    assert.equal(require('../../todos').list(mel.id, r.eventId).todos[0].day, '2027-01-08');
  });
});

// Sean, 2026-10-13: "I still see the massage on saturday" — the notes and the Creating item
// written before the fix. Corrected once (retro), only where report #15 and the plan exist.
describe('🐛 #15: the existing massage moves to Friday', () => {
  const task = () => require('../../retro').TASKS.find((t) => t.id === '2026-10-14-melanies-massage-on-friday');
  test('notes and the Creating item say Friday; Saturday keeps the rest', async () => {
    const sean = mkUser('Sean Old Massage');
    const r = await planops.create(sean.id, { title: "Melanie's Birthday Weekend", proposed_dates: [{ from: '2026-10-23', to: '2026-10-24' }],
      notes: 'Saturday: Hot springs, massage, dinner at Sassafras' });
    require('../../todos').add(sean.id, r.eventId, { text: 'Book massages at Carson City Hot Springs for Saturday' });
    assert.equal(task().run(sean), 'no report', 'nothing happens without report #15');
    db._raw().prepare("INSERT INTO feedback (id, user_id, rating, user_note) VALUES (15, ?, 'down', 'It says Saturday plans, but the massages were meant for Friday, that''s why Melanie clicked on Friday')").run(sean.id);
    assert.equal(task().run(sean), 'moved 2');
    assert.equal(db._raw().prepare('SELECT notes FROM social_events WHERE id = ?').get(r.eventId).notes, 'Friday: massage. Saturday: Hot springs, dinner at Sassafras');
    const [t] = require('../../todos').list(sean.id, r.eventId).todos;
    assert.equal(t.day, '2026-10-23');
    assert.equal(t.shown, 'Fri, Oct 23: Book massages at Carson City Hot Springs');
    const notes = require('../../plan').planFor(r.eventId, sean.id).notes;
    assert.doesNotMatch(notes.split(/Saturday:/i)[1], /massage/i, "Saturday's part of the notes has no massage");
    assert.doesNotMatch(t.shown, /saturday/i, 'the Creating item no longer says Saturday');
  });
});
