/**
 * home-links.test.js — 🐛 #26 (Sean, 2026-10-20): "Why does it say that the spas the massages for
 * Friday is done when it's not done[?] and when I click on a suggestion or on the event it takes me
 * to the chat but then I have to go and find the relevant information … to understand what the
 * context is and what the issue is."
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'home-links-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');
const fs = require('node:fs');
const path = require('node:path');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const read = (f) => fs.readFileSync(path.join(__dirname, '../../public/app', f), 'utf8');

let n = 0;
function mkUser(name) {
  const phone = `+1202537${String(3000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}

describe('🐛 #26: Home opens the thing itself', () => {
  const dash = read('dashboard.html'), chat = read('chat.html');
  test('a plan card opens its summary (dates, people, suggestions, Creating, what needs doing)', () => {
    assert.ok(dash.includes('const href = `/app/events?event=${esc(i.event_id)}`;'));
  });
  test('a Creating item / the suggestions open the chat with that thing highlighted in the open Creating bar', () => {
    assert.ok(dash.includes('/app/chat?event=${esc(i.event_id)}&todo=${esc(i.todo_id)}') && dash.includes('&focus=suggestions'));
    assert.ok(chat.includes("if (focusTodo || focusSuggestions) todoOpen = true;") && chat.includes("el.classList.add('focus'); el.scrollIntoView"));
  });
  test('"✓ Done" read as a status — it is "☐ Mark done", and only on items you\'re on', () => {
    assert.ok(!dash.includes("')\">✓ Done</button>"));
    assert.ok(dash.includes('☐ Mark done') && dash.includes("i.who === 'you'") && dash.includes('joinTodo('));
  });
  test('a friend\'s question opens the chat with the question pinned; only the person asked can read it', async () => {
    const sean = mkUser('Sean H'); const mel = mkUser('Melanie H'); const bam = mkUser('Bam H');
    const id = uuidv4();
    db._raw().prepare("INSERT INTO agent_messages (id, thread_id, from_user, to_user, kind, topic, body, processed) VALUES (?, ?, ?, ?, 'query', 'coordination', ?, 0)").run(id, uuidv4(), mel.id, sean.id, '[Agent query] Which spa should we book for Friday?');
    const r = await request.get(`/api/questions/${id}`).set('Cookie', await cookieFor(sean));
    assert.deepEqual(r.body, { who: 'Melanie', text: 'Which spa should we book for Friday?', answered: false });
    assert.equal((await request.get(`/api/questions/${id}`).set('Cookie', await cookieFor(bam))).status, 404);
    assert.ok(dash.includes('&ask=${esc(i.question_id)}') && chat.includes("fetch('/api/questions/' + encodeURIComponent(askId))"));
  });
});

describe('🐛 #30: a plan\'s details from its chat', () => {
  test('a "Details" button next to the plan\'s pill opens its summary (which links back to the discussion)', () => {
    const chat = read('chat.html');
    assert.ok(chat.includes("info.textContent = 'ℹ︎ Details'") && chat.includes("info.href = '/app/events?event=' + encodeURIComponent(current.event_id)"));
    assert.ok(read('events.html').includes('💬 Discussion'));
  });
});
