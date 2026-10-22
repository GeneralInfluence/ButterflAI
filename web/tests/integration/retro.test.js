/**
 * retro.test.js — behavior changes apply to what already exists, once per existing user.
 *
 * Owner, 2026-10-10: "When we make updates to this app, we need to be retrospective about
 * its applications, in perpetuity." No real model calls: retro.js's and topics.js's
 * models are stubs.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'retro-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
const texts = [];
sms._setClient({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' }; } } });

require('../../server');
const db = require('../../db');
const retro = require('../../retro');
const topics = require('../../topics');
const agent = require('../../agent');

function tzAtLocalHour(h) {
  const off = (new Date().getUTCHours() - h + 24) % 24;
  return off <= 12 ? `Etc/GMT+${off}` : `Etc/GMT-${24 - off}`;
}
let n = 0;
// An existing user: created before the tasks were added.
function existingUser(name, { tz = tzAtLocalHour(14) } = {}) {
  const phone = `+1202555${String(9900 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', ?, ?)`)
    .run(uuidv4(), name, phone, tz, Date.UTC(2026, 8, 1) / 1000);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const say = (u, role, text) => db._raw().prepare(`INSERT INTO conversation_history (id, user_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)`)
  .run(uuidv4(), u.id, role, text, Math.floor(Date.now() / 1000) - 3600 * 24);
const runs = (u) => db._raw().prepare('SELECT task_id, outcome FROM retro_runs WHERE user_id = ? ORDER BY task_id').all(u.id);

describe('retro tasks', () => {
  after(() => { retro._setClient(null); topics._setClient(null); });

  test('every task is described, has a kind and an id that\'s unique', () => {
    const ids = retro.TASKS.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const t of retro.TASKS) {
      assert.ok(['internal', 'propose'].includes(t.kind), t.id);
      assert.ok(t.about && t.about.length > 20, t.id);
      assert.ok(t.added > 0, t.id);
      // A task's start can't be in the future, or people who join before it would be treated
      // as existing users (2026-10-12: one was set to later that day).
      assert.ok(t.added <= Date.now() / 1000, `${t.id} starts in the future`);
    }
  });

  test('plans discussed but never set up are OFFERED once (nothing created); each task runs once', async () => {
    const sean = existingUser('Sean Retro');
    say(sean, 'user', "regarding Melanie's birthday weekend we're going to Grover Hot Springs with my favorite mamas");
    say(sean, 'assistant', 'Got it — Grover with the Mamas.');
    say(sean, 'user', 'it is Oct 23 to 25');
    retro._setClient({ messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify({ plans: [
      { title: "Grover Hot Springs — Melanie's birthday weekend", when: 'Oct 23–25', who: ['Allie', 'Melanie', 'Bam Bam'], notes: '' }] }) }] }) } });
    topics._setClient({ messages: { create: async () => ({ content: [{ type: 'text', text: 'none' }] }) } });
    texts.length = 0;
    await retro.tick();
    const last = db._raw().prepare('SELECT text FROM conversation_history WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').get(sean.id).text;
    assert.match(last, /these aren't set up yet|this one isn't set up yet/);
    assert.match(last, /Grover Hot Springs — Melanie's birthday weekend — Oct 23–25 \(with Allie, Melanie, Bam Bam\)/);
    assert.match(last, /Want me to set it up\?/);
    assert.equal(db._raw().prepare('SELECT count(*) c FROM social_events WHERE host_user_id = ?').get(sean.id).c, 0, 'nothing created without a yes');
    assert.equal(texts.length, 0, 'in the app, not a text');
    assert.deepEqual(runs(sean).map((r) => r.task_id).sort(), retro.TASKS.map((t) => t.id).sort(), 'all tasks recorded');
    const before = db._raw().prepare('SELECT count(*) c FROM conversation_history WHERE user_id = ?').get(sean.id).c;
    await retro.tick();
    assert.equal(db._raw().prepare('SELECT count(*) c FROM conversation_history WHERE user_id = ?').get(sean.id).c, before, 'not offered twice');
  });

  test('users who joined after a task was added are skipped; offers wait for daytime', async () => {
    const fresh = existingUser('New Person');
    db._raw().prepare('UPDATE users SET created_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), fresh.id);
    const night = existingUser('Night Owl', { tz: tzAtLocalHour(2) });
    say(night, 'user', 'camping trip in november'); say(night, 'user', 'with the crew');
    retro._setClient({ messages: { create: async () => { throw new Error('should not be called'); } } });
    await retro.tick();
    assert.deepEqual(runs(fresh), []);
    assert.ok(!runs(night).some((r) => r.task_id === '2026-10-10-plans-from-past-chats'), 'proposal waits for daytime');
  });

  test('no model available → the task waits and runs later (not marked done)', async () => {
    const u = existingUser('Later Person');
    say(u, 'user', 'dinner next week'); say(u, 'user', 'with Sam');
    retro._setClient(null);
    topics._setClient(null);
    await retro.tick();
    assert.ok(!runs(u).some((r) => r.task_id === '2026-10-10-plans-from-past-chats'));
    assert.ok(!runs(u).some((r) => r.task_id === '2026-10-10-file-past-messages-into-plans'));
    assert.ok(runs(u).some((r) => r.task_id === '2026-10-10-link-group-plans'), 'tasks that need no model still run');
    assert.ok(agent);
  });
});

// 🐛 #87 (owner, 2026-10-22): "Delete them" — his own private notes and private-mode messages; nobody else's.
const { describe: d87, test: t87 } = require('node:test');
d87('retro: the owner\'s private data, deleted on request', () => {
  t87('only the owner\'s rows go', async () => {
    const db = require('../../db');
    const { v4 } = require('uuid');
    const mk = (name, phone) => { db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, created_at) VALUES (?, ?, ?, 'complete', 1700000000)").run(v4(), name, phone); return db.getUserByPhone(phone); };
    const sean = mk('Sean P', '+16099233179'); const other = mk('Other P', '+12025559876');
    for (const u of [sean, other]) {
      db._raw().prepare("INSERT INTO user_private_data (id, user_id, category, data_key, encrypted_v, iv, auth_tag) VALUES (?, ?, 'HEALTH', 'health.safety_notes', 'x', 'y', 'z')").run(v4(), u.id);
      db._raw().prepare("INSERT INTO conversation_history (id, user_id, role, text, private_ct, private_iv, private_tag) VALUES (?, ?, 'user', '[private]', 'a', 'b', 'c')").run(v4(), u.id);
    }
    const task = require('../../retro').TASKS.find((x) => x.id === '2026-10-22-delete-seans-private-data');
    require('node:assert/strict').equal(await task.run(sean), 'deleted 1 notes, 1 private messages');
    require('node:assert/strict').equal(await task.run(other), 'not the owner');
    require('node:assert/strict').equal(db._raw().prepare('SELECT count(*) n FROM user_private_data WHERE user_id = ?').get(other.id).n, 1);
  });
});
