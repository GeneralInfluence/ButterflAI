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
    // Since 2026-10-20 the ideas themselves are in the ✨ Feed tab; Home's Feeling points there.
    assert.ok(html.includes('<div id="spell-preview"></div>') && html.includes('href="/app/feed"') && html.includes('for you in your Feed'));
    const home = html.slice(html.indexOf('id="sec-feeling"'), html.indexOf('id="sec-creating"'));
    assert.ok(!home.includes("quickShare('Free tonight'"), 'the quick shares moved to the full Feeling view');
    assert.equal(require('../../home').feedFor(sean.id).summary.feeling.line, '1 idea for you');
  });

  // 🐛 #37 (Sean, 2026-10-20): "more suggestions that I'd be able to scroll through … when it says sounds
  // nice, I want that to be sort of like a retweet or a repost where there are other people that are
  // somehow associated with me … more likely to see it … they don't necessarily know that it's from me.
  // But still we influence each other's algorithm".
  test('🐛 #37: eight ideas a day, ✨ More ideas adds more (never repeats), up to a daily limit', async () => {
    const sean = mkUser('Sean M');
    const batch = (p) => ['nearby', 'nearby', 'reconnect', 'reconnect', 'new', 'new', 'wish', 'wish'].map((k, i) => ({ kind: k, title: `${p} idea ${i}`, why: 'w' }));
    let seen = model(batch('First'));
    assert.equal(await spells.generate(sean, { force: true }), 8);
    assert.match(seen[0].messages[0].content, /Imagine 8 ideas, two of each kind/);
    seen = model([...batch('First').slice(0, 2), ...batch('Second')]);
    const r = await spells.more(sean.id);
    assert.equal(r.made, 8, 'the two repeats are skipped');
    assert.match(seen[0].messages[0].content, /Ideas they already have \(don't repeat\): First idea 0/);
    assert.equal(spells.forUser(sean.id).length, 16, 'More adds to today\'s; nothing replaced');
    // The cap is MAX_PER_DAY (80 since the ✨ Feed asks for more as you scroll — 10 batches).
    for (let i = 3; i * 8 <= spells.MAX_PER_DAY; i++) { model(batch(`B${i}`)); assert.equal((await spells.more(sean.id)).made, 8); }
    model(batch('Over'));
    assert.equal((await spells.more(sean.id)).error, 'ENOUGH');
  });
  test('🐛 #37: ✨ Sounds nice passes a public idea on — no name — to friends and plan-mates in town, never friends/wish ideas, avoid lists both ways', async () => {
    const sean = mkUser('Sean E'); const kim = mkUser('Kim E'); const pat = mkUser('Pat E'); const far = mkUser('Far E'); const julie = mkUser('Julie E'); const stranger = mkUser('Stranger E');
    db._raw().prepare("UPDATE users SET city = 'Boston' WHERE id = ?").run(far.id);
    for (const u of [kim, far, julie]) { knows(sean, u); knows(u, sean); }          // friends (saved each other)
    const e = (await planops.create(pat.id, { title: 'Pat bbq', scheduled_at: new Date(Date.now() + 86400e3).toISOString(), contact_ids: [knows(pat, sean)] })).eventId;
    planops.respond(db._raw().prepare('SELECT id FROM event_invitations WHERE event_id = ?').get(e).id, 'accepted', { by: 'guest', phone: sean.phone });   // a plan-mate
    require('../../avoid').addAvoid(julie.id, db._raw().prepare('SELECT id FROM contacts WHERE invited_by_user_id = ? AND phone = ?').get(julie.id, sean.phone).id);
    model([{ kind: 'nearby', title: 'Jazz at Shea’s Thursday with Kim?', public_title: 'Jazz at Shea’s Thursday', why: 'You love jazz', link: 'https://example.com/jazz' },
      { kind: 'reconnect', title: 'Lunch with Kim?', public_title: 'Lunch with Kim', why: 'x' },
      { kind: 'new', title: 'Salsa class', why: 'no public title → never spreads' }]);
    await spells.generate(sean, { force: true });
    const mine = spells.forUser(sean.id);
    const jazz = mine.find((x) => x.kind === 'nearby');
    const r = spells.answer(sean.id, jazz.id, 'wish');
    assert.equal(r.passed_on, 2);
    const got = (u) => spells.forUser(u.id);
    for (const u of [kim, pat]) {
      const [x] = got(u);
      assert.equal(x.title, 'Jazz at Shea’s Thursday', 'the public title — nobody named');
      assert.ok(x.passed_on && x.liked_by === 1 && x.why === 'People around you like this');
      assert.equal(x.link, 'https://example.com/jazz');
      assert.ok(!JSON.stringify(x).includes('Sean'));
    }
    assert.equal(got(far).length, 0, 'another town');
    assert.equal(got(julie).length, 0, 'avoid lists');
    assert.equal(got(stranger).length, 0, 'not associated');
    assert.equal(spells.answer(sean.id, mine.find((x) => x.kind === 'reconnect').id, 'wish').passed_on, 0, 'ideas about friends never spread');
    assert.equal(spells.answer(sean.id, mine.find((x) => x.kind === 'new').id, 'wish').passed_on, 0);
    // Kim likes it too → passed on from Kim; Pat already has it → it counts one more person.
    knows(kim, pat); knows(pat, kim);
    spells.answer(kim.id, got(kim)[0].id, 'wish');
    assert.equal(got(pat)[0].liked_by, 2);
    assert.equal(got(pat).length, 1, 'not twice');
    // And it shapes what ButterflAI imagines next for people around them.
    const seen = model([]);
    await spells.generate(pat, { force: true });
    assert.match(seen[0].messages[0].content, /Liked lately by people around them \(anonymous[^\n]*Jazz at Shea’s Thursday/);
    assert.ok(!seen[0].messages[0].content.includes('Jazz at Shea’s Thursday with Kim'));
  });
  test('🐛 #37: an idea passed on to you and the same idea imagined for you are one card, with the count', async () => {
    const a = mkUser('A Dup'); const b = mkUser('B Dup'); knows(a, b); knows(b, a);
    model([{ kind: 'nearby', title: 'Bluegrass at Jason’s', public_title: 'Bluegrass at Jason’s', why: 'x' }]);
    await spells.generate(a, { force: true });
    spells.answer(a.id, spells.forUser(a.id)[0].id, 'wish');
    model([{ kind: 'nearby', title: 'Bluegrass at Jason’s with A?', public_title: 'Bluegrass at Jason’s', why: 'You love live music' }]);
    await spells.generate(b, { force: true });
    const list = spells.forUser(b.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'Bluegrass at Jason’s with A?');
    assert.ok(list[0].passed_on && list[0].liked_by === 1);
  });
  test('🐛 #37: no more than three passed-on ideas a day for anyone', async () => {
    const a = mkUser('A Cap'); const b = mkUser('B Cap'); knows(a, b); knows(b, a);
    model([1, 2, 3, 4].map((i) => ({ kind: 'nearby', title: `Show ${i} with B?`, public_title: `Show ${i}`, why: 'x' })));
    await spells.generate(a, { force: true });
    for (const x of spells.forUser(a.id)) spells.answer(a.id, x.id, 'wish');
    assert.equal(spells.forUser(b.id).length, 3);
  });
  // Ideas moved from Home to their own ✨ Feed tab (owner, 2026-10-20); the feed asks for more as you scroll.
  test('🐛 #37: the Feed imagines more and says how Sounds nice spreads', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/feed.html'), 'utf8');
    assert.ok(html.includes("fetch('/api/spells/more'") && html.includes('without your name') && html.includes('people around you like this'));
  });
});
