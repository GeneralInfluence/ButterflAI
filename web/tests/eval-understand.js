/**
 * eval-understand.js — REAL model check of understand.js (nightly eval, ~1¢ a run).
 *
 * Each case is a message someone really sent (or close to it), where they were, and what it
 * should be read as. Passes when every expected action gets the expected decision (apply /
 * agent / ask) and nothing is applied that shouldn't be. Corrections people make in the app
 * (/api/admin/understood) become new cases here.
 */
'use strict';

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'eval';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
delete process.env.TWILIO_ACCOUNT_SID;

const { v4: uuidv4 } = require('uuid');
const sms = require('../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
require('../server');
const db = require('../db');
const planops = require('../planops');
const understand = require('../understand');
const agent = require('../agent');

let n = 0;
function mkUser(name) {
  const phone = `+1202545${String(1000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  return db.getUserByPhone(phone);
}
const knows = (o, u) => db.upsertContact({ invited_by_user_id: o.id, name: u.name, phone: u.phone, tier: 1 });
const nextFriday = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7) + 7); return d.toISOString().slice(0, 10); };
const plusDay = (s, k = 1) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };

async function world() {
  const fri = nextFriday();
  const sean = mkUser('Sean Gonzalez'), mel = mkUser('Melanie Noel'), bam = mkUser('Bam Bam');
  const ids = [mel, bam].map((u) => knows(sean, u));
  const weekend = (await planops.create(sean.id, { title: "Melanie's Birthday Weekend", venue_name: 'Carson City Hot Springs', proposed_dates: [{ from: fri, to: plusDay(fri) }], contact_ids: ids })).eventId;
  const liam = (await planops.create(sean.id, { title: "Liam's Birthday Party", proposed_dates: [{ from: plusDay(fri, 2), to: plusDay(fri, 2) }], contact_ids: ids })).eventId;
  const dinner = (await planops.create(sean.id, { title: 'Dinner at Sully\'s', scheduled_at: `${plusDay(fri, -2)}T19:00:00-07:00`, tentative: true, contact_ids: ids })).eventId;
  const massages = (await planops.create(mel.id, { title: 'Massages', proposed_dates: [{ from: fri, to: fri }], contact_ids: [knows(mel, sean)] })).eventId;
  return { fri, sean, mel, bam, weekend, liam, dinner, massages };
}

// who, where (plan key or null), day, text, expect: [{kind, decision}], never: kinds that must not be applied
const CASES = [
  { who: 'mel', where: 'weekend', day: 'fri', text: 'thinking about getting a massage', expect: [{ kind: 'add_todo', decision: 'apply' }] },
  { who: 'mel', where: 'massages', text: 'can you find massage places near Carson City for Friday?', expect: [{ kind: 'find_options', decision: 'agent' }], never: ['add_todo', 'set_details'] },
  { who: 'mel', where: 'massages', text: 'what are some good spas around there', expect: [{ kind: 'find_options', decision: 'agent' }] },
  // 🐛 #19, her exact words (after "massages on Friday while the kids are at school" and Sean's agent saying Friday works)
  { who: 'mel', where: 'massages', text: 'where should we get massages?', expect: [{ kind: 'find_options', decision: 'agent' }], never: ['add_todo', 'set_details'] },
  { who: 'bam', where: 'weekend', text: "count me in, I'll be there", expect: [{ kind: 'rsvp', decision: 'apply', answer: 'going' }] },
  { who: 'bam', where: 'liam', text: "sounds fun, I'm interested but not sure yet", expect: [{ kind: 'rsvp', answer: 'interested' }] },
  { who: 'mel', where: 'weekend', text: 'how much is a cabin? probably need to reschedule', expect: [], never: ['set_details', 'rsvp', 'cancel'] },
  { who: 'sean', where: 'liam', text: "noon till closing, but the kids won't last more than 3 hours", expect: [{ kind: 'set_details', decision: 'apply' }], notOn: 'weekend' },
  { who: 'sean', where: 'dinner', text: 'lock it in', expect: [{ kind: 'lock_in', decision: 'apply' }] },
  { who: 'sean', where: null, text: 'thanks!', expect: [], never: ['add_todo', 'rsvp', 'set_details', 'lock_in'] },
  { who: 'mel', where: 'weekend', text: 'can you ask Bam Bam if he can drive?', expect: [{ kind: 'message', decision: 'agent' }] },
];

async function once(c, w) {
  const u = w[c.who];
  const eventId = c.where ? w[c.where] : null;
  const contextDay = c.day === 'fri' ? w.fri : null;
  const ctx = understand.contextFor(u.id, { eventId, contextDay });
  const raw = await understand.extract({ userText: c.text, context: ctx.text, today: new Date().toISOString().slice(0, 10) });
  const got = understand.decide(raw, { userId: u.id, userText: c.text, eventId, plans: ctx.plans, isNamed: agent.planNamedIn });
  const problems = [];
  for (const e of c.expect) {
    const hit = got.find((g) => g.kind === e.kind && (!e.decision || g.decision === e.decision) && (!e.answer || g.answer === e.answer));
    if (!hit) problems.push(`expected ${e.kind}${e.answer ? ' ' + e.answer : ''}${e.decision ? ' → ' + e.decision : ''}`);
  }
  for (const k of c.never || []) if (got.some((g) => g.kind === k && g.decision === 'apply')) problems.push(`applied ${k}`);
  if (c.notOn && got.some((g) => g.event_id === w[c.notOn] && g.decision === 'apply')) problems.push(`changed ${c.notOn}`);
  return { ok: !problems.length, problems, got: got.map((g) => `${g.kind}${g.answer ? ':' + g.answer : ''}→${g.decision}${g.why ? ` (${g.why})` : ''}`) };
}

(async () => {
  const runs = Number(process.env.EVAL_RUNS || 2);
  console.log(`\n🦋 Eval: understanding messages (${CASES.length} cases × ${runs}, real model)\n`);
  const w = await world();
  let pass = 0, total = 0;
  for (const c of CASES) {
    for (let r = 0; r < runs; r++) {
      total++;
      let out;
      try { out = await once(c, w); } catch (err) { out = { ok: false, problems: [err.message], got: [] }; }
      if (out.ok) pass++;
      console.log(`  ${out.ok ? '✅' : '❌'} ${c.who}: "${c.text}" → ${out.got.join(', ') || 'nothing'}${out.ok ? '' : `  [${out.problems.join('; ')}]`}`);
    }
  }
  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
})();
