#!/usr/bin/env node
/**
 * ButterflAI multi-agent simulator — a fast local loop for iterating on agent
 * behavior ("training the general user agent") without real SMS or two humans.
 *
 * It runs the SAME code paths production uses — routeInboundSms() for routing and
 * agent.processMessage() for each agent turn — against an isolated in-memory DB
 * seeded with two full users (Aphilos + BamBam), with Twilio stubbed so outbound
 * SMS is captured and printed instead of sent. After each human message it drains
 * the whole inbound queue, so an Aphilos→BamBam cascade (agent→agent coordination,
 * RSVP notifications, etc.) plays out in one shot and is printed as a transcript.
 *
 * Requires real Claude for real agent turns:
 *   ANTHROPIC_API_KEY  — the reasoning key (put it in web/.env; never in argv)
 *   AGENT_MODEL        — a model your Anthropic account has (prod uses this too)
 *
 * Run:   npm run sim        (from web/)   or   node tools/sim.js
 *
 * REPL:
 *   aphilos: invite bambam to dinner friday 7pm     (or  a: ... )
 *   bambam:  yeah im in                             (or  b: ... )
 *   <text>                                          (uses the last speaker)
 *   /state | /events | /a2a | /prompt a|b | /reseed | /help | /quit
 *
 * Nothing here touches production: DB is :memory: (override with SIM_DB_PATH),
 * and no network SMS is ever sent.
 */
'use strict';

// Isolate the DB BEFORE any module require opens it.
process.env.DB_PATH = process.env.SIM_DB_PATH || ':memory:';
process.chdir(require('path').join(__dirname, '..'));   // web/ root: resolve .env + migrations
require('dotenv').config();

// The model the sim (and prod) run the agent on. agent.js reads process.env
// .AGENT_MODEL at require time, so this MUST be set before the requires below.
// web/.env's AGENT_MODEL wins if present; otherwise we pin the current model so
// the sim never falls back to the stale (account-invalid) code default.
const CURRENT_MODEL = 'claude-sonnet-4-6';   // prod AGENT_MODEL — keep in sync with the Fly secret
if (!process.env.AGENT_MODEL) process.env.AGENT_MODEL = CURRENT_MODEL;

// Real agent turns require a real key — the sim never stubs Claude (that would
// be "fake training"). Enforced in injectHuman(); surfaced in the banner.
const LIVE = !!process.env.ANTHROPIC_API_KEY;

const readline = require('readline');
const db         = require('../db');
const sms        = require('../sms');
const agent      = require('../agent');
const multiparty = require('../multiparty');
const { routeInboundSms } = require('../server');

const MAX_DRAIN = 40;   // safety cap on one cascade (guards against agent↔agent loops)

// ── Seed data ────────────────────────────────────────────────────────────────

const USERS = {
  aphilos: { id: 'sim-aphilos', name: 'Aphilos', phone: '+15550000001',
             timezone: 'America/New_York',    city: 'Princeton, NJ',   lat: 40.3573, lng: -74.6672,
             prefs: { activity_loves: ['dinner', 'live music', 'hiking'], cuisine_loves: ['italian', 'thai'],
                      dietary_restrictions: [], vibe: ['low-key', 'good conversation'] } },
  bambam:  { id: 'sim-bambam',  name: 'BamBam',  phone: '+15550000002',
             timezone: 'America/Los_Angeles', city: 'Los Angeles, CA',  lat: 34.0522, lng: -118.2437,
             prefs: { activity_loves: ['dancing', 'dinner', 'beach'], cuisine_loves: ['sushi', 'mexican'],
                      dietary_restrictions: ['no shellfish'], vibe: ['fun', 'spontaneous'] } },
};

const nameByPhone = {};
const nameById    = {};
for (const k of Object.keys(USERS)) { nameByPhone[USERS[k].phone] = USERS[k].name; nameById[USERS[k].id] = USERS[k].name; }

function whoPhone(phone) { return nameByPhone[phone] || phone; }
function whoId(id)       { return nameById[id] || id; }

function wipe() {
  const raw = db._raw();
  raw.pragma('foreign_keys = OFF');
  const tables = raw.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'`
  ).all();
  for (const { name } of tables) {
    try { raw.prepare(`DELETE FROM "${name}"`).run(); } catch (_) { /* ignore */ }
  }
  raw.pragma('foreign_keys = ON');
}

function seed() {
  wipe();
  const raw = db._raw();
  for (const k of Object.keys(USERS)) {
    const u = USERS[k];
    raw.prepare(
      `INSERT INTO users (id, name, phone, onboarding_state, timezone, city, lat, lng)
       VALUES (?, ?, ?, 'complete', ?, ?, ?, ?)`
    ).run(u.id, u.name, u.phone, u.timezone, u.city, u.lat, u.lng);
    try { db.writeConsent(u.phone, 'SIM_SEED'); } catch (_) {}
    try { db.upsertPreferences(u.id, u.prefs); } catch (e) { warn(`prefs seed for ${u.name}: ${e.message}`); }
  }
  // Mutual contacts so message_agent can resolve peer → user.
  db.upsertContact({ invited_by_user_id: USERS.aphilos.id, name: 'BamBam',  phone: USERS.bambam.phone,  tier: 2 });
  db.upsertContact({ invited_by_user_id: USERS.bambam.id,  name: 'Aphilos', phone: USERS.aphilos.phone, tier: 2 });
}

// ── Output helpers ───────────────────────────────────────────────────────────

const C = { dim: '\x1b[2m', human: '\x1b[36m', sms: '\x1b[32m', tool: '\x1b[35m', a2a: '\x1b[33m', err: '\x1b[31m', reset: '\x1b[0m' };
function line(s) { process.stdout.write(s + '\n'); }
function warn(s) { line(`${C.err}! ${s}${C.reset}`); }
function brief(obj) { const s = JSON.stringify(obj); return s.length > 140 ? s.slice(0, 137) + '…' : s; }

// ── Instrumentation: capture every outbound SMS + every tool call ─────────────

let smsSeq = 0;
sms._setClient({
  messages: {
    create({ to, body }) {
      line(`${C.sms}  SMS → ${whoPhone(to)}${C.reset}  ${body}`);
      return Promise.resolve({ sid: `sim-${++smsSeq}` });
    },
  },
});

agent._setToolObserver((tool, input, userId) => {
  // Surface only the interesting tools; skip pure reads that add noise.
  const noisy = new Set(['get_relationships', 'get_contact_preferences', 'check_calendar_availability']);
  if (noisy.has(tool)) return;
  line(`${C.tool}    · ${whoId(userId)}.agent tool ${tool}${C.reset} ${C.dim}${brief(input)}${C.reset}`);
});

// ── The cascade engine ───────────────────────────────────────────────────────

function hopLabel(msg) {
  const to = whoId(msg.from_id);
  switch (msg.channel) {
    case 'agent_query': return `${to}.agent ← peer agent (query)`;
    case 'agent_reply': return `${to}.agent ← peer agent (reply)`;
    case 'agent':       return `${to}.agent ← notification`;
    default:            return `${to}.agent ← ${to}`;
  }
}

async function drain() {
  let guard = 0;
  while (true) {
    const pending = db.getPendingInboundMessages();
    if (!pending.length) break;
    if (++guard > MAX_DRAIN) { warn(`drain cap (${MAX_DRAIN}) hit — stopping cascade`); break; }
    const msg = pending[0];
    line(`${C.dim}  ▸ ${hopLabel(msg)}${C.reset}`);
    try {
      await agent.processMessage(msg);
    } catch (e) {
      warn(`processMessage error: ${e.message || e}`);
    } finally {
      db.markMessageProcessed(msg.id);
    }
  }
}

async function injectHuman(key, text) {
  if (!LIVE) {
    warn('No ANTHROPIC_API_KEY — refusing to run an agent turn (the sim never fakes Claude).');
    warn('Add ANTHROPIC_API_KEY to web/.env (and AGENT_MODEL if prod is not on ' + CURRENT_MODEL + '), then rerun.');
    return;
  }
  const u = USERS[key];
  line(`${C.human}${u.name} → ButterflAI:${C.reset} ${text}`);
  let reply = null;
  try {
    reply = await routeInboundSms(u.phone, text);
  } catch (e) {
    warn(`routeInboundSms error: ${e.message || e}`);
  }
  // The webhook wrapper would send this sync reply; the sim prints it (agent-loop
  // replies are captured by the stubbed Twilio client instead).
  if (reply) line(`${C.sms}  SMS → ${u.name}${C.reset}  ${reply}`);
  await drain();
}

// ── Inspectors ───────────────────────────────────────────────────────────────

function showState() {
  for (const k of Object.keys(USERS)) {
    const u = USERS[k];
    const contacts = db.getContactsByUser(u.id).length;
    const events = multiparty.getEventsByHost(u.id).filter(e => e.status === 'open');
    line(`${C.dim}── ${u.name} (${u.phone}, ${u.timezone}) — ${contacts} contacts${C.reset}`);
    if (!events.length) { line(`     open events: none`); continue; }
    for (const e of events) {
      const invs = db._raw().prepare(
        `SELECT c.name, ei.status FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ?`
      ).all(e.id);
      const list = invs.map(i => `${i.name}:${i.status}`).join(', ') || 'no invitees';
      line(`     event "${e.title}" [${e.id.slice(0, 8)}] — ${list}`);
    }
  }
  const q = db.getPendingInboundMessages().length;
  if (q) line(`${C.dim}   (${q} messages still queued)${C.reset}`);
}

function showEvents() {
  const rows = db._raw().prepare(`SELECT * FROM social_events ORDER BY created_at DESC LIMIT 20`).all();
  if (!rows.length) return line('  (no events)');
  for (const e of rows) {
    const invs = db._raw().prepare(
      `SELECT c.name, ei.status FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ?`
    ).all(e.id);
    line(`  [${e.status}] "${e.title}" host=${whoId(e.host_user_id)} ${new Date(e.scheduled_at * 1000).toISOString()}`);
    for (const i of invs) line(`       - ${i.name}: ${i.status}`);
  }
}

function showA2A() {
  const rows = db._raw().prepare(`SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT 20`).all().reverse();
  if (!rows.length) return line('  (no agent-to-agent messages)');
  for (const m of rows) {
    line(`  ${whoId(m.from_user)} → ${whoId(m.to_user)} [${m.kind}${m.topic ? '/' + m.topic : ''}] ${C.dim}${(m.body || '').slice(0, 90)}${C.reset}`);
  }
}

function showPrompt(key) {
  const u = db.getUserByPhone(USERS[key].phone);
  line(`${C.dim}── system prompt for ${USERS[key].name}.agent (dynamic state snapshot omitted — see /state) ──${C.reset}`);
  line(agent.buildSystemPrompt(u, '(state snapshot injected at runtime)'));
}

const HELP = `
  aphilos: <msg>  (a:)   send a message as Aphilos
  bambam:  <msg>  (b:)   send a message as BamBam
  <msg>                  send as the last speaker
  /state                 users, open events + RSVP statuses, queue depth
  /events                all events + invitations
  /a2a                   recent agent-to-agent messages
  /prompt a|b            print an agent's system prompt (behavioral rules)
  /reseed                wipe + reseed the two users (fresh slate)
  /help                  this help
  /quit                  exit`;

// ── REPL ─────────────────────────────────────────────────────────────────────

function banner() {
  line(`\n${C.human}🦋 ButterflAI multi-agent simulator${C.reset}`);
  const status = LIVE ? `${C.sms}LIVE${C.reset}` : `${C.err}NO KEY — agent turns disabled${C.reset}`;
  line(`${C.dim}DB=${process.env.DB_PATH}  model=${process.env.AGENT_MODEL}  key=${status}`);
  if (!LIVE) {
    warn('Set ANTHROPIC_API_KEY in web/.env for live training. Inspectors (/state, /prompt) still work without it.');
  }
  line(`${C.dim}Users: Aphilos (${USERS.aphilos.phone}, ET) · BamBam (${USERS.bambam.phone}, PT). Type /help.${C.reset}\n`);
}

async function handle(input) {
  const text = input.trim();
  if (!text) return true;

  if (text.startsWith('/')) {
    const [cmd, arg] = text.slice(1).split(/\s+/, 2);
    switch (cmd) {
      case 'help':   line(HELP); break;
      case 'state':  showState(); break;
      case 'events': showEvents(); break;
      case 'a2a':    showA2A(); break;
      case 'prompt': {
        const key = /^b/i.test(arg || '') ? 'bambam' : 'aphilos';
        showPrompt(key); break;
      }
      case 'reseed': seed(); handle.lastSpeaker = 'aphilos'; line(`${C.dim}reseeded.${C.reset}`); break;
      case 'quit':
      case 'exit':   return false;
      default:       warn(`unknown command: /${cmd} (try /help)`);
    }
    return true;
  }

  const m = text.match(/^(aphilos|bambam|a|b)\s*:\s*(.*)$/i);
  let key, body;
  if (m) {
    key = /^a/i.test(m[1]) ? 'aphilos' : 'bambam';
    body = m[2];
  } else {
    key = handle.lastSpeaker || 'aphilos';
    body = text;
  }
  handle.lastSpeaker = key;
  if (!body.trim()) { warn('empty message'); return true; }
  await injectHuman(key, body);
  return true;
}

async function main() {
  seed();
  banner();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  // Serialize input: queue lines and process one at a time so a message typed
  // (or piped) during a running cascade is handled next, never dropped.
  const queue = [];
  let running = false;
  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const input = queue.shift();
      let keepGoing = true;
      try { keepGoing = await handle(input); }
      catch (e) { warn(`error: ${e.stack || e}`); }
      if (!keepGoing) { rl.close(); return; }
    }
    running = false;
    rl.prompt();
  }
  rl.on('line', (input) => { queue.push(input); pump(); });
  rl.on('close', () => { line('\nbye 🦋'); process.exit(0); });
}

if (require.main === module) main();

module.exports = { seed, injectHuman, drain, USERS };   // exported for the engine smoke test
