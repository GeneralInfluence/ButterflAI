/**
 * spells.test.js — 🐛 #36 (Sean, 2026-10-20): "I almost want you to imagine what's possible … you
 * could be doing this, you could be going there … ButterflAI ends up making things happen by
 * constantly casting spells." Ideas built from the person's OWN chats, plans and wishes + public events.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'spells-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
require('../../server');
const db = require('../../db');
const spells = require('../../spells');
const planops = require('../../planops');

let n = 0;
function mkUser(name) {
  const phone = `+1202530${String(2000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, city) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', 'Reno')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (o, u) => db.upsertContact({ invited_by_user_id: o.id, name: u.name, phone: u.phone, tier: 1 });
function model(list) {
  const seen = [];
  spells._setClient({ messages: { create: async (req) => { seen.push(req); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ spells: list }) }] }; } } });
  return seen;
}

describe('🐛 #36: ButterflAI imagines ideas for you', () => {
  test('built from your own plans, friends, wishes and words (+ a web search for what\'s on near you)', async () => {
    const sean = mkUser('Sean S'); const allie = mkUser('Allie S'); const other = mkUser('Other S');
    const e = (await planops.create(sean.id, { title: 'Lunch with Allie', scheduled_at: new Date(Date.now() + 3 * 86400e3).toISOString(), contact_ids: [knows(sean, allie)] })).eventId;
    planops.respond(db._raw().prepare('SELECT id FROM event_invitations WHERE event_id = ?').get(e).id, 'accepted', { by: 'guest', phone: allie.phone });
    require('../../wishes').add(sean.id, { text: 'Learn to salsa' });
    db.appendConversation(sean.id, 'user', 'I love live jazz');
    db.appendConversation(other.id, 'user', 'SECRET other person words');
    const seen = model([{ kind: 'nearby', title: 'Jazz at Shea’s Thursday?', why: 'You said you love live jazz', link: 'https://example.com/jazz' },
      { kind: 'reconnect', title: 'Lunch again with Allie?', why: 'It’s been a few weeks' }, { kind: 'new', title: 'Try a salsa class', why: 'Your wish' }]);
    assert.equal(await spells.generate(sean, { force: true }), 3);
    const prompt = seen[0].messages[0].content;
    assert.match(prompt, /Lunch with Allie/); assert.match(prompt, /Learn to salsa/); assert.match(prompt, /I love live jazz/); assert.match(prompt, /Allie \(/);
    assert.ok(!prompt.includes('SECRET other person words'), 'never other people\'s chats');
    assert.equal(seen[0].tools[0].type, 'web_search_20250305', 'searches what\'s on near them');
    assert.deepEqual(spells.forUser(sean.id).map((s) => s.kind), ['nearby', 'reconnect', 'new']);
  });
  test('never names someone on your avoid list, whatever the model writes', async () => {
    const sean = mkUser('Sean A'); const julie = mkUser('Julie A');
    require('../../avoid').addAvoid(sean.id, knows(sean, julie));
    model([{ kind: 'reconnect', title: 'Coffee with Julie?', why: 'x' }, { kind: 'new', title: 'Pottery class', why: 'y' }]);
    await spells.generate(sean, { force: true });
    assert.deepEqual(spells.forUser(sean.id).map((s) => s.title), ['Pottery class']);
  });
  test('✨ Sounds nice → your wish; Make it a plan → ＋ New plan text; ✕ → remembered so similar ones stop', async () => {
    const sean = mkUser('Sean B');
    const seen = model([{ kind: 'new', title: 'Try a pottery class?', why: 'Something new' }, { kind: 'nearby', title: 'Farmers market Saturday', why: 'Fresh peaches', link: 'https://example.com/m' },
      { kind: 'wish', title: 'Cabin weekend in Tahoe', why: 'Your wish' }]);
    await spells.generate(sean, { force: true });
    const by = Object.fromEntries(spells.forUser(sean.id).map((x) => [x.kind, x]));
    const a = by.new, b = by.nearby, c = by.wish;
    const w = spells.answer(sean.id, c.id, 'wish');
    assert.equal(w.wish.text, 'Cabin weekend in Tahoe');
    assert.match(spells.answer(sean.id, b.id, 'plan').text, /^Farmers market Saturday — Fresh peaches \(https:\/\/example\.com\/m\)$/);
    spells.answer(sean.id, a.id, 'dismiss');
    assert.deepEqual(spells.forUser(sean.id), []);
    await spells.generate(sean, { force: true });
    assert.match(seen.at(-1).messages[0].content, /Not into \(dismissed before[^\n]*Try a pottery class\?/);
  });
  test('once a day; Home shows them first in Feeling, the quick shares in the full view', async () => {
    const sean = mkUser('Sean C');
    model([{ kind: 'new', title: 'Board game café', why: 'z' }]);
    assert.equal(await spells.generate(sean), 1);
    assert.equal(await spells.generate(sean), 0, 'not twice in a day');
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/dashboard.html'), 'utf8');
    assert.ok(html.includes('<div id="spell-preview"></div>') && html.includes('✨ Sounds nice') && html.includes('✨ ButterflAI imagines…'));
    const home = html.slice(html.indexOf('id="sec-feeling"'), html.indexOf('id="sec-creating"'));
    assert.ok(!home.includes("quickShare('Free tonight'"), 'the quick shares moved to the full Feeling view');
    assert.equal(require('../../home').feedFor(sean.id).summary.feeling.line, '1 idea for you');
  });
});
