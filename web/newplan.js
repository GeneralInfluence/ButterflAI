/**
 * ＋ New plan makes the plan in code (owner, 2026-10-23, after Melanie and Allie's Friday lunch: they "had trouble using
 * the + button to create an event and had to try several ways"). Melanie's ＋ — "Sean to take boys to press start at
 * 5pm … Allie and Mel will be watching practical magic" — went to her agent, which was told "if it's clearly the same as
 * one of their open plans, use that one instead", and filed it as items on her weekend plan.
 *
 * Now ＋ always makes a new plan, right away: a short read of their words gives the name, the day/time only as they said
 * it, and the bigger plan it's part of (the plan they were looking at, or one their words are plainly about) — then
 * planops.create (a part has everyone in the bigger plan). Their words then go to their ButterflAI in the new plan's
 * discussion to fill in (who else, what's still open), never to make another plan.
 */
'use strict';

const db = require('./db');
const datetime = require('./datetime');
const { createAnthropicClient, DEFAULT_MODEL } = require('./anthropic-client');

let _client = null;
let _enabled = process.env.NODE_ENV !== 'test';
function _setClient(c) { _client = c; _enabled = !!c; }
function client() {
  if (!_enabled) return null;
  if (!_client) { try { _client = createAnthropicClient(); } catch (_) { _enabled = false; return null; } }
  return _client;
}

const PROMPT = `Someone tapped "＋ New plan" in their planning app and wrote what the plan is. Read it into:
- title: a short name, 2–6 words ("Press Start + Practical Magic", "Dinner with Allie")
- what: one or two words for the kind of thing ("arcade + movie", "dinner")
- when: the day and time ONLY in their own words ("today 5pm", "friday", "tonight") — null if they gave none. Never invent one.
- part_of: the eventId of one of their plans listed below if this is plainly part of it (it happens during it, or they name it) — else null.
Reply with JSON only: {"title":"…","what":"…","when":null,"part_of":null}`;

async function read(userId, text, plans) {
  const c = client();
  if (!c) return null;
  const tz = db.getUser(userId)?.timezone || 'America/Los_Angeles';
  const today = new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' });
  const list = plans.map((p) => `- eventId="${p.id}" "${p.title}" — ${p.dates?.label || 'date TBD'}`).join('\n') || '(none)';
  try {
    const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: 200, system: PROMPT,
      messages: [{ role: 'user', content: `Today is ${today}.\nTheir plans:\n${list}\n\nWhat they wrote: ${text}` }] });
    const out = String(r.content?.find((b) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/);
    return out ? JSON.parse(out[0]) : null;
  } catch (err) { console.warn('[newplan]', err.message); return null; }
}

/** Make the plan from their words. partOf: the plan they were looking at when they tapped ＋. */
async function make(userId, text, { partOf = null } = {}) {
  const words = String(text || '').replace(/\s+/g, ' ').trim();
  if (!words) return { error: 'EMPTY' };
  const plan = require('./plan');
  const plans = plan.plansFor(userId);
  const r = (await read(userId, words, plans)) || {};
  const title = String(r.title || '').trim().slice(0, 80) || require('./todos').shortName(words).name.slice(0, 80);
  // A day or time only if they said one (no invented days — 🐛 #89).
  let when = r.when ? String(r.when).slice(0, 80) : null;
  if (when && !datetime.saysDay(words)) when = datetime.withoutDay(when);   // "Saturday 5pm" when she said only "5pm"
  if (when && !datetime.saysTime(words)) when = when.replace(new RegExp(datetime.TIME_WORDS.source, 'gi'), '').replace(/\s+(at|in the)\s*$/i, '').trim();
  if (when && !datetime.saysDay(when) && datetime.saysTime(when)) when = `today ${when}`;   // "5pm" with no day is today's
  if (!when) when = null;
  const parent = partOf && plans.some((p) => p.id === partOf) ? partOf : (r.part_of && plans.some((p) => p.id === r.part_of) ? r.part_of : null);
  let name = title;
  for (let i = 2; plan.existingByName(userId, name); i++) name = `${title} (${i})`;   // ＋ is always a new plan
  const made = await require('./planops').create(userId, { title: name, activity_type: String(r.what || 'plan').slice(0, 40), ...(when ? { when } : {}),
    tentative: !when, ...(parent ? { part_of: parent } : {}) }, { via: 'app' });
  if (made.error) return made;
  return { ok: true, event_id: made.eventId, title: name, part_of: parent, invited: made.invites?.sent || 0 };
}

module.exports = { make, read, PROMPT, _setClient };
