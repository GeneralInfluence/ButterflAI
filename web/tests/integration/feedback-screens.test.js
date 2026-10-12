/**
 * feedback-screens.test.js — feedback from any screen (owner, 2026-10-12): one tap
 * captures a screenshot and what the screen was showing; the person adds what they didn't
 * like. When a plan was on screen, the server attaches the plan object (plan.js).
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'feedback-screens-test';
process.env.ADMIN_SECRET = 'admin-test-secret';
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
const multiparty = require('../../multiparty');

function mkUser(phone, name) {
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
// A tiny valid JPEG data URL, and one too big for the limit.
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

describe('feedback from any screen', () => {
  test('note + page + state + screenshot are stored; a plan on screen is attached as the plan object', async () => {
    const u = mkUser('+12025567001', 'Sean Fb');
    const ev = multiparty.createEvent(u.id, { title: "Melanie's Birthday Weekend", activity_type: 'trip', proposed_dates: [{ from: '2026-10-23', to: '2026-10-24' }] });
    const cookie = await cookieFor(u);
    const r = await request.post('/api/feedback').set('Cookie', cookie).send({
      note: 'My plan shows twice', page: '/app/chat', app_version: 'abc-1', device: 'test · 400x800',
      state: { screen: 'chat', event_id: ev, last_messages: [{ who: 'user', text: 'hi' }] }, screenshot: JPEG });
    assert.equal(r.status, 200);
    const row = db._raw().prepare('SELECT * FROM feedback WHERE id = ?').get(r.body.id);
    assert.equal(row.page, '/app/chat');
    assert.equal(row.user_note, 'My plan shows twice');
    assert.ok(row.screenshot.length > 0);
    const state = JSON.parse(row.state_json);
    assert.equal(state.plan.title, "Melanie's Birthday Weekend");
    assert.equal(state.plan.stage, 'proposed');
  });

  test('a plan the person is not in is never attached; bad screenshots are refused', async () => {
    const a = mkUser('+12025567002', 'Fb A'); const b = mkUser('+12025567003', 'Fb B');
    const theirs = multiparty.createEvent(b.id, { title: 'Secret plan', activity_type: 'x', date_tbd: true });
    const cookie = await cookieFor(a);
    const r = await request.post('/api/feedback').set('Cookie', cookie).send({ note: 'x', state: { event_id: theirs } });
    assert.equal(JSON.parse(db._raw().prepare('SELECT state_json FROM feedback WHERE id = ?').get(r.body.id).state_json).plan, undefined);
    assert.equal((await request.post('/api/feedback').set('Cookie', cookie).send({ note: 'x', screenshot: 'data:text/html;base64,PGI+' })).status, 400);
    assert.equal((await request.post('/api/feedback').send({ note: 'x' })).status, 401);
  });

  test('the per-message 👎 still works (no screenshot)', async () => {
    const u = mkUser('+12025567004', 'Fb Old');
    const r = await request.post('/api/feedback').set('Cookie', await cookieFor(u)).send({ agent_message: 'bad reply', note: 'wrong' });
    assert.equal(r.status, 200);
  });

  test('every app screen has the feedback tab; the library is served from our server', async () => {
    const read = (f) => require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app', f), 'utf8');
    for (const f of ['chat.html', 'dashboard.html', 'events.html', 'contacts.html', 'settings.html']) {
      assert.ok(read(f).includes('<script src="/feedback.js"></script>'), f);
    }
    const lib = await request.get('/vendor/html2canvas.min.js');
    assert.equal(lib.status, 200);
    const js = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/feedback.js'), 'utf8');
    assert.ok(js.includes("What didn't you like, or what should change?") && js.includes('Include this screenshot'));
    assert.ok(js.includes("ignoreElements: (el) => el.id === 'bfly-fb-tab'"), 'the tab itself is not in the screenshot');
  });

  test('old screenshots and screen state are cleared after 90 days', () => {
    const u = mkUser('+12025567005', 'Fb Purge');
    db._raw().prepare(`INSERT INTO feedback (user_id, rating, user_note, screenshot, state_json, created_at) VALUES (?, 'down', 'old', ?, '{}', ?)`)
      .run(u.id, Buffer.from([1, 2]), Math.floor(Date.now() / 1000) - 91 * 86400);
    const recent = db._raw().prepare(`INSERT INTO feedback (user_id, rating, user_note, screenshot, state_json) VALUES (?, 'down', 'new', ?, '{}')`)
      .run(u.id, Buffer.from([3])).lastInsertRowid;
    require('../../coord-loop').tickPurge();   // the real retention step
    const rows = db._raw().prepare('SELECT id, screenshot, state_json FROM feedback WHERE user_id = ? ORDER BY id').all(u.id);
    assert.equal(rows[0].screenshot, null);
    assert.equal(rows[0].state_json, null);
    assert.ok(rows.find((r) => r.id === Number(recent)).screenshot, 'recent ones kept');
  });
});
