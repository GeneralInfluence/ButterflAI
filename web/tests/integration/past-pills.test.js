/**
 * past-pills.test.js — 🐛 #92 (Sean, 2026-10-24): "How do I remove this past event from the pills at the top? I hit x,
 * it's still there … I'd like to have the things that are in the past kind of automatically not be my future plans when
 * I'm looking in the plans tab." Past plans drop out of the pills on Chat, Creating and Events; they're behind one
 * "🕘 Past" pill; the past plan you're looking at keeps its pill.
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../../public/plan-nav.js'), 'utf8');
function nav(stored = null) {
  const store = new Map(stored ? [['bfly-pills-past', stored]] : []);
  const ctx = { window: {}, localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, location: { reload() {} }, document: {} };
  vm.runInNewContext(src, ctx);
  return ctx.window.PlanNav;
}
const D = [
  { event_id: 'pm', title: 'Practical Magic', stage: 'past' },
  { event_id: 'lunch', title: 'Lunch with Allie', stage: 'past' },
  { event_id: 'liam', title: "Liam's Birthday Party", stage: 'confirmed' },
  { event_id: 'paper', title: 'Request for Possession document work', stage: 'confirmed' },
];

describe('🐛 #92: past plans leave the pills by themselves', () => {
  test('only what\'s ahead shows, plus "🕘 Past · 2"', () => {
    const v = nav().visible(D, null);
    assert.deepEqual(v.shown.map((d) => d.event_id), ['liam', 'paper']);
    assert.match(nav().pastPill(v.past), /🕘 Past · 2/);
  });
  test('the past plan you\'re looking at keeps its pill', () => {
    const v = nav().visible(D, 'pm');
    assert.deepEqual(v.shown.map((d) => d.event_id), ['pm', 'liam', 'paper']);
    assert.match(nav().pastPill(v.past), /🕘 Past · 1/);
  });
  test('"🕘 Past" shows them all again (faded), and "Hide past" tucks them away', () => {
    const v = nav('1').visible(D, null);
    assert.equal(v.shown.length, 4);
    assert.match(nav('1').pastPill(v.past), /Hide past/);
    assert.match(nav('1').pillHtml('chat', D[0], null), /class="tpill past"[\s\S]*🕘 Practical Magic/);
  });
  test('Chat uses the same rule as Creating and Events', () => {
    const chat = fs.readFileSync(path.join(__dirname, '../../public/app/chat.html'), 'utf8');
    assert.match(chat, /PlanNav\.visible\(discussions, topicEvent\)/);
    assert.match(chat, /PlanNav\.pastPill\(v\.past\)/);
  });
});
