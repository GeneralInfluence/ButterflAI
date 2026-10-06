/**
 * agent-trace.test.js — continuous capture of what the agent did, for test users only.
 *
 * Drives real agent turns through tick() with a scripted Anthropic stub (no real calls):
 *  - non-test users are never traced
 *  - test users get message → tool (input/result/duration) → reply rows
 *  - private data is redacted; private-mode turns record only which tools ran
 *  - a crashed turn records an 'error' row
 *  - rows are hard-deleted after RETENTION_DAYS
 *  - admin routes: flags carry the trace before them; /api/admin/trace is admin-only
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'trace-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const trace = require('../../trace');
const sensitive = require('../../sensitive');

function mkUser(phone, name, testUser) {
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, test_user) VALUES (?, ?, ?, 'complete', 'America/New_York', ?)`)
    .run(uuidv4(), name, phone, testUser ? 1 : 0);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}

// Scripted model: first a tool call, then a final reply.
function scripted(toolName, toolInput, reply = 'All set!') {
  let call = 0;
  agent._setAnthropic({ messages: { create: async () => {
    call++;
    if (call === 1) return { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: toolName, input: toolInput }] };
    return { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] };
  } } });
}

async function turn(user, text, channel = 'webchat') {
  db.storeInboundMessage({ from_phone: user.phone, from_type: 'user', from_id: user.id, channel, text });
  await agent.tick();
}

const rowsFor = (u) => db._raw().prepare('SELECT * FROM agent_trace WHERE user_id = ? ORDER BY id').all(u.id);

describe('agent trace — capture', () => {
  test('non-test users are never traced', async () => {
    const u = mkUser('+12025558101', 'Regular', false);
    scripted('lookup_contact', { query: 'Allie' });
    await turn(u, 'find allie');
    assert.equal(rowsFor(u).length, 0);
  });

  test('test users: message, tool call with input/result/duration, reply', async () => {
    const u = mkUser('+12025558102', 'Tester', true);
    scripted('lookup_contact', { query: 'Allie' }, 'Found nobody named Allie.');
    await turn(u, 'find allie');
    const rows = rowsFor(u);
    assert.deepEqual(rows.map((r) => r.kind), ['message', 'tool', 'reply']);
    assert.equal(rows[0].text, 'find allie');
    assert.equal(rows[1].tool_name, 'lookup_contact');
    assert.deepEqual(JSON.parse(rows[1].input_json), { query: 'Allie' });
    assert.ok(rows[1].result_json, 'result recorded');
    assert.ok(rows[1].duration_ms >= 0);
    assert.equal(rows[2].text, 'Found nobody named Allie.');
    assert.ok(rows.every((r) => r.turn_id === rows[0].turn_id && r.channel === 'webchat'));
  });

  test('private data in tool inputs is redacted', async () => {
    const u = mkUser('+12025558103', 'Redact', true);
    scripted('store_private_data', { data_key: 'health.sti_status', value: 'all negative', category: 'HEALTH' });
    await turn(u, 'store that');
    const tool = rowsFor(u).find((r) => r.kind === 'tool');
    assert.ok(!tool.input_json.includes('negative'), 'value not recorded');
    assert.equal(JSON.parse(tool.input_json).value, '[redacted]');
    assert.equal(JSON.parse(tool.input_json).data_key, 'health.sti_status', 'non-private fields kept');
  });

  test('redact(): decrypted private prefs and avoid-list names never recorded', () => {
    assert.equal(trace.redact('get_private_preferences', {}, { private_notes: { x: 'y' } }).result, '[redacted]');
    const a = trace.redact('manage_avoid_list', { action: 'add', contact_id: 'c1' }, { ok: true, name: 'Julie', on_invite: 'auto_decline' });
    assert.equal(a.result.name, '[redacted]');
    assert.equal(a.result.on_invite, 'auto_decline');
    const l = trace.redact('manage_avoid_list', { action: 'list' }, { entries: [{ name: 'Julie' }, { name: 'Dave' }] });
    assert.equal(l.result.entries, '[2 entries redacted]');
    const h = trace.redact('get_contact_hard_constraints', {}, { food_allergies: ['nuts'], health_safety_notes: 'x' });
    assert.equal(h.result.health_safety_notes, '[redacted]');
    assert.deepEqual(h.result.food_allergies, ['nuts']);
  });

  test('private-mode turns record which tools ran, nothing said', async () => {
    const u = mkUser('+12025558104', 'Private', true);
    sensitive.setSensitiveMode(u.id, true);
    scripted('lookup_contact', { query: 'Julie' }, 'Got it, privately.');
    await turn(u, 'I really dislike Julie');
    const rows = rowsFor(u);
    assert.deepEqual(rows.map((r) => r.kind), ['message', 'tool', 'reply']);
    assert.equal(rows[0].text, null);
    assert.equal(rows[1].tool_name, 'lookup_contact');
    assert.equal(rows[1].input_json, null);
    assert.equal(rows[1].result_json, null);
    assert.equal(rows[2].text, null);
    assert.ok(!JSON.stringify(rows).includes('Julie'));
  });

  test('a crashed turn records an error row', async () => {
    const u = mkUser('+12025558105', 'Crash', true);
    agent._setAnthropic({ messages: { create: async () => { throw new Error('simulated outage'); } } });
    await turn(u, 'hello');
    const err = rowsFor(u).find((r) => r.kind === 'error');
    assert.ok(err && err.text.includes('simulated outage'));
  });
});

describe('agent trace — retention', () => {
  test(`rows older than ${trace.RETENTION_DAYS} days are hard-deleted, newer kept`, () => {
    const now = Math.floor(Date.now() / 1000);
    const ins = db._raw().prepare(`INSERT INTO agent_trace (user_id, kind, text, created_at) VALUES ('ret-user', 'message', ?, ?)`);
    ins.run('old', now - (trace.RETENTION_DAYS + 1) * 86400);
    ins.run('new', now - 86400);
    trace.purgeOld(now);
    const left = db._raw().prepare(`SELECT text FROM agent_trace WHERE user_id = 'ret-user'`).all().map((r) => r.text);
    assert.deepEqual(left, ['new']);
  });
});

describe('agent trace — admin routes', () => {
  let admin, tester, adminCookie, testerCookie;

  async function cookieFor(phone) {
    await request.post('/auth/otp/send').send({ phone });
    const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(phone);
    return (await request.post('/auth/otp/verify').send({ phone, code })).headers['set-cookie'][0];
  }

  before(async () => {
    admin = mkUser('+12025558190', 'Admin', false);
    tester = mkUser('+12025558191', 'Flagger', true);
    process.env.ADMIN_PHONE = admin.phone;
    adminCookie = await cookieFor(admin.phone);
    testerCookie = await cookieFor(tester.phone);
    scripted('lookup_contact', { query: 'Sam' }, 'Booked the wrong day.');
    await turn(tester, 'book dinner with sam friday');
  });

  test('a 👎 carries what the agent did just before it', async () => {
    await request.post('/api/feedback').set('Cookie', testerCookie).send({ agent_message: 'Booked the wrong day.', note: 'I said Friday' });
    const r = await request.get('/api/admin/feedback').set('Cookie', adminCookie);
    const fb = r.body.feedback.find((f) => f.user_note === 'I said Friday');
    assert.ok(fb.trace.some((t) => t.kind === 'tool' && t.tool_name === 'lookup_contact'));
    assert.ok(fb.trace.some((t) => t.kind === 'message' && t.text === 'book dinner with sam friday'));
  });

  test('/api/admin/trace lists test-user activity, admin only', async () => {
    const ok = await request.get('/api/admin/trace').set('Cookie', adminCookie);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.retention_days, trace.RETENTION_DAYS);
    assert.ok(ok.body.trace.some((t) => t.user_name === 'Flagger'));
    const no = await request.get('/api/admin/trace').set('Cookie', testerCookie);
    assert.equal(no.status, 403);
  });
});
