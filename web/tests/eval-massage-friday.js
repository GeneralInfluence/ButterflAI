/**
 * eval-massage-friday.js — REAL model check (nightly eval, costs a few cents).
 *
 * Owner, 2026-10-13: "the tests should ensure the massage is on Friday." The integration
 * tests prove the plumbing with a scripted model; this proves the real agent does it.
 * Melanie (invited to her birthday weekend, Fri–Sat) taps Friday on the calendar, opens the
 * plan's discussion and writes "thinking about getting a massage". Pass when:
 *   - a massage item is on the plan's Creating list, on Friday (not Saturday)
 *   - the reply doesn't ask whether it's a solo thing
 * Runs against an in-memory database; needs Anthropic credentials (key or OIDC).
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
const agent = require('../agent');
const planops = require('../planops');
const todos = require('../todos');

if (process.env.EVAL_DEBUG) require(process.env.EVAL_DEBUG);   // prints each model call (local debugging)
const RUNS = Number(process.env.EVAL_RUNS || 5);

function mkUser(name, phone) {
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const nextFriday = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7) + 7); return d.toISOString().slice(0, 10); };
const plusDay = (s) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

async function once(i) {
  const fri = nextFriday(), sat = plusDay(fri);
  const sean = mkUser('Sean Gonzalez', `+1202546${String(1000 + i * 2).padStart(4, '0')}`);
  const mel = mkUser('Melanie Noel', `+1202546${String(1001 + i * 2).padStart(4, '0')}`);
  const r = await planops.create(sean.id, { title: "Melanie's Birthday Weekend", activity_type: 'birthday', venue_name: 'Carson City Hot Springs',
    proposed_dates: [{ from: fri, to: sat }], contact_ids: [db.upsertContact({ invited_by_user_id: sean.id, name: mel.name, phone: mel.phone, tier: 1 })] });
  db._raw().prepare('DELETE FROM inbound_messages').run();
  db.storeInboundMessage({ from_phone: mel.phone, from_type: 'user', from_id: mel.id, channel: 'webchat', text: 'thinking about getting a massage', event_id: r.eventId, context_day: fri });
  await agent.tick();
  const reply = db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND role = 'assistant' ORDER BY rowid DESC").get(mel.id)?.text || '';
  const items = todos.list(mel.id, r.eventId).todos || [];
  const massage = items.find((t) => /massage/i.test(t.text));
  const problems = [];
  if (!massage) problems.push(`no massage on Creating (items: ${JSON.stringify(items.map((t) => t.shown))})`);
  else if (massage.day !== fri) problems.push(`massage is on ${massage.day || 'no day'}, not Friday ${fri}`);
  if (/\bsolo\b|by yourself|on your own|just you\b/i.test(reply)) problems.push(`asked if it's solo: "${reply.slice(0, 160)}"`);
  return { ok: !problems.length, problems, reply: reply.slice(0, 200), item: massage?.shown };
}

(async () => {
  console.log(`\n🦋 Eval: Melanie's Friday massage (${RUNS} runs, real model)\n`);
  let pass = 0;
  for (let i = 0; i < RUNS; i++) {
    let out;
    try { out = await once(i); } catch (err) { out = { ok: false, problems: [err.message] }; }
    console.log(`  ${out.ok ? '✅' : '❌'} run ${i + 1}: ${out.ok ? out.item : out.problems.join('; ')}${out.reply ? `\n     reply: ${out.reply.replace(/\s+/g, ' ')}` : ''}`);
    if (out.ok) pass++;
  }
  console.log(`\n${pass}/${RUNS} passed`);
  process.exit(pass === RUNS ? 0 : 1);
})();
