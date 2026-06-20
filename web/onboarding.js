/**
 * ButterflAI SMS onboarding state machine
 *
 * Handles new users who text the Twilio number for the first time.
 *
 * States (§4.1 IMPLEMENTATION.md):
 *   new                → send greeting, move to awaiting_name
 *   awaiting_name      → capture name, move to awaiting_contacts
 *   awaiting_contacts  → parse relationship intents, move to confirming_contacts
 *   confirming_contacts → on "yes", create relationships + send contact invites
 *   complete           → hand off to normal agent message handling
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const sms = require('./sms');
const { cityFromPhone } = require('./areacode');

// ── State machine entry point ─────────────────────────────────────────────────

/**
 * Handle an inbound SMS from a user who is still onboarding.
 * Returns the reply text to send back.
 *
 * @param {string} phone  - E.164 sender phone
 * @param {string} body   - Message body
 * @param {object} db     - db module
 * @returns {string}      - Reply to send
 */
async function handleOnboarding(phone, body, db) {
  let user = db.getUserByPhone(phone);

  // Brand-new number: create a shell user and send greeting.
  // Consent is recorded ONLY if the first inbound word is START — texting anything
  // else creates the account and starts onboarding but does NOT write a consent
  // record; the gate in sms.send() will block outbound until START is texted.
  if (!user) {
    const userId = uuidv4();
    db.createUser({ id: userId, phone, name: 'unknown', onboarding_state: 'awaiting_name' });
    if (/^start$/i.test(body.trim())) {
      db.writeConsent(phone, 'SELF_START');
    }
    user = db.getUserByPhone(phone);
    return (
      `Hi! I'm ButterflAI — I help you stay meaningfully connected with people you care about. ` +
      `I'll handle the scheduling logistics so you can focus on the actual friendship. 🦋\n\n` +
      `What's your name?`
    );
  }

  const state = user.onboarding_state;

  if (state === 'awaiting_name') return handleAwaitingName(user, body, db);
  if (state === 'awaiting_location') return handleAwaitingLocation(user, body, db);
  if (state === 'awaiting_contacts') return handleAwaitingContacts(user, body, db);
  if (state === 'confirming_contacts') return handleConfirmingContacts(user, body, db);

  // Shouldn't get here — fall through to normal handling
  return null;
}

// ── State handlers ────────────────────────────────────────────────────────────

function handleAwaitingName(user, body, db) {
  const name = extractName(body);
  if (!name) {
    return `I didn't catch a name there. What should I call you?`;
  }

  // Seed city from area code, then ask user to confirm/correct
  const cityGuess = cityFromPhone(user.phone);
  db.updateUser(user.id, {
    name,
    onboarding_state: 'awaiting_location',
    ...(cityGuess ? { city: cityGuess } : {}),
  });

  if (cityGuess) {
    return `Nice to meet you, ${name}! 👋\n\nAre you based in ${cityGuess}? (yes / or tell me your city)`;
  }
  return `Nice to meet you, ${name}! 👋\n\nWhat city are you based in?`;
}

function handleAwaitingLocation(user, body, db) {
  const text = body.trim();
  const lower = text.toLowerCase();

  let city;
  if (/^y(es)?$/i.test(lower) && user.city) {
    // Confirmed the guess
    city = user.city;
  } else if (lower.length > 1 && !/^no?$/i.test(lower)) {
    // They typed a city name
    city = text;
  } else {
    // "no" or empty — ask again
    return `What city are you based in? (e.g. "New York", "Chicago", "London")`;
  }

  db.updateUser(user.id, { city, onboarding_state: 'awaiting_contacts' });

  return (
    `Got it — ${city}! 🗺️\n\n` +
    `Who do you want to stay in touch with regularly? Just tell me names and how often — like:\n\n` +
    `"Kaylee quarterly, Adam monthly, dinner with Kaylee and her partner every quarter"\n\n` +
    `You can list as many people as you like.`
  );
}

function handleAwaitingContacts(user, body, db) {
  const intents = parseRelationshipIntents(body);

  if (intents.length === 0) {
    return (
      `I couldn't quite parse that. Try something like:\n` +
      `"Lunch with Kaylee monthly, dinner with Adam quarterly"\n\n` +
      `Names, how often, and optionally what type of plan.`
    );
  }

  // Store parsed intents
  for (const intent of intents) {
    db.createOnboardingIntent({
      id: uuidv4(),
      user_id: user.id,
      contact_name: intent.name,
      frequency: intent.frequency,
      activity_type: intent.activity || null,
      group_size: intent.groupSize || 'one_on_one',
    });
  }

  // Build confirmation summary
  const summary = intents
    .map(i => `• ${i.activity ? i.activity + ' with' : ''} ${i.name} — ${i.frequency}${i.groupSize === 'couple' ? ' (+ partner)' : ''}`.trim())
    .join('\n');

  db.updateUser(user.id, { onboarding_state: 'confirming_contacts' });

  return `Got it — here's what I heard:\n\n${summary}\n\nDoes that look right? (yes / no)`;
}

async function handleConfirmingContacts(user, body, db) {
  const answer = body.toLowerCase().trim();

  if (answer === 'no' || answer.startsWith('no') || answer === 'n') {
    // Wipe intents and re-ask
    db.deleteOnboardingIntents(user.id);
    db.updateUser(user.id, { onboarding_state: 'awaiting_contacts' });
    return (
      `No problem — let's try again. Who do you want to stay in touch with, and how often?\n\n` +
      `e.g. "Kaylee monthly, Adam quarterly"`
    );
  }

  if (answer === 'yes' || answer.startsWith('yes') || answer === 'y') {
    const intents = db.getOnboardingIntents(user.id);

    // Confirm intents and create relationships
    db.confirmOnboardingIntents(user.id);
    await promoteIntentsToRelationships(user, intents, db);

    db.updateUser(user.id, { onboarding_state: 'complete' });

    const names = intents.map(i => i.contact_name).join(', ');
    return (
      `You're all set! 🦋\n\n` +
      `I'll reach out to ${names} to coordinate — I'll always identify myself as your ButterflAI and give them the option to opt out.\n\n` +
      `I'll check in with you before sending anything that sounds like it's coming from you personally.`
    );
  }

  return `Just reply "yes" to confirm, or "no" to start over.`;
}

// ── Relationship creation ─────────────────────────────────────────────────────

async function promoteIntentsToRelationships(user, intents, db) {
  for (const intent of intents) {
    // Create a contact record (Tier 0 — invited but not yet consented)
    const contactId = uuidv4();
    db.createContact({
      id: contactId,
      invited_by_user_id: user.id,
      name: intent.contact_name,
      tier: 0,  // will be upgraded when they accept the invite
    });

    // Create a relationship
    const relId = uuidv4();
    db.createRelationship({
      id: relId,
      user_id: user.id,
      contact_id: contactId,
      contact_is_user: 0,
    });

    // Create a cadence
    db.createCadence({
      id: uuidv4(),
      relationship_id: relId,
      activity_type: intent.activity_type || 'hangout',
      frequency: intent.frequency,
      group_size: intent.group_size || 'one_on_one',
    });
  }
}

// ── NLP helpers ───────────────────────────────────────────────────────────────

/**
 * Parse a free-text string into an array of relationship intents.
 * Handles patterns like:
 *   "Kaylee quarterly"
 *   "lunch with Kaylee monthly"
 *   "dinner with Kaylee and her partner every quarter"
 *   "Adam monthly, dinner with Sam quarterly"
 */
function parseRelationshipIntents(text) {
  const intents = [];

  // Split on commas or newlines to get individual items
  const parts = text.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    const intent = parseOneIntent(part);
    if (intent) intents.push(intent);
  }

  return intents;
}

function parseOneIntent(text) {
  const lower = text.toLowerCase();

  // Frequency mapping
  const freqMap = {
    'weekly': 'weekly', 'every week': 'weekly', 'week': 'weekly',
    'monthly': 'monthly', 'every month': 'monthly', 'month': 'monthly', 'once a month': 'monthly',
    'quarterly': 'quarterly', 'every quarter': 'quarterly', 'quarter': 'quarterly', 'once a quarter': 'quarterly',
    'biweekly': 'biweekly', 'every two weeks': 'biweekly', 'bi-weekly': 'biweekly',
  };

  // Activity types
  const activityMap = {
    'lunch': 'lunch', 'dinner': 'dinner', 'breakfast': 'breakfast',
    'drinks': 'drinks', 'coffee': 'coffee', 'brunch': 'brunch',
    'hike': 'hike', 'activity': 'activity', 'hangout': 'hangout',
  };

  // Group size signals
  const coupleSignals = ['and her partner', 'and his partner', 'and their partner', 'couple', 'and spouse', 'and wife', 'and husband'];

  let frequency = null;
  for (const [pattern, freq] of Object.entries(freqMap)) {
    if (lower.includes(pattern)) { frequency = freq; break; }
  }
  if (!frequency) return null;  // can't parse without a frequency

  let activity = null;
  for (const [pattern, act] of Object.entries(activityMap)) {
    if (lower.includes(pattern)) { activity = act; break; }
  }

  let groupSize = 'one_on_one';
  for (const signal of coupleSignals) {
    if (lower.includes(signal)) { groupSize = 'couple'; break; }
  }

  // Extract name: look for "with {name}" first, then just a capitalized word
  let name = null;
  const withMatch = text.match(/with\s+([A-Z][a-zA-Z]+)/);
  if (withMatch) {
    name = withMatch[1];
  } else {
    // First capitalized word that isn't a known keyword
    const cap = text.match(/\b([A-Z][a-zA-Z]+)\b/g);
    if (cap) {
      const skip = new Set(['Every', 'Once', 'Lunch', 'Dinner', 'Breakfast', 'Coffee', 'Drinks', 'Brunch']);
      name = cap.find(w => !skip.has(w)) || null;
    }
  }

  if (!name) return null;

  return { name, frequency, activity, groupSize };
}

/**
 * Best-effort name extraction from a single reply like "Sean" or "My name is Sean".
 */
function extractName(text) {
  const cleaned = text.trim();

  // "My name is X" / "I'm X" / "Call me X"
  const patterns = [
    /(?:my name is|i'm|i am|call me|it's|its)\s+([A-Za-z]+)/i,
    /^([A-Za-z]+)(?:\s+[A-Za-z]+)?$/,  // single or two-word name
  ];

  for (const p of patterns) {
    const m = cleaned.match(p);
    if (m) {
      const candidate = m[1];
      // Must be at least 2 chars, not a common filler
      const skip = new Set(['hi', 'hey', 'hello', 'yes', 'no', 'ok', 'okay']);
      if (candidate.length >= 2 && !skip.has(candidate.toLowerCase())) {
        return candidate.charAt(0).toUpperCase() + candidate.slice(1);
      }
    }
  }
  return null;
}

module.exports = { handleOnboarding };
