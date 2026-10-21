/**
 * short-items.test.js — 🐛 #82 (Sean, 2026-10-21): "You put exactly what I said into the title of the list. You should
 * summarize what I say and then you have the details of what I said after I click on it." The item was named
 * "I need to get the exact paperwork so we can review it together and finish it".
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'short-items-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

require('../../sms')._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
require('../../server');
const db = require('../../db');
const todos = require('../../todos');
const planops = require('../../planops');
const retro = require('../../retro');

const SAID = 'I need to get the exact paperwork so we can review it together and finish it';
function mkUser(name, i) {
  const phone = `+120253900${i}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone, created_at) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles', 1700000000)").run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}

describe('🐛 #82: Creating items have short names; what was said is in the details', () => {
  test('Sean\'s sentence → "Get the exact paperwork", the sentence in its notes', async () => {
    const sean = mkUser('Sean I', 1);
    const p = await planops.create(sean.id, { title: 'Request for Possession document work', activity_type: 'work', when: 'tomorrow' }, { via: 'agent' });
    const r = todos.add(sean.id, p.eventId, { text: SAID });
    assert.equal(r.todo.text, 'Get the exact paperwork');
    assert.equal(db._raw().prepare('SELECT notes FROM event_todos WHERE id = ?').get(r.todo.id).notes, SAID);
  });
  test('short names are left alone; long ones lose "I need to / we should" and what follows "so / because"', () => {
    for (const [said, name] of [['Massage', 'Massage'], ['Massages at Renaissance Hotel', 'Massages at Renaissance Hotel'],
      ['we should bring chairs and a cooler for the kids at the park', 'Bring chairs and a cooler'],
      ['Remind Liam to talk to his friends about the party', 'Remind Liam to talk to his friends about the party']]) assert.equal(todos.shortName(said).name, name, said);
  });
  test('the rule is in the prompt', () => {
    assert.match(require('../../agent').buildSystemPrompt({ id: 'x', name: 'S', phone: '+1' }, ''), /SHORT ITEM NAMES/);
  });
  test('retro: items already named with a whole sentence get a short name, the sentence moves to notes', async () => {
    const sean = mkUser('Sean J', 2);
    const p = await planops.create(sean.id, { title: 'Paperwork J', activity_type: 'work', when: 'tomorrow' }, { via: 'agent' });
    const id = uuidv4();
    db._raw().prepare('INSERT INTO event_todos (id, event_id, text, created_by) VALUES (?, ?, ?, ?)').run(id, p.eventId, SAID, sean.id);
    assert.equal(await retro.TASKS.find((x) => x.id === '2026-10-22-short-item-names').run(sean), 'shortened 1');
    const t = db._raw().prepare('SELECT text, notes FROM event_todos WHERE id = ?').get(id);
    assert.deepEqual([t.text, t.notes], ['Get the exact paperwork', SAID]);
  });
});
