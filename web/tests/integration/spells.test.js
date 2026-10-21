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
  // Ideas about something happening come with a page to find out more (🐛 #51 — without one they aren't suggested).
  list = list.map((x) => (['nearby', 'new'].includes(x.kind) && !x.link ? { ...x, link: `https://events.test/${encodeURIComponent(x.title)}` } : x));
  // The web search's results name the sites the links are on (links to other sites are dropped, 🐛 #41).
  const results = { type: 'web_search_tool_result', content: list.filter((x) => x.link).map((x) => ({ type: 'web_search_result', url: x.link, title: 'r' })) };
  spells._setClient({ messages: { create: async (req) => { seen.push(req); return { stop_reason: 'end_turn', content: [results, { type: 'text', text: JSON.stringify({ spells: list }) }] }; } } });
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
    // Since 2026-10-20 the ideas themselves are in the Explore tab; Home's Feeling points there.
    assert.ok(html.includes('<div id="spell-preview"></div>') && html.includes('href="/app/explore"') && html.includes('for you in Explore'));
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
    // Distinct ideas (titles differing only by a number now count as the same idea — 🐛 #41).
    const W = ['jazz', 'pottery', 'salsa', 'hiking', 'trivia', 'karaoke', 'bowling', 'kayaking', 'climbing', 'yoga', 'tacos', 'sushi', 'bingo', 'chess', 'darts', 'ramen', 'opera', 'ballet', 'rodeo', 'circus', 'poetry', 'improv', 'curling', 'archery', 'fencing', 'polo', 'rugby', 'squash', 'tennis', 'golf', 'surfing', 'sailing', 'rowing', 'skating', 'sledding', 'skiing', 'birding', 'fishing', 'camping', 'baking', 'brewing', 'tasting', 'painting', 'knitting', 'quilting', 'weaving', 'sewing', 'carving', 'welding', 'gardening', 'stargazing', 'drumming', 'singing', 'dancing', 'juggling', 'magic', 'puppets', 'origami', 'calligraphy', 'mosaic', 'candles', 'soap', 'perfume', 'cheese', 'wine', 'cider', 'mead', 'kombucha', 'pickles', 'bread', 'pasta', 'dumplings', 'curry', 'barbecue', 'chili', 'pie', 'donuts', 'waffles', 'crepes', 'gelato', 'fondue', 'tapas', 'mezze', 'dim sum', 'pho', 'tamales', 'empanadas', 'arepas', 'pupusas', 'gumbo', 'paella', 'risotto', 'gnocchi', 'ravioli', 'lasagna', 'falafel', 'shawarma', 'kebab', 'biryani', 'samosas', 'naan', 'bao', 'ramen bar'];
    let w = 0;
    const batch = (p) => ['nearby', 'nearby', 'reconnect', 'reconnect', 'new', 'new', 'wish', 'wish'].map((k) => ({ kind: k, title: p === 'First' ? `First ${['jazz', 'pottery', 'salsa', 'hiking', 'trivia', 'karaoke', 'bowling', 'kayaking'][w++ % 8]} night` : `${W[w++ % W.length]} ${p} meetup`, why: 'w' }));
    const first = batch('First');
    let seen = model(first);
    assert.equal(await spells.generate(sean, { force: true }), 8);
    assert.match(seen[0].messages[0].content, /Imagine 8 ideas, two of each kind/);
    seen = model([...first.slice(0, 2), ...batch('Second')]);
    const r = await spells.more(sean.id);
    assert.equal(r.made, 8, 'the two repeats are skipped');
    assert.match(seen[0].messages[0].content, /Ideas they already have \(don't repeat\): First jazz night/);
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
    // The link opened securely (🐛 #41 — only checked links are shown, and passed on with the idea).
    db._raw().prepare("UPDATE spells SET link_ok = 1 WHERE link = 'https://example.com/jazz'").run();
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
    model(['Jazz', 'Opera', 'Rodeo', 'Circus'].map((t) => ({ kind: 'nearby', title: `${t} show with B?`, public_title: `${t} show`, why: 'x' })));
    await spells.generate(a, { force: true });
    for (const x of spells.forUser(a.id)) spells.answer(a.id, x.id, 'wish');
    assert.equal(spells.forUser(b.id).length, 3);
  });
  // Ideas moved from Home to their own tab, Explore (owner, 2026-10-20); it asks for more as you scroll.
  // The "how it spreads" line went with the Instagram-style redesign (🐛 #39) — the 🔁 line on each post says it.
  test('🐛 #37: the Feed imagines more and says how Sounds nice spreads', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/explore.html'), 'utf8');
    assert.ok(html.includes("fetch('/api/spells/more'") && html.includes('people around you like this'));
  });

  // 🐛 #41 (Sean, 2026-10-20): "I opened the cargo website and it was an unsecured website … how did you
  // find it in the first place? If it's an unsecured site, how do I know it's real?" — the model linked
  // cargoconcerthall.com (broken https; the venue's site is cargoreno.com), named Oct 24 a Friday, and
  // the same two concerts came back twice.
  test('🐛 #41: links only to sites the search returned and that open securely, weekdays fixed, the same event never twice', async () => {
    const sean = mkUser('Sean V');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const d = new Date(Date.now() + 4 * 86400e3).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const real = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(`${d}T12:00:00Z`).getUTCDay()];
    const wrong = real === 'Friday' ? 'Saturday' : 'Friday';
    const seen = [];
    spells._setClient({ messages: { create: async (req) => { seen.push(req); return { stop_reason: 'end_turn', content: [
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://www.cargoreno.com/upcoming-events', title: 'Cargo' }] },
      { type: 'text', text: JSON.stringify({ spells: [
        { kind: 'nearby', title: `Free Throw at Cargo ${wrong}`, public_title: `Free Throw at Cargo ${wrong}`, why: `Live indie music ${wrong}`, link: 'https://www.cargoreno.com/upcoming-events', date: d, place: 'Cargo Concert Hall' },
        { kind: 'nearby', title: 'New Constellations at Cargo', why: 'x', link: 'https://cargoconcerthall.com', date: d, place: 'Cargo Concert Hall' },
        { kind: 'nearby', title: `Free Throw at Cargo on ${real}`, why: 'the same concert again', link: 'https://downtownreno.org/events/', date: d },
        { kind: 'nearby', title: 'Last week’s show', why: 'over', date: '2020-01-01' },
      ] }) }] }; } } });
    await spells.generate(sean, { force: true });
    assert.match(seen[0].messages[0].content, /Facts must come from your search results/);
    const list = spells.forUser(sean.id);
    // 🐛 #51 (next day): an event idea with no page you can open isn't suggested at all — New Constellations'
    // site never came back in the search, so it's gone (it used to be kept without its link).
    assert.deepEqual(list.map((x) => x.title), [`Free Throw at Cargo ${real}`], 'same concert once, past one gone, weekday fixed, no unverifiable idea');
    const ft = list.find((x) => x.title.startsWith('Free Throw'));
    assert.match(ft.why, new RegExp(real));
    assert.equal(ft.date, d); assert.equal(ft.place, 'Cargo Concert Hall'); assert.equal(ft.source_site, 'cargoreno.com');
    assert.equal(ft.link, null, 'not shown until it has opened securely');
    assert.equal(db._raw().prepare("SELECT 1 FROM spells WHERE user_id = ? AND title = 'New Constellations at Cargo'").get(sean.id), undefined, 'a site the search never returned: not suggested');
    // The link is checked: a site that won't open securely stays hidden.
    const og = require('../../ogimage');
    og._setLookup(async () => [{ address: '93.184.216.34' }]);
    og._setFetch(async (url) => { if (url.includes('cargoreno')) throw new Error('TLS alert internal error'); return { status: 200, ok: true, headers: new Map([['content-type', 'text/html']]), text: async () => '' }; });
    await spells.fillImages({ limit: 500 });
    assert.equal(spells.forUser(sean.id).find((x) => x.title.startsWith('Free Throw')), undefined, '🐛 #51: a page that won\'t open — the idea isn\'t shown');
    assert.equal(db._raw().prepare("SELECT link_ok FROM spells WHERE user_id = ? AND title LIKE 'Free Throw%'").get(sean.id).link_ok, 0);
    og._setFetch(async () => ({ status: 200, ok: true, headers: new Map([['content-type', 'text/html']]), text: async () => '' }));
    db._raw().prepare("UPDATE spells SET image_checked = 0, link_ok = NULL WHERE user_id = ?").run(sean.id);
    await spells.fillImages({ limit: 500 });
    assert.equal(spells.forUser(sean.id).find((x) => x.title.startsWith('Free Throw')).link, 'https://www.cargoreno.com/upcoming-events');
    assert.equal((await og.check('http://example.com/')).ok, false, 'plain http is never shown');
    og._setFetch(null);
    assert.equal(spells.fixWeekdays('Jazz Fri and Saturday night', '2026-10-24'), 'Jazz Sat and Saturday night');
    assert.ok(spells.alike(spells.words('New Constellations at Cargo Thursday'), spells.words('New Constellations at Cargo Thursday Night')));
    assert.ok(!spells.alike(spells.words('Jazz at Shea’s'), spells.words('Pottery at The Wedge')));
  });
});
