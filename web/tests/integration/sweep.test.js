/**
 * sweep.test.js — the daily consistency sweep (sweep.js) and 🐛 #29 (Sean, 2026-10-20: "Why is
 * the '80s bar on California still there? I deleted that a long time ago … these sweeps …
 * [aren't] properly implemented yet"). Bam Bam's July 16 "tonight" open invite never ended.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'sweep-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
require('../../server');
const db = require('../../db');
const planops = require('../../planops');
const plan = require('../../plan');
const sweep = require('../../sweep');

let n = 0;
function mkUser(name) {
  const phone = `+1202535${String(5000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (o, u) => db.upsertContact({ invited_by_user_id: o.id, name: u.name, phone: u.phone, tier: 1 });
const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);

describe('🐛 #29: an open invite ends after its night', () => {
  test('a "come by tonight" from months ago is past: off Home, the chat pills and the plan list', async () => {
    const bam = mkUser('Bam S'); const sean = mkUser('Sean S');
    const e = (await planops.create(bam.id, { title: '80s bar on California Ave', flexible_time: true, contact_ids: [knows(bam, sean)] })).eventId;
    planops.respond(db._raw().prepare('SELECT id FROM event_invitations WHERE event_id = ?').get(e).id, 'accepted', { by: 'guest', phone: sean.phone });
    assert.notEqual(plan.planFor(e, sean.id).stage, 'past', 'tonight it is on');
    db._raw().prepare('UPDATE social_events SET scheduled_at = ? WHERE id = ?').run(Math.floor(Date.UTC(2026, 6, 17, 0, 3) / 1000), e);   // Jul 16, 5pm PT
    const p = plan.planFor(e, sean.id);
    assert.equal(p.stage, 'past');
    assert.match(p.dates.label, /^Open invite · Thu, Jul 16$/);
    assert.ok(!plan.plansFor(sean.id).some((x) => x.id === e));
    assert.ok(!require('../../home').feedFor(sean.id).items.some((i) => i.event_id === e));
  });
});

describe('the daily sweep', () => {
  test('every check says what it does', () => {
    for (const c of sweep.CHECKS) assert.ok(c.name && c.about.length > 20, c.name);
  });
  test('repeats on Creating go; two open same-name plans are combined; stale questions close; it\'s all logged', async () => {
    const sean = mkUser('Sean W'); const mel = mkUser('Mel W');
    const a = (await planops.create(sean.id, { title: 'Grover Trip', proposed_dates: [{ from: day(9), to: day(10) }] })).eventId;
    db._raw().prepare("INSERT INTO event_todos (id, event_id, text, created_by) VALUES (?, ?, 'Book the campsite at Grover', ?), (?, ?, 'campsite', ?)").run(uuidv4(), a, sean.id, uuidv4(), a, sean.id);
    // a same-name duplicate made before one-plan-per-name existed
    const dupId = uuidv4();
    db._raw().prepare("INSERT INTO social_events (id, host_user_id, title, activity_type, scheduled_at, date_tbd, tentative) VALUES (?, ?, 'grover trip!', 'trip', ?, 1, 1)").run(dupId, sean.id, Math.floor(Date.now() / 1000) + 40 * 86400);
    db._raw().prepare("INSERT INTO agent_messages (id, thread_id, from_user, to_user, kind, topic, body, processed, created_at) VALUES (?, ?, ?, ?, 'query', 'coordination', 'old?', 0, ?)")
      .run(uuidv4(), a, mel.id, sean.id, Math.floor(Date.now() / 1000) - 9 * 86400);
    const r = sweep.run({ force: true });
    assert.ok(r['creating-repeats'] >= 1 && r['same-name-plans'] >= 1 && r['stale-questions'] >= 1, JSON.stringify(r));
    assert.deepEqual(db._raw().prepare('SELECT text FROM event_todos WHERE event_id = ?').all(a).map((t) => t.text), ['Book the campsite at Grover']);
    assert.equal(db._raw().prepare('SELECT status FROM social_events WHERE id = ?').get(dupId).status, 'cancelled');
    assert.ok(sweep.recent().some((x) => x.check_name === 'same-name-plans' && /grover trip!/.test(x.detail)));
    assert.equal(sweep.run(), null, 'once a day');
  });
});

describe('people are named as you know them, never "New user"', () => {
  test('Alexandria never finished signing up ("New user"): Sean\'s side says Alexandria', () => {
    const sean = mkUser('Sean N'); const alex = mkUser('New user');
    db.upsertContact({ invited_by_user_id: sean.id, name: 'Alexandria Spargo', phone: alex.phone, tier: 1 });
    const { nameFor } = require('../../people');
    assert.equal(nameFor(sean.id, alex.id), 'Alexandria Spargo');
    assert.equal(nameFor(mkUser('Stranger N').id, alex.id), 'A friend', 'no contact, placeholder name → "A friend"');
    assert.equal(nameFor(alex.id, sean.id, { first: true }), 'Sean');
  });
  test('agent queries and replies use it', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../agent.js'), 'utf8');
    assert.ok(src.includes("[Agent query from ${require('./people').nameFor(targetUser.id, userId)}'s agent") && src.includes("[Agent reply from ${require('./people').nameFor(original.from_user, userId)}'s agent"));
  });
});
