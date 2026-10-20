/**
 * ideafeed.test.js — the ✨ Feed tab (owner, 2026-10-20: "these suggestions should become a feed, a
 * social feed, and should have their own tab along the bottom … a never-ending feed that is constantly
 * being populated with stuff that Butterfly has found in their area or other people are up to, and is
 * constantly updated by the other people's inputs").
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'ideafeed-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const spells = require('../../spells');
const ideafeed = require('../../ideafeed');

let n = 0;
function mkUser(name, city = 'Truckee') {
  const phone = `+1202531${String(2000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone, city) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', ?)`).run(uuidv4(), name, phone, city);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (o, u) => db.upsertContact({ invited_by_user_id: o.id, name: u.name, phone: u.phone, tier: 1 });
function idea(u, { kind = 'nearby', title, pub = title, status = 'new' }) {
  const id = uuidv4();
  db._raw().prepare(`INSERT INTO spells (id, user_id, kind, title, why, link, expires_at, public_title, status) VALUES (?, ?, ?, ?, 'w', 'https://example.com', ?, ?, ?)`)
    .run(id, u.id, kind, title, Math.floor(Date.now() / 1000) + 86400, pub, status);
  return id;
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}

describe('✨ Feed', () => {
  test('your ideas, then public ideas from around your town — most liked first, no one named, never other towns, avoid lists, or what you already have', () => {
    const me = mkUser('Sean F'); const a = mkUser('Ann F'); const b = mkUser('Bo F'); const c = mkUser('Cy F'); const far = mkUser('Far F', 'Boston'); const julie = mkUser('Julie F');
    idea(me, { title: 'Jazz at Shea’s with Kim?', pub: 'Jazz at Shea’s' });
    idea(a, { title: 'Trivia night with Bo?', pub: 'Trivia night at the Pub' });
    idea(b, { title: 'Bluegrass Saturday', status: 'kept' });
    idea(c, { title: 'Bluegrass Saturday', status: 'kept' });
    idea(a, { title: 'Jazz at Shea’s' });                                  // you already have it
    idea(a, { kind: 'reconnect', title: 'Lunch with Bo', pub: null });     // about a friend — never
    idea(far, { title: 'Boston harbor cruise' });
    idea(julie, { title: 'Julie’s pottery night' });
    idea(c, { title: 'Dismissed thing', status: 'dismissed' });
    require('../../avoid').addAvoid(me.id, knows(me, julie));
    const p = ideafeed.page(me.id);
    const titles = p.items.filter((i) => i.type === 'idea').map((i) => i.title);
    assert.deepEqual(titles, ['Jazz at Shea’s with Kim?', 'Bluegrass Saturday', 'Trivia night at the Pub']);
    const blue = p.items.find((i) => i.title === 'Bluegrass Saturday');
    assert.equal(blue.liked_by, 2);
    assert.ok(blue.id.startsWith('pool:') && blue.around);
    assert.ok(!JSON.stringify(p).includes('Bo?') && !JSON.stringify(p).includes('Ann'), 'public titles only');
  });
  test('a page at a time: the page sends what it showed; when it runs out it can ask for more', () => {
    const me = mkUser('Sean P'); const o = mkUser('Other P');
    for (let i = 0; i < 14; i++) idea(o, { title: `Thing ${i}` });
    const p1 = ideafeed.page(me.id);
    assert.equal(p1.items.length, ideafeed.PAGE);
    assert.equal(p1.done, false);
    const p2 = ideafeed.page(me.id, { seen: p1.items.map((i) => i.id) });
    assert.ok(p2.items.every((i) => !p1.items.some((x) => x.id === i.id)));
    assert.equal(p2.done, true);
    assert.equal(p2.can_imagine_more, true);
  });
  test('right now, on top: friends out near you (named), what people around you are out for, friends\' shares', async () => {
    const me = mkUser('Sean N'); const kim = mkUser('Kim N');
    knows(me, kim); knows(kim, me);
    const out = require('../../outnow');
    out.goOut(me.id, { up_for: ['skiing'], lat: 39.33, lng: -120.18 });
    out.goOut(kim.id, { up_for: ['snowboarding'], lat: 39.331, lng: -120.18 });
    require('../../feeling').sharePlan(kim.id, { text: 'Free tonight', until: 'tonight' });
    const items = ideafeed.page(me.id).items;
    assert.equal(items[0].type, 'friend_out');
    assert.match(items[0].title, /^Kim is out/);
    assert.ok(items.some((i) => i.type === 'around' && i.chips.includes('⛷️ snowboarding')));
    assert.ok(items.some((i) => i.type === 'share' && i.title === 'Kim: Free tonight'));
    assert.ok(!ideafeed.page(me.id, { seen: ['x'] }).items.some((i) => i.type !== 'idea'), 'right now only on the first page');
  });
  test('✨ Sounds nice on an idea found around you makes it yours and passes it on; ✕ hides it', async () => {
    const me = mkUser('Sean S'); const o = mkUser('Other S'); const friend = mkUser('Friend S');
    knows(me, friend); knows(friend, me);
    const oid = idea(o, { title: 'Sunset paddle Friday' });
    const c = await cookieFor(me);
    const r = await request.post('/api/spells/' + encodeURIComponent(`pool:${oid}`)).set('Cookie', c).send({ answer: 'wish' });
    assert.equal(r.status, 200);
    assert.equal(r.body.passed_on, 1);
    assert.ok(db._raw().prepare("SELECT 1 FROM wishes WHERE user_id = ? AND text = 'Sunset paddle Friday'").get(me.id));
    assert.equal(spells.forUser(friend.id)[0].title, 'Sunset paddle Friday');
    assert.ok(!ideafeed.page(me.id).items.some((i) => i.title === 'Sunset paddle Friday'), 'answered — gone from your feed');
    const other = idea(o, { title: 'Pottery wheel class', kind: 'new' });
    await request.post('/api/spells/' + encodeURIComponent(`pool:${other}`)).set('Cookie', c).send({ answer: 'dismiss' });
    assert.ok(!ideafeed.page(me.id).items.some((i) => i.title === 'Pottery wheel class'));
    const elsewhere = idea(mkUser('Far S', 'Boston'), { title: 'Boston thing' });
    assert.equal((await request.post('/api/spells/' + encodeURIComponent(`pool:${elsewhere}`)).set('Cookie', c).send({ answer: 'wish' })).status, 404);
  });
  test('the API and the tab', async () => {
    const me = mkUser('Sean T');
    const c = await cookieFor(me);
    const r = await request.post('/api/ideas').set('Cookie', c).send({ seen: [] });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
    assert.notEqual((await request.post('/api/ideas').send({})).status, 200);
    const page = await request.get('/app/explore').set('Cookie', c);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('IntersectionObserver') && page.text.includes("fetch('/api/spells/more'") && page.text.includes('<a href="/app/explore" class="active">'));
    assert.equal((await request.get('/app/feed').set('Cookie', c)).headers.location, '/app/explore', 'its first name still works');
  });

  // 🐛 #39 (Sean, 2026-10-20): "We need to have an image there sort of like an Instagram feed … just copy
  // that except for the sounds nice and make it a plan. Speaking of sounds nice. Is a little bit passive
  // aggressive? … Sounds fun" — and the tab is named Explore.
  test('🐛 #39: Instagram-style posts — a picture (the page\'s share image, or a colored tile), ✨ Sounds fun, Make it a plan, Right now as stories', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/explore.html'), 'utf8');
    assert.ok(html.includes('class="post"') && html.includes('aspect-ratio: 1 / 1') && html.includes('class="tile g-'));
    assert.ok(html.includes('✨ Sounds fun') && !html.includes('Sounds nice'));
    assert.ok(html.includes('class="stories"') && html.includes('function openStory'));
    assert.ok(html.includes('referrerpolicy="no-referrer"'), 'the site never learns which page loaded its picture');
    for (const f of ['dashboard.html', 'explore.html']) assert.ok(!require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app', f), 'utf8').includes('Sounds nice'), f);
  });
  test('🐛 #39: pictures come from the idea\'s link (og:image), looked up once per link, carried to ideas passed on', async () => {
    const og = require('../../ogimage');
    const hits = [];
    og._setLookup(async (h) => [{ address: h === 'evil.test' ? '10.0.0.5' : '93.184.216.34' }]);
    og._setFetch(async (url) => {
      hits.push(url);
      if (url.startsWith('https://short.test')) return { status: 302, ok: false, headers: new Map([['location', 'https://evil.test/x']]) };
      return { status: 200, ok: true, headers: new Map([['content-type', 'text/html']]), text: async () => '<html><head><meta property="og:image" content="/img/jazz.jpg"></head>' };
    });
    const me = mkUser('Sean I'); const friend = mkUser('Friend I');
    knows(me, friend); knows(friend, me);
    const id1 = idea(me, { title: 'Jazz at Shea’s' }); idea(me, { title: 'Jazz again', pub: 'Jazz again' });
    db._raw().prepare("UPDATE spells SET link = 'https://example.com/jazz' WHERE user_id = ?").run(me.id);
    await spells.fillImages({ limit: 500 });   // earlier tests' ideas are in the queue too
    assert.equal(hits.filter((h) => h === 'https://example.com/jazz').length, 1, 'once per link');
    assert.equal(spells.forUser(me.id)[0].image, 'https://example.com/img/jazz.jpg');
    spells.answer(me.id, id1, 'wish');
    assert.equal(spells.forUser(friend.id)[0].image, 'https://example.com/img/jazz.jpg', 'passed on with its picture');
    // Never a private address — not directly, not by a redirect.
    assert.equal(await og.find('https://evil.test/'), null);
    assert.equal(await og.find('https://short.test/abc'), null);
    assert.equal(await og.find('http://127.0.0.1/'), null);
    assert.equal(await og.find('http://[::1]/'), null);
    assert.equal(await og.find('file:///etc/passwd'), null);
    assert.equal(await og.find('https://example.com:8080/'), null);
    assert.equal(og.pick('<meta content="http://x.com/a.png" property="og:image">', new URL('https://x.com')), 'https://x.com/a.png', 'http pictures asked for over https');
    assert.equal(og.pick('<meta name="twitter:image" content="javascript:alert(1)">', new URL('https://x.com')), null);
    og._setFetch(null);
  });

  // 🐛 #43 (Sean, 2026-10-20): "Is it possible to have a map view of the explorer so I can know where these
  // things are? And then the color of the pins is how far away they are. So green would be for right now
  // and purple. Certainly not red would be for further in the future".
  test('🐛 #43: a map of Explore — ideas with a place are pinned (looked up once per place), green today → purple later', async () => {
    const geo = require('../../geocode');
    const asked = [];
    geo._setFetch(async (url) => { asked.push(decodeURIComponent(url)); return { ok: true, json: async () => [{ lat: '39.527', lon: '-119.813' }] }; });
    const me = mkUser('Sean Map', 'Reno'); const o = mkUser('Other Map', 'Reno');
    const a = idea(me, { title: 'Bluegrass at Cargo' }); idea(o, { title: 'Comedy at Cargo' });
    db._raw().prepare("UPDATE spells SET place = 'Cargo Concert Hall', date = ? WHERE id = ?").run(new Date().toISOString().slice(0, 10), a);
    db._raw().prepare("UPDATE spells SET place = 'Cargo Concert Hall' WHERE title = 'Comedy at Cargo'").run();
    idea(me, { title: 'No place idea' });
    await spells.fillImages({ limit: 500 });
    assert.equal(asked.filter((u) => u.includes('Cargo Concert Hall, Reno')).length, 1, 'once per place; only the place and town are sent');
    const m = ideafeed.map(me.id);
    assert.deepEqual(m.pins.map((p) => p.title).sort(), ['Bluegrass at Cargo', 'Comedy at Cargo']);
    assert.ok(m.pins.every((p) => p.lat === 39.527 && p.lng === -119.813));
    geo._setFetch(null);
    const c = await cookieFor(me);
    assert.equal((await request.get('/api/ideas/map').set('Cookie', c)).body.pins.length, 2);
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/explore.html'), 'utf8');
    assert.ok(html.includes("showView('map')") && html.includes('leaflet') && html.includes('[0x34, 0xc7, 0x59], b = [0x6c, 0x47, 0xff]'), 'green → purple, never red');
    assert.ok(html.includes('Found in a web search'), '🐛 #41: each post says where it came from');
  });

  // 🐛 #42 (Sean, 2026-10-20): "If I open a website through butterfly … can I have that overlay so that way
  // as I go through the website I can make a comment … what's interesting and what's not. And that becomes
  // a part of my personal preferences which is a social share of sorts that affects the network". An app
  // can't draw over another website, so: back from the page, "what did you think?".
  test('🐛 #42: back from a page — into it (kept, passed on), not for me (hidden), and a note that shapes your next ideas and reaches no one', async () => {
    const me = mkUser('Sean R'); const friend = mkUser('Friend R'); const o = mkUser('Other R');
    knows(me, friend); knows(friend, me);
    const a = idea(me, { title: 'Comedy night at the Laugh Factory' });
    const b = idea(me, { title: 'Pottery wheel taster' });
    const pooled = idea(o, { title: 'Swing dance lesson' });
    const c = await cookieFor(me);
    let r = await request.post(`/api/spells/${a}/react`).set('Cookie', c).send({ verdict: 'into', note: 'love the late show, not the early one' });
    assert.equal(r.status, 200);
    assert.equal(r.body.passed_on, 1, 'into it spreads like ✨ Sounds fun');
    assert.ok(!JSON.stringify(spells.forUser(friend.id)).includes('late show'), 'the note never goes anywhere');
    r = await request.post(`/api/spells/${b}/react`).set('Cookie', c).send({ verdict: 'no', note: 'too messy' });
    assert.equal(db._raw().prepare('SELECT status FROM spells WHERE id = ?').get(b).status, 'dismissed');
    r = await request.post('/api/spells/' + encodeURIComponent(`pool:${pooled}`) + '/react').set('Cookie', c).send({ verdict: 'meh', note: 'maybe with lessons first' });
    assert.equal(r.status, 200);
    assert.equal((await request.post(`/api/spells/${a}/react`).set('Cookie', c).send({})).status, 400);
    const seen = [];
    spells._setClient({ messages: { create: async (req) => { seen.push(req); return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"spells":[]}' }] }; } } });
    await spells.generate(me, { force: true });
    const prompt = seen[0].messages[0].content;
    assert.match(prompt, /What they said about ideas they looked at \(their taste — follow it\): /);
    assert.match(prompt, /"Comedy night at the Laugh Factory" \(into it\): love the late show/);
    assert.match(prompt, /"Pottery wheel taster" \(not for them\): too messy/);
    assert.match(prompt, /"Swing dance lesson": maybe with lessons first/);
    // The "back from the page" sheet became a comment bar on the page itself (/app/view, same day — Sean:
    // going back to say something is "unnecessary friction that will lose people").
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/explore.html'), 'utf8');
    assert.ok(html.includes('href="/app/view?id=${encodeURIComponent(i.id)}"') && !html.includes('function askAboutVisit'));
  });

  // Sean, 2026-10-20: "it's a real bummer that when I open a website in the app, there's no way for me to edit
  // over it somehow or comment on it somehow while I'm looking at it … if I have to do this separate step of
  // going back and saying something … I'm creating unnecessary friction that will lose people."
  test('a page opens inside ButterflAI with a comment bar: the site itself when it allows it, else its preview', async () => {
    const og = require('../../ogimage');
    og._setLookup(async () => [{ address: '93.184.216.34' }]);
    og._setFetch(async (url) => ({ status: 200, ok: true,
      headers: new Map([['content-type', 'text/html'], ...(url.includes('blocks') ? [['x-frame-options', 'SAMEORIGIN']] : url.includes('csp') ? [['content-security-policy', "default-src 'self'; frame-ancestors 'self'"]] : [])]),
      text: async () => '<head><meta property="og:image" content="https://img.test/a.jpg"><meta name="description" content="Live music six nights a week"></head>' }));
    const me = mkUser('Sean W'); const o = mkUser('Other W');
    const ok = idea(me, { title: 'Open site' }), blocks = idea(me, { title: 'Blocking site' }), csp = idea(me, { title: 'CSP site' }), pooled = idea(o, { title: 'Pooled site' });
    for (const [id, link] of [[ok, 'https://open.test/e'], [blocks, 'https://blocks.test/e'], [csp, 'https://csp.test/e'], [pooled, 'https://open.test/p']]) db._raw().prepare('UPDATE spells SET link = ?, image_checked = 0 WHERE id = ?').run(link, id);
    await spells.fillImages({ limit: 500 });
    og._setFetch(null);
    const c = await cookieFor(me);
    const page = async (id) => (await request.get('/api/spells/' + encodeURIComponent(id) + '/page').set('Cookie', c)).body;
    assert.equal((await page(ok)).frameable, true);
    const b = await page(blocks);
    assert.equal(b.frameable, false);
    assert.equal(b.description, 'Live music six nights a week');
    assert.equal(b.site, 'blocks.test');
    assert.equal((await page(csp)).frameable, false, "CSP frame-ancestors 'self' refuses");
    assert.equal((await page(`pool:${pooled}`)).title, 'Pooled site', 'one found around you too');
    assert.equal((await request.get(`/api/spells/${idea(o, { title: 'Not mine' })}/page`).set('Cookie', c)).status, 404, 'someone else\'s own idea: no');
    // Comments while looking add up; a verdict from the bar.
    await request.post(`/api/spells/${ok}/react`).set('Cookie', c).send({ note: 'love the patio' });
    await request.post(`/api/spells/${ok}/react`).set('Cookie', c).send({ note: 'too pricey though' });
    assert.equal(db._raw().prepare('SELECT note FROM spells WHERE id = ?').get(ok).note, 'love the patio · too pricey though');
    const view = await request.get('/app/view?id=' + ok).set('Cookie', c);
    assert.equal(view.status, 200);
    assert.ok(view.text.includes('<iframe') && view.text.includes('referrerpolicy="no-referrer"') && view.text.includes('id="verdicts"') && view.text.includes('What do you think?') && view.text.includes('Only you and your ButterflAI see what you say'));
  });
});
