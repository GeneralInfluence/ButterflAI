/**
 * actioncheck.js — every reply is checked for an action that should have happened.
 *
 * Owner, 2026-10-12: "We need to check the AI responses every time to determine if there
 * is an action that needs to happen." (Sean's agent told him the dates and place for two
 * plans, said "Done" and "Let me create both events…", and nothing was saved.)
 *
 * After each user turn, a short model check sees the user's message, the agent's reply,
 * what its tools actually did, and — when the turn is about a plan — what the plan has
 * stored. It lists actions that were asked for, promised, or claimed but not carried out
 * (save a date, create a plan, send a message, add someone…). agent.js sends them back to
 * the agent once to do before replying. The most recent decision wins: a detail changed
 * later in the conversation is not "missing".
 */
'use strict';

const { createAnthropicClient, DEFAULT_MODEL } = require('./anthropic-client');
const plansync = require('./plansync');

let _client = null;
let _enabled = process.env.NODE_ENV !== 'test';
function _setClient(c) { _client = c; _enabled = !!c; }
function client() {
  if (!_enabled) return null;
  if (!_client) { try { _client = createAnthropicClient(); } catch (_) { _enabled = false; return null; } }
  return _client;
}

const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return String(s || '').slice(0, 300); };

/**
 * @param {object} p  userText, replyText, toolLog [{name, input, result}], planId (optional)
 * @returns {Promise<string[]>} actions still to do ([] if none or no model)
 */
async function missingActions({ userText, replyText, toolLog = [], planId = null }) {
  const c = client();
  if (!c || !String(userText || '').trim()) return [];
  const plan = planId ? plansync.storedPlan(planId) : null;
  const tools = toolLog.length
    ? toolLog.map((t) => `- ${t.name}(${short(t.input)}) → ${t.result?.error ? 'FAILED: ' + short(t.result.message || t.result.error) : short(t.result)}`).join('\n')
    : '(no tools were used)';
  const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: 400, messages: [{ role: 'user', content:
    `Today is ${new Date().toISOString().slice(0, 10)}. Check whether a planning assistant actually did what this exchange calls for.\n\n`
    + `User: ${String(userText).slice(0, 1500)}\nAssistant reply: ${String(replyText || '').slice(0, 1500)}\n\nWhat the assistant's tools actually did:\n${tools}\n`
    + (plan ? `\nThe plan this is about (eventId="${planId}"), as stored:\n${plan.lines.join('\n')}\n` : '')
    + '\nList actions that are still NOT done but should be: things the user asked for or decided, or the reply says were done or will be done ("done", "saved", "let me create…", "I\'ll send…"), '
    + 'or plan details (dates, place, people, cancelled) decided in this exchange that the stored plan lacks. Something already on the plan\'s Creating list counts as recorded. Ignore questions the assistant is asking back, things it explained it can\'t do, and details superseded later in the exchange.\n'
    + 'Reply with JSON only: {"missing":["save dates Oct 23–24 on Melanie\'s Birthday Weekend","…"]} or {"missing":[]}.' }] });
  try {
    const j = JSON.parse(String((r.content || []).map((b) => b.text || '').join('')).match(/\{[\s\S]*\}/)[0]);
    return (Array.isArray(j.missing) ? j.missing : []).map((s) => String(s).slice(0, 200)).filter(Boolean).slice(0, 6);
  } catch (_) { return []; }
}

module.exports = { missingActions, _setClient };
