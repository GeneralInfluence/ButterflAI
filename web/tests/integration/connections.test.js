/**
 * connections.test.js — owner, 2026-10-19: "I want to be told when the grants or any other
 * types of connections expire so that way they can be fixed or reconnected." Sean's Google
 * grant expired Oct 16 (7-day limit while the Google app is in testing); for three days plans
 * quietly stopped reaching his calendar and nothing said so.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'connections-test';
process.env.KMS_MASTER_KEY_HEX = process.env.KMS_MASTER_KEY_HEX || 'a'.repeat(64);
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const texts = [];
const sms = require('../../sms');
sms._setClient({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' }; } } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const connections = require('../../connections');
const calendar = require('../../calendar');

let n = 0;
function mkUser(name) {
  const phone = `+1202540${String(8000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}
const notices = (u) => db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND kind = 'notice' AND text LIKE '⚠️%' ORDER BY rowid").all(u.id).map((r) => r.text);
const expired = Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });

describe('a connection that stops working is reported to its owner', () => {
  test('Google: told once (in the app; by text without notifications), with what stopped and where to reconnect', async () => {
    const u = mkUser('Sean C1');
    await connections.broken(u.id, 'google', expired);
    await connections.broken(u.id, 'google', expired);   // the next failure: no second message
    const said = notices(u);
    assert.equal(said.length, 1);
    assert.match(said[0], /Your Google connection stopped working \(Google ended ButterflAI's access\) — your plans aren't reaching your Google Calendar/);
    assert.match(said[0], /Settings → Connections: https?:\/\/\S+\/app\/settings/);
    assert.ok(texts.some((t) => t.to === u.phone && /Google connection stopped working/.test(t.body)), 'no notifications on → texted');
  });
  test('Settings says it stopped working and shows Reconnect; a new grant clears it', async () => {
    const u = mkUser('Sean C2');
    await connections.broken(u.id, 'google', expired);
    const c = (await request.get('/api/user/connections').set('Cookie', await cookieFor(u))).body;
    assert.equal(c.google.broken?.broken, true, JSON.stringify(c));
    await calendar.storeTokens(u.id, { access_token: 'a', refresh_token: 'r' });
    assert.deepEqual(connections.statusFor(u.id), {});
  });
  test('a blip (network) is not a broken connection; a 401 from iCloud is', () => {
    assert.equal(connections.isAuthError(new Error('connect ETIMEDOUT')), false);
    assert.equal(connections.isAuthError(new Error('Invalid credentials')), true);
    assert.equal(connections.isAuthError(Object.assign(new Error('Request failed'), { status: 401 })), true);
    assert.equal(connections.isAuthError(expired), true);
  });
  test('still broken after 3 days: one reminder, then no more', async () => {
    const u = mkUser('Sean C3');
    await connections.broken(u.id, 'google', expired);
    const back = (s) => db._raw().prepare('UPDATE connection_health SET broken_at = broken_at - ?, notified_at = notified_at - ? WHERE user_id = ?').run(s, s, u.id);
    back(3 * 86400 + 60);
    await connections.tell(u.id, 'google');
    assert.equal(notices(u).length, 2);
    assert.match(notices(u)[1], /still disconnected/);
    back(3 * 86400 + 60);
    await connections.tell(u.id, 'google');
    assert.equal(notices(u).length, 2, 'at most a reminder');
  });
  test('the daily check catches an expired grant nobody was using', async () => {
    const u = mkUser('Sean C4');
    db._raw().prepare("INSERT INTO calendar_tokens (user_id, provider, ciphertext, iv, tag, wrapped_key) VALUES (?, 'google', 'x', 'x', 'x', 'x')").run(u.id);
    const real = calendar.checkGoogleAccess;
    calendar.checkGoogleAccess = async (id) => { if (id === u.id) throw expired; return true; };
    try { await connections.checkAll({ force: true }); } finally { calendar.checkGoogleAccess = real; }
    assert.equal(connections.statusFor(u.id).google.broken, true);
    assert.equal(notices(u).length, 1);
  });
  test('the calendar mirror reports an expired grant (and retries everything once it\'s back)', async () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../calmirror.js'), 'utf8');
    assert.ok(src.includes("require('./connections').report(r.user_id"));
    const c = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../contacts-import.js'), 'utf8');
    assert.ok(c.includes("require('./connections').report(userId, 'google', err)") && c.includes("require('./connections').ok(userId, 'google')"));
  });
});
