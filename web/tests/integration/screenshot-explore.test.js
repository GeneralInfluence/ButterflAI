/**
 * screenshot-explore.test.js — 🐛 #83 / #85 (Sean, 2026-10-21). He shared an Instagram list of Reno events ("I want you to
 * find all of these events in this image"); his agent made 6 plans. "None of them should stay … they were supposed to be
 * added to the exploration opportunities" → it saved 16 wishes and left the 6 plans (#85: "Why do I still see all the
 * events from that screenshot?"). And: "in the explore tab, give my screenshot, which is more intuitive."
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'shot-explore-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
require('../../server');
const db = require('../../db');
const agent = require('../../agent');
const retro = require('../../retro');

let n = 0;
function mkUser(name) {
  const phone = `+1202537${String(1000 + n++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone, city, created_at) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', 'Reno', 1700000000)").run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
const SHOT = `I want you to find all of these events in this image this is from a tick a tiktok account

[What was on my screen]
- App: Instagram
- Where: Reno, Nevada
- Plans: Reno Events, November 2026:
  - Nov 1 – Sierra Nevada Ballet: Dracula
  - Nov 1 – 38 Special Concert
  - Nov 5 – Rival Sons Concert`;

async function turn(user, text, calls) {
  db._raw().prepare('UPDATE inbound_messages SET processed = 1').run();
  db.storeInboundMessage({ from_phone: user.phone, from_type: 'user', from_id: user.id, channel: 'webchat', text });
  const results = [];
  let k = 0;
  agent._setAnthropic({ messages: { create: async (req) => {
    const last = req.messages.at(-1);
    if (Array.isArray(last.content)) for (const b of last.content) if (b.type === 'tool_result') results.push(String(b.content));
    const c = calls[k++];
    return c ? { id: 'm' + k, stop_reason: 'tool_use', content: c.map((x, i) => ({ type: 'tool_use', id: `t${k}_${i}`, name: x[0], input: x[1] })) }
      : { id: 'e' + k, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] };
  } } });
  await agent.tick();
  return results.join('\n');
}
const openPlans = (u) => db._raw().prepare("SELECT title FROM social_events WHERE host_user_id = ? AND COALESCE(status, 'open') = 'open'").all(u.id).map((r) => r.title);

describe('🐛 #83: a screenshot of things to do goes to Explore, not plans', () => {
  test('Sean\'s exact message: a plan per event is refused and pointed to add_to_explore', async () => {
    const sean = mkUser('Sean S');
    const r = await turn(sean, SHOT, [[['create_social_event', { title: 'Sierra Nevada Ballet: Dracula', activity_type: 'ballet', when: 'November 1', tentative: true }]]]);
    assert.match(r, /FOR_EXPLORE/);
    assert.match(r, /add_to_explore/);
    assert.deepEqual(openPlans(sean), []);
  });
  test('their own words asking to plan it still make a plan', async () => {
    const sean = mkUser('Sean P');
    await turn(sean, SHOT.replace('I want you to find all of these events in this image', 'let\'s go to the ballet one, make it a plan'), [[['create_social_event', { title: 'Sierra Nevada Ballet: Dracula', activity_type: 'ballet', when: 'November 1', tentative: true }]]]);
    assert.deepEqual(openPlans(sean), ['Sierra Nevada Ballet: Dracula']);
  });
  test('"exploration opportunities" are not wishes; add_to_explore makes an Explore search and cancels the plans made by mistake (#85)', async () => {
    const sean = mkUser('Sean E');
    const planops = require('../../planops');
    const a = await planops.create(sean.id, { title: 'Rival Sons Concert', activity_type: 'concert', when: 'November 5', tentative: true }, { via: 'agent' });
    const b = await planops.create(sean.id, { title: '38 Special Concert', activity_type: 'concert', when: 'November 1', tentative: true }, { via: 'agent' });
    const r = await turn(sean, 'none of them should stay they were supposed to be added to the exploration opportunities', [
      [['manage_wishes', { action: 'add', text: 'Rival Sons Concert' }]],
      [['add_to_explore', { text: 'Reno, November: Rival Sons (Nov 5); 38 Special (Nov 1)', instead_of_plan_ids: [a.eventId] }]],
    ]);
    assert.match(r, /FOR_EXPLORE/, 'wishes refused');
    assert.equal(db._raw().prepare('SELECT count(*) n FROM wishes WHERE user_id = ?').get(sean.id).n, 0);
    assert.equal(db._raw().prepare('SELECT count(*) n FROM explore_asks WHERE user_id = ?').get(sean.id).n, 1, 'a search on Explore');
    assert.match(db._raw().prepare('SELECT text FROM explore_asks WHERE user_id = ?').get(sean.id).text, /^From a screenshot they shared: .*Rival Sons/);
    assert.deepEqual(openPlans(sean), ['38 Special Concert'], 'the plan passed in is cancelled');
    assert.match(r, /still_plans.*38 Special Concert/, 'and the one still standing is pointed out');
    assert.ok(b.eventId);
  });
  test('a plan someone said yes to is never cancelled by add_to_explore', async () => {
    const sean = mkUser('Sean Y'); const al = mkUser('Al Y');
    const cid = db.upsertContact({ invited_by_user_id: sean.id, name: 'Al', phone: al.phone, tier: 1 });
    const planops = require('../../planops');
    const p = await planops.create(sean.id, { title: 'Dragon Lights', activity_type: 'festival', when: 'November 2', tentative: true, contact_ids: [cid] }, { via: 'agent' });
    db._raw().prepare("UPDATE event_invitations SET status = 'accepted' WHERE event_id = ?").run(p.eventId);
    await turn(sean, 'put dragon lights on explore', [[['add_to_explore', { text: 'Dragon Lights Reno', instead_of_plan_ids: [p.eventId] }]]]);
    assert.deepEqual(openPlans(sean), ['Dragon Lights']);
  });
  test('a screenshot\'s search is named by what\'s in it, not "From Screenshot They Shared"', () => {
    const { shortLabel } = require('../../spells');
    assert.equal(shortLabel('From a screenshot they shared: Sierra Nevada Ballet: Dracula; 38 Special Concert'), 'Sierra Nevada Ballet Dracula');
    assert.equal(shortLabel('From a screenshot they shared: - App: Instagram - Where: Reno, Nevada - Plans: Reno Events, November: - Nov 1 – Dracula'), 'Reno Events Dracula');
  });
  test('the rules are in the prompt', () => {
    const p = agent.buildSystemPrompt({ id: 'x', name: 'Sean', phone: '+1' }, '');
    assert.match(p, /SCREENSHOTS OF THINGS TO DO GO TO EXPLORE/);
    assert.match(p, /"none of them should stay" means cancel every one/);
  });
  test('Explore has a clear "Add from a screenshot" button, and a list in a screenshot asks for each listed thing', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../public/app/explore.html'), 'utf8');
    assert.match(html, /id="shot-btn"[\s\S]*Add from a screenshot[\s\S]*onchange="askFromShot\(this\)"/);
    assert.match(html, /What’s in it\?[\s\S]*Things to do — find them[\s\S]*Someone I’m talking to/);
    const sw = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');
    assert.match(sw, /Response\.redirect\('\/app\/explore\?shot=1', 303\)/, 'screenshots shared from other apps land on Explore');
    assert.match(fs.readFileSync(path.join(__dirname, '../../spells.js'), 'utf8'), /make one idea for EACH listed one/);
    assert.match(fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8'), /From a screenshot they shared: \$\{seen/);
  });
});

describe('🐛 #85 retro: the screenshot\'s plans and the wishes made instead are gone; the things are on Explore', () => {
  test('Sean\'s day, replayed', async () => {
    const sean = mkUser('Sean R');
    const t0 = Math.floor(Date.now() / 1000) - 36000;
    db._raw().prepare("INSERT INTO conversation_history (id, user_id, role, text, created_at) VALUES (?, ?, 'user', ?, ?)").run(uuidv4(), sean.id, SHOT, t0);
    for (const title of ['Sierra Nevada Ballet: Dracula', '38 Special Concert', 'Rival Sons Concert']) {
      db._raw().prepare("INSERT INTO social_events (id, host_user_id, title, activity_type, scheduled_at, tentative, created_at) VALUES (?, ?, ?, 'concert', ?, 1, ?)").run(uuidv4(), sean.id, title, t0 + 30 * 86400, t0 + 20);
    }
    db._raw().prepare("INSERT INTO social_events (id, host_user_id, title, activity_type, scheduled_at, created_at) VALUES (?, ?, 'Lunch with Allie', 'meal', ?, ?)").run(uuidv4(), sean.id, t0 + 86400, t0 - 5000);
    const t1 = t0 + 30000;
    db._raw().prepare("INSERT INTO conversation_history (id, user_id, role, text, created_at) VALUES (?, ?, 'user', 'save all of them to exploration opportunities', ?)").run(uuidv4(), sean.id, t1);
    for (const w of ['Fantasies in Chocolate', 'Soft Cell Concert', 'GWAR Concert']) db._raw().prepare("INSERT INTO wishes (id, user_id, text, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(uuidv4(), sean.id, w, t1 + 12, t1 + 86400 * 60);
    const task = retro.TASKS.find((x) => x.id === '2026-10-22-screenshot-plans-to-explore');
    assert.equal(await task.run(sean), 'cancelled 3, removed 3 wishes');
    assert.deepEqual(openPlans(sean), ['Lunch with Allie']);
    assert.equal(db._raw().prepare('SELECT count(*) n FROM wishes WHERE user_id = ?').get(sean.id).n, 0);
    assert.match(db._raw().prepare('SELECT text FROM explore_asks WHERE user_id = ?').get(sean.id).text, /Dracula.*GWAR/);
    assert.match(db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND kind = 'notice'").get(sean.id).text, /3 plans I made from your screenshot are gone/);
  });
});
