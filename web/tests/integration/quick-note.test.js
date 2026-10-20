/**
 * quick-note.test.js — owner, 2026-10-20: "somebody could be on tinder and then hit their butterfly
 * icon … say hey, I'm here talking to Sarah, she's over in Kings Beach. I don't have her number.
 * She's on tinder … it'll save it as one of your contacts and then put some wishes … around it".
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'quick-note-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');
const fs = require('node:fs'), path = require('node:path');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const screenread = require('../../screenread');

async function login(name, phone) {
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')").run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  await request.post('/auth/otp/send').send({ phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(phone);
  return { cookie: (await request.post('/auth/otp/verify').send({ phone, code })).headers['set-cookie'][0], user: db.getUserByPhone(phone) };
}

describe('✍️ Quick note: someone you met on Tinder', () => {
  test('saved as a contact with no number, where you met and what she is into, plus a wish — never messaged', async () => {
    const { cookie, user } = await login('Sean QN', '+12025340001');
    const text = "I'm talking to Sarah on Tinder, she's over in Kings Beach, loves paddleboarding. I don't have her number";
    const r = await request.post('/api/quick').set('Cookie', cookie).send({ text });
    assert.equal(r.status, 200);
    assert.equal(db._raw().prepare('SELECT intent FROM inbound_messages WHERE from_id = ? ORDER BY rowid DESC').get(user.id).intent, 'capture');
    let seen = null, step = 0;
    const sent = [];
    sms._setClient({ messages: { create: async (m) => { sent.push(m); return { sid: 'SM' }; } } });
    agent._setAnthropic({ messages: { create: async (req) => {
      if (step === 0) seen = req.messages.at(-1).content;
      step++;
      if (step === 1) return { id: 'a', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 't1', name: 'add_contact', input: { name: 'Sarah', met_via: 'Tinder', about: 'in Kings Beach, loves paddleboarding' } },
        { type: 'tool_use', id: 't2', name: 'manage_wishes', input: { action: 'add', text: 'Paddleboarding at Kings Beach with Sarah' } }] };
      return { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Saved Sarah (Tinder, Kings Beach). Idea: paddleboarding together.' }] };
    } } });
    await agent.tick();
    assert.match(seen, /Quick note/);
    assert.match(seen, /no phone is fine/);
    assert.match(seen, /Never message the person/);
    const c = db._raw().prepare("SELECT * FROM contacts WHERE invited_by_user_id = ? AND name = 'Sarah'").all(user.id);
    assert.equal(c.length, 1);
    assert.equal(c[0].phone, null);
    assert.equal(c[0].met_via, 'Tinder');
    assert.match(c[0].about, /Kings Beach/);
    assert.ok(db._raw().prepare("SELECT 1 FROM wishes WHERE user_id = ? AND text LIKE '%Sarah%'").get(user.id), 'a wish around her');
    assert.ok(!db._raw().prepare('SELECT 1 FROM social_events WHERE host_user_id = ?').get(user.id), 'no plan unless asked');
    assert.equal(sent.filter((m) => m.to !== user.phone).length, 0, 'nobody else was texted');
  });
  test('the same name without a number is the same person — details added, no duplicate', () => {
    const uid = uuidv4();
    db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Dup', '+12025340009', 'complete')").run(uid);
    const a = db.upsertContact({ invited_by_user_id: uid, name: 'Sarah', met_via: 'Tinder', about: 'Kings Beach' });
    const b = db.upsertContact({ invited_by_user_id: uid, name: 'sarah', about: 'loves tacos' });
    assert.equal(a, b);
    assert.equal(db._raw().prepare('SELECT about FROM contacts WHERE id = ?').get(a).about, 'Kings Beach · loves tacos');
  });
  test('a screenshot is read once into facts (no looks), the note carries them, and the image is kept nowhere', async () => {
    const { cookie, user } = await login('Sean QN4', '+12025340004');
    const png = 'data:image/png;base64,' + Buffer.from('fake-screenshot-bytes').toString('base64');
    let asked = null;
    screenread._setClient({ messages: { create: async (req) => { asked = req; return { content: [{ type: 'text', text: 'App: Tinder\nPerson: Sarah, 31\nWhere: Kings Beach\nInto: paddleboarding, tacos' }] }; } } });
    const r = await request.post('/api/quick').set('Cookie', cookie).send({ text: 'this is Sarah', image: png });
    assert.equal(r.status, 200);
    for (let i = 0; i < 50 && !db._raw().prepare('SELECT 1 FROM inbound_messages WHERE from_id = ?').get(user.id); i++) await new Promise((x) => setTimeout(x, 20));
    const row = db._raw().prepare('SELECT text, intent FROM inbound_messages WHERE from_id = ?').get(user.id);
    assert.equal(row.intent, 'capture');
    assert.match(row.text, /^this is Sarah\n\n\[What was on my screen\]\nApp: Tinder/);
    assert.match(row.text, /Kings Beach/);
    assert.equal(asked.messages[0].content[0].type, 'image');
    assert.equal(asked.messages[0].content[0].source.media_type, 'image/png');
    assert.match(screenread.PROMPT, /Never describe anyone's looks/);
    // The picture is in no table.
    const tables = db._raw().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    const needle = png.slice(30, 50);
    for (const t of tables) {
      const cols = db._raw().prepare(`PRAGMA table_info("${t}")`).all().filter((c) => /TEXT|BLOB|^$/i.test(c.type)).map((c) => `"${c.name}"`);
      if (!cols.length) continue;
      const hit = db._raw().prepare(`SELECT 1 FROM "${t}" WHERE ${cols.map((c) => `instr(CAST(${c} AS TEXT), ?) > 0`).join(' OR ')} LIMIT 1`).get(...cols.map(() => needle));
      assert.ok(!hit, `screenshot stored in ${t}`);
    }
  });
  test('a screenshot that can\'t be read still saves the note, and says so; a non-image is refused', async () => {
    const { cookie, user } = await login('Sean QN5', '+12025340005');
    screenread._setClient({ messages: { create: async () => { throw new Error('boom'); } } });
    const png = 'data:image/png;base64,' + Buffer.from('x').toString('base64');
    assert.equal((await request.post('/api/quick').set('Cookie', cookie).send({ image: png })).status, 200);
    for (let i = 0; i < 50 && !db._raw().prepare('SELECT 1 FROM inbound_messages WHERE from_id = ?').get(user.id); i++) await new Promise((x) => setTimeout(x, 20));
    assert.match(db._raw().prepare('SELECT text FROM inbound_messages WHERE from_id = ?').get(user.id).text, /couldn't be read/);
    assert.equal((await request.post('/api/quick').set('Cookie', cookie).send({ image: 'data:text/html;base64,PGI+' })).status, 400);
  });
  test('Share a screenshot from any app → Quick note', () => {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '../../public/manifest.json'), 'utf8'));
    assert.ok(m.share_target.params.files.some((f) => f.name === 'screenshot' && f.accept.includes('image/*')));
    const sw = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');
    assert.match(sw, /pending-shot/);
    assert.match(fs.readFileSync(path.join(__dirname, '../../public/app/quick.html'), 'utf8'), /pending-shot/);
  });
  test('empty is refused; signed out is refused', async () => {
    const { cookie } = await login('Sean QN2', '+12025340002');
    assert.equal((await request.post('/api/quick').set('Cookie', cookie).send({ text: ' ' })).status, 400);
    assert.notEqual((await request.post('/api/quick').send({ text: 'x' })).status, 200);
  });
  test('reachable from the app icon and Share: manifest shortcut, share_target takes text, service worker sends it to Quick note', () => {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '../../public/manifest.json'), 'utf8'));
    assert.ok(m.shortcuts.some((s) => s.url === '/app/quick'));
    assert.equal(m.share_target.params.text, 'text');
    assert.ok(m.share_target.params.files, 'vCard sharing still works');
    const sw = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');
    assert.match(sw, /\/app\/quick\?/);
  });
  test('the page is served to signed-in users', async () => {
    const { cookie } = await login('Sean QN3', '+12025340003');
    const r = await request.get('/app/quick').set('Cookie', cookie);
    assert.equal(r.status, 200);
    assert.match(r.text, /Quick note/);
  });
});
