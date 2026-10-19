/**
 * understand.test.js — what a message asks for is decided before the reply, in code.
 *
 * Owner, 2026-10-14: "we need to somehow map people's conversation into actions in a more
 * consistent way." 🐛 #19 (Melanie, in her massage plan's chat): "expecting list of massage
 * places" — she got "who are the other 2 people? what time?" instead.
 * The reading model is scripted here; the real model is checked nightly
 * (tests/eval-understand.js).
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'understand-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
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
const agent = require('../../agent');
const planops = require('../../planops');
const plan = require('../../plan');
const understand = require('../../understand');

let n = 0;
function mkUser(name) {
  const phone = `+1202548${String(3000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
async function weekend() {
  const sean = mkUser('Sean U'); const mel = mkUser('Melanie U'); const bam = mkUser('Bam U');
  const ids = [mel, bam].map((u) => knows(sean, u));
  const m = await planops.create(sean.id, { title: "Melanie's Birthday Weekend", proposed_dates: [{ from: day(10), to: day(11) }], contact_ids: ids });
  const l = await planops.create(sean.id, { title: "Liam's Birthday Party", proposed_dates: [{ from: day(12), to: day(12) }], contact_ids: ids });
  db._raw().prepare('DELETE FROM inbound_messages').run();
  return { sean, mel, bam, m: m.eventId, l: l.eventId };
}

/** The reading model says `actions`; the reply model runs `steps` and records what it saw. */
function script(actions, steps = [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Okay!' }] }]) {
  let readCalls = 0;
  understand._setClient({ messages: { create: async () => { readCalls++; return { content: [{ type: 'text', text: JSON.stringify({ actions }) }] }; } } });
  const seen = [];
  let i = 0;
  agent._setAnthropic({ messages: { create: async (req) => { seen.push(JSON.parse(JSON.stringify(req.messages))); return { id: 'r' + i, ...steps[Math.min(i++, steps.length - 1)] }; } } });
  return { seen, reads: () => readCalls };
}
async function say(u, text, extra = {}) {
  db.storeInboundMessage({ from_phone: u.phone, from_type: 'user', from_id: u.id, channel: 'webchat', text, ...extra });
  await agent.tick();
}
const lastUserText = (msgs) => { const m = [...msgs].reverse().find((x) => x.role === 'user' && typeof x.content === 'string'); return m?.content || ''; };
const todosOf = (e) => db._raw().prepare('SELECT text, day FROM event_todos WHERE event_id = ?').all(e);

describe('understood and done in code', () => {
  test('Melanie\'s massage: added on the day she opened, the reply is told, a chip shows, Undo removes it', async () => {
    const w = await weekend();
    const s = script([{ kind: 'add_todo', event_id: w.m, text: 'Massage', quote: 'thinking about getting a massage', confidence: 0.92 }]);
    await say(w.mel, 'thinking about getting a massage', { event_id: w.m, context_day: day(10) });
    assert.deepEqual(todosOf(w.m), [{ text: 'Massage', day: day(10) }]);
    assert.match(lastUserText(s.seen[0]), /Already done in code[\s\S]*✓ Massage · \w{3} → Creating/);

    const cookie = await cookieFor(w.mel);
    const msgs = (await request.get(`/api/chat/messages?event=${w.m}`).set('Cookie', cookie)).body.messages;
    const mine = msgs.find((m) => m.role === 'user');
    assert.equal(mine.text, 'thinking about getting a massage', 'the note to the model is not in her chat');
    assert.equal(mine.understood.length, 1);
    assert.equal(mine.understood[0].status, 'applied');

    const undone = await request.post(`/api/understood/${mine.understood[0].id}/undo`).set('Cookie', cookie).send({});
    assert.equal(undone.status, 200);
    assert.equal(undone.body.chip.status, 'undone');
    assert.deepEqual(todosOf(w.m), []);
    assert.equal(understand.corrections().filter((c) => c.quote === 'thinking about getting a massage').length, 1, 'kept as a correction');
    // Not someone else's
    assert.equal((await request.post(`/api/understood/${mine.understood[0].id}/undo`).set('Cookie', await cookieFor(w.bam)).send({})).status, 404);
  });

  test('the reply model adding the same thing again in other words is refused', async () => {
    const w = await weekend();
    script([{ kind: 'add_todo', event_id: w.m, text: 'Massage', quote: 'massage', confidence: 0.9 }],
      [{ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'manage_todos', input: { event_id: w.m, action: 'add', items: ['Get massages'] } }] },
        { stop_reason: 'end_turn', content: [{ type: 'text', text: 'On the list.' }] }]);
    await say(w.mel, 'I want a massage', { event_id: w.m });
    assert.equal(todosOf(w.m).length, 1);
  });

  test('words she didn\'t say, or another plan she didn\'t name, are not acted on', async () => {
    const w = await weekend();
    script([{ kind: 'add_todo', event_id: w.m, text: 'Spa day', quote: 'book a spa day', confidence: 0.95 },
      { kind: 'add_todo', event_id: w.l, text: 'Cake', quote: 'cake', confidence: 0.95 }]);
    await say(w.mel, 'we need cake', { event_id: w.m });
    assert.deepEqual(todosOf(w.m).map((t) => t.text), []);
    assert.deepEqual(todosOf(w.l), [], "Liam's party wasn't named");
    const why = db._raw().prepare('SELECT label FROM understood WHERE status = ? ORDER BY created_at').all('dropped').map((r) => r.label);
    assert.ok(why.includes('not in their words') && why.includes('a different plan than this discussion'));
  });

  test('"count me in" → going; Change → interested (a correction)', async () => {
    const w = await weekend();
    script([{ kind: 'rsvp', event_id: w.l, answer: 'going', quote: 'count me in', confidence: 0.9 }]);
    await say(w.bam, "Liam's party? count me in", { event_id: w.l });
    assert.deepEqual(plan.planFor(w.l, w.sean.id).going, ['Bam']);
    const row = db._raw().prepare("SELECT id FROM understood WHERE kind = 'rsvp' AND user_id = ?").get(w.bam.id);
    const r = await request.post(`/api/understood/${row.id}/undo`).set('Cookie', await cookieFor(w.bam)).send({ answer: 'interested' });
    assert.equal(r.body.chip.status, 'corrected');
    assert.match(r.body.chip.label, /^Interested · Liam/);
    const p = plan.planFor(w.l, w.sean.id);
    assert.deepEqual([p.interested, p.going], [['Bam'], []]);
  });

  test('the host\'s date is saved; Undo puts the plan back', async () => {
    const w = await weekend();
    script([{ kind: 'set_details', event_id: w.l, when: `${day(12)} at noon`, duration_mins: 180, quote: 'noon, for 3 hours', confidence: 0.9 }]);
    await say(w.sean, "Liam's party: noon, for 3 hours", { event_id: w.l });
    let e = db._raw().prepare('SELECT scheduled_at, duration_mins, proposed_dates FROM social_events WHERE id = ?').get(w.l);
    assert.equal(e.duration_mins, 180);
    assert.equal(e.proposed_dates, null);
    const row = db._raw().prepare("SELECT id FROM understood WHERE kind = 'set_details' AND user_id = ?").get(w.sean.id);
    await request.post(`/api/understood/${row.id}/undo`).set('Cookie', await cookieFor(w.sean)).send({});
    e = db._raw().prepare('SELECT duration_mins, proposed_dates FROM social_events WHERE id = ?').get(w.l);
    assert.ok(e.proposed_dates, 'proposed dates are back');
  });

  test('a guest can\'t change the plan: nothing saved, the reply is told to offer to pass it on', async () => {
    const w = await weekend();
    const s = script([{ kind: 'set_details', event_id: w.m, venue_name: 'Steamboat Springs', quote: 'Steamboat Springs', confidence: 0.9 }]);
    await say(w.mel, "let's do Steamboat Springs instead", { event_id: w.m });
    assert.equal(db._raw().prepare('SELECT venue_name FROM social_events WHERE id = ?').get(w.m).venue_name, null);
    assert.match(lastUserText(s.seen[0]), /only the host can/);
  });

  test('unsure → nothing done, one question with the choices', async () => {
    const w = await weekend();
    const s = script([{ kind: 'rsvp', event_id: w.m, answer: 'going', quote: 'sounds fun', confidence: 0.6, ask: 'Going, or just interested?' }]);
    await say(w.bam, 'sounds fun', { event_id: w.m });
    assert.deepEqual(plan.planFor(w.m, w.sean.id).interested, []);
    assert.match(lastUserText(s.seen[0]), /exactly one short question: Going, or just interested\?/);
  });

  test('private mode: nothing is read or done', async () => {
    const w = await weekend();
    require('../../sensitive').setSensitiveMode(w.mel.id, true);
    const s = script([{ kind: 'add_todo', event_id: w.m, text: 'Massage', quote: 'massage', confidence: 0.9 }]);
    await say(w.mel, 'massage', { event_id: w.m });
    require('../../sensitive').setSensitiveMode(w.mel.id, false);
    assert.equal(s.reads(), 0);
    assert.deepEqual(todosOf(w.m), []);
  });

  test('kept 90 days', async () => {
    const w = await weekend();
    db._raw().prepare(`INSERT INTO understood (id, user_id, kind, decision, status, created_at) VALUES ('old', ?, 'add_todo', 'apply', 'applied', strftime('%s','now') - 91*86400)`).run(w.mel.id);
    assert.ok(understand.purgeOld() >= 1);
    assert.equal(db._raw().prepare("SELECT 1 FROM understood WHERE id = 'old'").get(), undefined);
  });
});

describe('🐛 #19: "expecting list of massage places"', () => {
  test('asking for options → the reply must search and list them, not ask who and when', async () => {
    const w = await weekend();
    const massages = await planops.create(w.mel.id, { title: 'Massages', proposed_dates: [{ from: day(10), to: day(10) }], contact_ids: [knows(w.mel, w.sean)] });
    const s = script([{ kind: 'find_options', event_id: massages.eventId, what: 'massage places for 4', near: 'Carson City', quote: 'find massage places', confidence: 0.9 }],
      [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Who are the other 2 people? What time Friday works?' }] },
        { stop_reason: 'end_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'massage Carson City' } },
          { type: 'web_search_tool_result', tool_use_id: 's1', content: [] }, { type: 'text', text: '1. Carson Hot Springs spa — …' }] }]);
    await say(w.mel, 'can you find massage places near Carson City for Friday?', { event_id: massages.eventId });
    assert.match(lastUserText(s.seen[0]), /They want options: massage places for 4 near Carson City\. Search the web now/);
    assert.equal(s.seen.length, 2, 'the questions-first reply was sent back');
    assert.match(s.seen[1].at(-1).content, /asked for options[\s\S]*Questions can come after the options, not instead of them/);
    const replies = db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND role = 'assistant'").all(w.mel.id).map((r) => r.text);
    assert.deepEqual(replies, ['1. Carson Hot Springs spa — …']);
  });
});

describe('retro: options asked for and not given', () => {
  const task = require('../../retro').TASKS.find((t) => t.id === '2026-10-19-options-asked-for-not-given');
  test('Melanie\'s question with no links back → offered in that plan\'s discussion; answered ones aren\'t', async () => {
    const w = await weekend();
    const add = (u, role, text, ev) => db._raw().prepare('INSERT INTO conversation_history (id, user_id, role, text, event_id) VALUES (?, ?, ?, ?, ?)').run(uuidv4(), u.id, role, text, ev);
    add(w.mel, 'user', 'can you find massage places near Carson City?', w.m);
    add(w.mel, 'assistant', 'Who are the other 2 people? What time Friday works?', w.m);
    assert.equal(await task.run(w.mel), 'offered');
    const offer = db._raw().prepare("SELECT text, event_id FROM conversation_history WHERE user_id = ? AND role = 'assistant' ORDER BY rowid DESC").get(w.mel.id);
    assert.match(offer.text, /^Earlier you asked: "can you find massage places near Carson City\?" — I asked you questions instead/);
    assert.equal(offer.event_id, w.m);
    add(w.bam, 'user', 'any good bars near Sully\'s?', null);
    add(w.bam, 'assistant', 'Try Rosie\'s — https://example.com/rosies', null);
    assert.equal(await task.run(w.bam), 'nothing missed');
  });
});

describe('the pieces', () => {
  test('a quote must be their words (punctuation and case aside)', () => {
    assert.equal(understand.quoted("I'm thinking about getting a MASSAGE!", 'thinking about getting a massage'), true);
    assert.equal(understand.quoted('sounds fun', 'count me in'), false);
    assert.equal(understand.quoted('ok', ''), false);
  });
  test('every kind the reading model can return is decided somewhere', () => {
    for (const k of understand.KINDS) assert.ok(understand.PROMPT.includes(`- ${k} `) || understand.PROMPT.includes(`- ${k} {`), k);
  });
  test('the chat page shows chips with Undo / Change', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/chat.html'), 'utf8');
    assert.ok(html.includes("data.role === 'understood'") && html.includes('function renderChips') && html.includes("'Change' : 'Undo'"));
  });
});
