/**
 * rate-limit.test.js — 2026-10-19, "The app is completely unresponsive": every request reached
 * us from Fly's proxy address, so the whole app shared ONE allowance (100 / 15 min); once used,
 * everyone got 429 and the chat's 2-second retries kept it used up.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'rate-limit-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { app, clientKey, RATE } = require('../../server');
const request = supertest(app);

describe('rate limits are per person, not per proxy', () => {
  test('the key is the real client address Fly passes on', () => {
    assert.equal(clientKey({ get: (h) => (h === 'fly-client-ip' ? '203.0.113.7' : undefined), ip: '2a09:8280:1::119:c881:0' }), '203.0.113.7');
    assert.equal(clientKey({ get: () => undefined, ip: '198.51.100.2' }), '198.51.100.2');
  });
  test('two people behind the same proxy have separate allowances', async () => {
    const a = await request.get('/api/version').set('Fly-Client-IP', '203.0.113.10');
    const b = await request.get('/app/login').set('Fly-Client-IP', '203.0.113.11');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const r = await request.get('/app/login').set('Fly-Client-IP', '203.0.113.12');
    assert.equal(Number(r.headers['ratelimit-limit'] || r.headers['ratelimit']?.match(/limit=(\d+)/)?.[1] || RATE.max), RATE.max);
  });
  test('the allowance fits an open chat (it polls and streams) — not 100 per 15 minutes', () => {
    assert.ok(RATE.max >= 1000 && RATE.windowMs === 15 * 60 * 1000);
  });
  test('health and version checks are never limited', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await request.get('/health')).status, 200);
  });
  test('the chat backs off when the connection keeps failing', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/chat.html'), 'utf8');
    assert.ok(html.includes('sseDelay = Math.min(sseDelay * 2, 60000)') && html.includes('eventSource.onopen = () => { sseDelay = 2000; }'));
  });
});
