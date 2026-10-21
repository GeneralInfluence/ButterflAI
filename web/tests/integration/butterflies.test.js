/**
 * butterflies.test.js — owner, 2026-10-21: "every butterfly in the app should be consistent. Make sure you save all of
 * these different butterfly options so that way we can experiment with it over time."
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'butterflies-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const PUB = path.join(__dirname, '../../public');

function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])); }

describe('one butterfly everywhere', () => {
  test('no 🦋 emoji left on any screen — every butterfly is the current design (text messages keep theirs)', () => {
    const left = walk(PUB).filter((f) => /\.(html|js)$/.test(f) && !f.includes('/vendor/')).filter((f) => fs.readFileSync(f, 'utf8').includes('🦋'));
    assert.deepEqual(left.map((f) => path.relative(PUB, f)), []);
  });
  test('every page\'s favicon is the butterfly image, not an emoji drawing', () => {
    for (const f of walk(PUB).filter((x) => x.endsWith('.html'))) assert.ok(!/rel="icon" href="data:image\/svg/.test(fs.readFileSync(f, 'utf8')), path.relative(PUB, f));
    for (const f of ['icons/butterfly-128.png', 'icons/favicon-32.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'favicon.ico']) assert.ok(fs.statSync(path.join(PUB, f)).size > 500, f);
    assert.ok(fs.existsSync(path.join(__dirname, '../../tools/butterfly-icons.js')), 'one tool makes them all from a chosen design');
  });
  test('every design is kept and shown side by side, the one in use marked', async () => {
    const saved = fs.readdirSync(path.join(PUB, 'icons/butterflies'));
    for (const f of ['monarch-original.svg', 'monarch-rust-purple-cyan.svg', 'cyborg-simple-flat.svg', 'cyborg-steampunk-original.png', 'cyborg-steampunk-purple.png']) assert.ok(saved.includes(f), f);
    const phone = '+12025391000';
    db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Sean B', ?, 'complete')").run(uuidv4(), phone);
    db.writeConsent(phone, 'INVITE_PAGE');
    await request.post('/auth/otp/send').send({ phone });
    const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(phone);
    const c = (await request.post('/auth/otp/verify').send({ phone, code })).headers['set-cookie'][0];
    const d = (await request.get('/api/butterflies').set('Cookie', c)).body.designs;
    assert.equal(d.filter((x) => x.current).length, 1);
    assert.equal(d[0].current, true);
    assert.equal((await request.get('/app/butterflies').set('Cookie', c)).status, 200);
  });
});
