/**
 * lookup-circle.test.js — Sean, 2026-10-19: "I said Allie and Alex from my favorite Mama's
 * group and it was able to find Allie, but it's having trouble with Alex." Alex is Alexandria
 * Spargo, in that group; 15 other Alexes (one named exactly "Alex") outranked her.
 * Also: "the weekend of the 30th … Saturday, October 30 evening" was saved as Saturday Oct 24.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'lookup-circle-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
require('../../server');
const db = require('../../db');
const agent = require('../../agent');
const planops = require('../../planops');
const datetime = require('../../datetime');

let n = 0;
function mkUser(name) {
  const phone = `+1202542${String(6000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
const contact = (owner, name, phone) => db.upsertContact({ invited_by_user_id: owner.id, name, phone, tier: 1 });
function seanWithAlexes() {
  const sean = mkUser('Sean L');
  const ids = {};
  ['Alex', 'Gonzalez Alex', 'Lasser Alex', 'Alex Korenshteyn', 'Alex Godwin', 'Alex Engler', 'Alexander Priest'].forEach((nm, i) => { ids[nm] = contact(sean, nm, `+1617555${String(1000 + i)}`); });
  ids.spargo = contact(sean, 'Alexandria Spargo', '+13105550001');
  db._raw().prepare("UPDATE contacts SET also_known_as = 'Alex Spargo' WHERE id = ?").run(ids.spargo);
  ids.allie = contact(sean, 'Allie', '+15705550002');
  ids.mel = contact(sean, 'Melanie Noel', '+17755550003');
  const g = db.upsertContactGroup(sean.id, "Favorite Mama's");
  const gid = typeof g === 'string' ? g : g?.id || db.getContactGroups(sean.id)[0].id;
  for (const c of [ids.spargo, ids.allie, ids.mel]) db.addContactToGroup(gid, c);
  return { sean, ids };
}
// Runs one turn where the model calls lookup_contact; returns what the tool returned.
async function turn(u, input, extra) {
  let out = null;
  agent._setAnthropic({ messages: { create: async (req) => {
    const last = req.messages.at(-1);
    const tr = Array.isArray(last.content) && last.content.find((b) => b.type === 'tool_result');
    if (tr) { out = JSON.parse(tr.content); return { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }; }
    return { id: 'a', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'lookup_contact', input }] };
  } } });
  db.storeInboundMessage({ from_phone: u.phone, from_type: 'user', from_id: u.id, channel: 'webchat', ...extra });
  await agent.tick();
  return out;
}
const lookup = (u, query, context, text) => turn(u, { query, context }, { text });

describe('"Alex from my Favorite Mama\'s group"', () => {
  test('the group decides: Alexandria Spargo, no question', async () => {
    const { sean, ids } = seanWithAlexes();
    const r = await lookup(sean, 'Alex', "Favorite Mama's group", "Allie and Alex from my favorite Mama's group");
    assert.equal(r.contacts[0].id, ids.spargo);
    assert.equal(r.exact_match, true);
    assert.match(r.contacts[0].why, /in your Favorite Mama's group/);
  });
  test('the plan being discussed decides too', async () => {
    const { sean, ids } = seanWithAlexes();
    const e = (await planops.create(sean.id, { title: 'Rocky Horror', contact_ids: [ids.spargo, ids.allie] })).eventId;
    db._raw().prepare('DELETE FROM inbound_messages').run();
    const out = await turn(sean, { query: 'Alex' }, { text: 'is Alex still coming?', event_id: e });
    assert.equal(out.contacts[0].id, ids.spargo);
    assert.equal(out.exact_match, true);
  });
  test('no group or plan named: still asks which Alex', async () => {
    const { sean } = seanWithAlexes();
    const r = await lookup(sean, 'Alex', 'Rocky Horror', 'Alex is coming to Rocky Horror');
    assert.equal(r.exact_match, false);
  });
  test('two people in the group fit: asks, saying why', async () => {
    const { sean, ids } = seanWithAlexes();
    const gid = db.getContactGroups(sean.id)[0].id;
    db.addContactToGroup(gid, ids['Alex Godwin']);
    const r = await lookup(sean, 'Alex', "Favorite Mama's", "Alex from Favorite Mama's");
    assert.equal(r.exact_match, false);
    assert.deepEqual(new Set(r.contacts.slice(0, 2).map((c) => c.id)), new Set([ids.spargo, ids['Alex Godwin']]));
  });
});

describe('a named date beats a weekday', () => {
  const now = new Date('2026-10-19T23:06:00Z');
  for (const [said, want] of [['Saturday, October 30 evening', 'Friday, Oct 30, 7:00 PM'], ['the weekend of the 30th at 8pm', 'Friday, Oct 30, 8:00 PM'],
    ['Oct 30th at 7pm', 'Friday, Oct 30, 7:00 PM'], ['30 October 7pm', 'Friday, Oct 30, 7:00 PM'], ['10/30 at 7pm', 'Friday, Oct 30, 7:00 PM'],
    ['January 3 at noon', 'Sunday, Jan 3, 12:00 PM'], ['friday 7pm', 'Friday, Oct 23, 7:00 PM']]) {
    test(`"${said}" → ${want}`, () => assert.equal(datetime.resolveEventDateTime(said, 'America/Los_Angeles', now).label, want));
  }
});

describe('retro: Sean\'s Rocky Horror plan', () => {
  const task = (id) => require('../../retro').TASKS.find((t) => t.id === id);
  test('moved off Saturday Oct 24 to the weekend of the 30th; Allie and Alexandria offered', async () => {
    const { sean, ids } = seanWithAlexes();
    const e = (await planops.create(sean.id, { title: 'Rocky Horror Picture Show', scheduled_at: new Date(Date.UTC(2026, 9, 25, 2)).toISOString(), tentative: true })).eventId;
    assert.equal(task('2026-10-19-rocky-horror-on-the-30th').run(sean), 'moved to the weekend of the 30th');
    assert.equal(db._raw().prepare('SELECT proposed_dates FROM social_events WHERE id = ?').get(e).proposed_dates, '[{"from":"2026-10-30","to":"2026-11-01"}]');
    assert.equal(task('2026-10-19-rocky-horror-on-the-30th').run(sean), 'not found as saved', 'only once, only as found');
    assert.equal(await task('2026-10-19-rocky-horror-alex').run(sean), 'offered (2)');
    const said = db._raw().prepare("SELECT text, event_id FROM conversation_history WHERE user_id = ? AND role = 'assistant' ORDER BY rowid DESC").get(sean.id);
    assert.match(said.text, /"Alex from Favorite Mama's" is Alexandria Spargo .* add Alexandria and Allie|add Allie and Alexandria/);
    assert.equal(said.event_id, e);
    assert.ok(ids);
  });
});
