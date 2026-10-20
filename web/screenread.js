/**
 * screenread.js — read what's on screen for a Quick note (owner, 2026-10-20: "we're going to
 * have the little overlay for any app where you will try to capture whatever you can from the
 * screen … when a person goes to say something").
 *
 * A screenshot from any app (Tinder, Instagram, a group chat…) is read ONCE by the model and
 * turned into a few plain facts that help the user's own ButterflAI: who they're talking to,
 * where they are, what they're into, any plan or time mentioned. Looks are never described.
 * The image itself is never stored — only these facts reach the agent, as part of the note.
 */
'use strict';

const { createAnthropicClient, DEFAULT_MODEL } = require('./anthropic-client');

let _client = null;
let _enabled = process.env.NODE_ENV !== 'test';
function _setClient(c) { _client = c; _enabled = !!c; }
function client() {
  if (!_enabled) return null;
  if (!_client) { try { _client = createAnthropicClient(); } catch (_) { _enabled = false; return null; } }
  return _client;
}

const PROMPT = `This is a screenshot the user took on their own phone, in some app, to tell their ButterflAI (their personal social assistant) about someone they're talking to or something going on.
Write only the facts that would help plan something or remember this person, as short lines:
- App: which app this is, if you can tell (Tinder, Bumble, Hinge, Feeld, Instagram, Messages…)
- Person: their name (and age if shown)
- Where: their town / neighborhood / distance if shown
- Into: interests, things they mention liking (from their profile or the messages)
- Talked about: plans, places, days or times mentioned in the conversation, and anything left open (a question waiting for an answer)
Leave a line out if it isn't on screen. Never describe anyone's looks or photos. Don't quote whole messages — a few words at most. If the screenshot doesn't show anything like this, write "Nothing useful on screen."`;

const MEDIA = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

/** dataUrl → plain-text facts (or null if it couldn't be read). */
async function read(dataUrl) {
  const m = MEDIA.exec(String(dataUrl || ''));
  if (!m) return null;
  const c = client();
  if (!c) return null;
  try {
    const r = await c.messages.create({ model: DEFAULT_MODEL, max_tokens: 400, messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
      { type: 'text', text: PROMPT },
    ] }] });
    const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return text ? text.slice(0, 1500) : null;
  } catch (e) {
    console.error('[screenread] failed:', e.message);
    return null;
  }
}

module.exports = { read, PROMPT, MEDIA, _setClient };
