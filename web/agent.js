/**
 * ButterflAI agent message processor
 *
 * Dequeues inbound_messages, runs them through the Claude sub-agent, replies via SMS.
 *
 * Architecture (§1.5 IMPLEMENTATION.md):
 *  - Master process polls the inbound_messages queue on a short interval.
 *  - For each pending message, it spawns an ephemeral per-user "sub-agent" by calling
 *    the Claude API with a user-scoped system prompt + tool access.
 *  - Tools are scoped to user_id at call time (structural isolation, not instructional).
 *  - Context is fetched on demand via tools, not stuffed into the prompt.
 *  - After processing, reply goes out via SMS and the message is marked processed.
 *
 * Isolation guarantee: every tool call in this file is gated by the userId resolved
 * from the inbound message. A sub-agent cannot fetch another user's data because the
 * tool implementations hard-code the resolved userId — they don't accept one as input.
 *
 * Hard rules enforced here (IMPLEMENTATION.md §6):
 *  - Logistics auto-run within user-set rules.
 *  - Expressive messages (speaking as the user) require user approval — the agent
 *    drafts and SMS the user for confirmation before sending to any contact.
 *  - Self-identify + STOP on every first outbound contact message.
 */

'use strict';

const { createAnthropicClient, resolveAuth, DEFAULT_MODEL } = require('./anthropic-client');
const db = require('./db');
const sms = require('./sms');
const { ConsentRequired } = require('./sms');
const { readUserPrivateData } = require('./crypto');
const calendar = require('./calendar');
const contactsImport = require('./contacts-import');
const venues = require('./venues');
const multiparty = require('./multiparty');
const desires    = require('./desires');
const sensitive  = require('./sensitive');
const avoid      = require('./avoid');
const topics     = require('./topics');
const defer      = require('./defer');
const linktoken  = require('./linktoken');
const groupPlans = require('./groups');
const names      = require('./names');
const { toE164 } = require('./phoneUtils');
const trace      = require('./trace');
const deliver    = require('./deliver');
const plans      = require('./plans');
const links      = require('./links');
const weather    = require('./weather');
const datetime   = require('./datetime');
const coord      = require('./coordination');
const sse        = require('./sse');
const flai       = require('./flai');

let anthropic = createAnthropicClient();

// Test/sim injection: swap the Anthropic client (mirrors sms._setClient). No-op
// in prod. Lets the multi-agent simulator (tools/sim.js) drive scripted or real
// agent turns without the module-scope client being fixed at require time.
function _setAnthropic(client) { anthropic = client; }

// Optional tool-call observer for instrumentation (the sim's transcript). A
// complete no-op unless a function is registered. Never affects behavior.
let _toolObserver = null;
function _setToolObserver(fn) { _toolObserver = fn; }

const POLL_INTERVAL_MS = parseInt(process.env.AGENT_POLL_MS || '5000', 10);
// Haiku 4.5 is the committed dev-user model (fast + cheap; reliability comes from the
// recipe layer + deterministic scaffolding + the feedback loop, not a bigger model).
// The old 'claude-3-5-haiku-20241022' default 404s on this account — never fall back to it.
// The prod AGENT_MODEL Fly secret overrides this; keep that secret on a Haiku-4.5 id.
const MODEL = process.env.AGENT_MODEL || DEFAULT_MODEL;
if (!/claude/.test(MODEL)) {
  throw new Error(`AGENT_MODEL is set to an invalid value: "${MODEL}"`);
}

// ── Proposal provenance helpers (FLAI §2.2) ───────────────────────────────────

/**
 * Record a proposal provenance row.
 * TODO(human): distinguish 'agent_discovery' (unprompted) from 'user_request'
 * (user explicitly asked). Currently defaulted at each call site — needs
 * context from upstream to distinguish reliably.
 */
async function recordProposal(userId, origin, opts = {}) {
  try {
    const { v4: uuidv4 } = require('uuid');
    db.createProposal({
      id: uuidv4(),
      user_id: userId,
      cadence_id: opts.cadenceId || null,
      origin,
      activity_type: opts.activityType || null,
      surfaced_slots: opts.surfacedSlots || null,
    });
  } catch (err) {
    console.error('[agent] recordProposal error (non-fatal):', err.message);
  }
}

/**
 * Convert a proposal to a confirmed event.
 */
async function convertProposal(proposalId, eventId) {
  try {
    db.updateProposalOutcome(proposalId, { outcome: 'converted', event_id: eventId });
  } catch (err) {
    console.error('[agent] convertProposal error (non-fatal):', err.message);
  }
}

// ── Tool definitions (passed to Claude) ──────────────────────────────────────
// Each tool is resolved at call-time against the current userId.

const TOOL_DEFINITIONS = [
  {
    name: 'add_contact',
    description: 'Add or update a contact in the user\'s address book. Use this whenever the user mentions someone by name and provides a phone number, or asks to add/save a contact. Gate 1 only — does NOT message them.',
    input_schema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: 'Contact\'s full name or nickname' },
        phone: { type: 'string', description: 'Phone number (any format — will be normalized)' },
        notes: { type: 'string', description: 'Any extra context the user provided (optional)' },
      },
      required: ['name', 'phone'],
    },
  },
  {
    name: 'lookup_contact',
    description: 'Look up a contact by name or phone number in the user\'s address book.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or phone number to search for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'update_contact',
    description: 'Update a contact\'s name, nickname, or "also known as" field. Use when the user says something like "Aphilos is also Sean Gonzalez", "call Marcus \'Marc\' from now on", or "her name is actually Allie not Allison". Requires the contact_id from lookup_contact.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id:    { type: 'string', description: 'The contact\'s ID (from lookup_contact)' },
        name:          { type: 'string', description: 'Updated primary name (replaces current name)' },
        nickname:      { type: 'string', description: 'Short nickname to display (optional)' },
        also_known_as: { type: 'string', description: 'Other names this person goes by (optional, free text)' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'manage_contact_group',
    description: 'Create, rename, or manage contact groups/lists (e.g. "closest friends", "work", "book club"). Use this whenever the user mentions a group, list, or category of contacts — create the group automatically if it doesn\'t exist. Also use to add/remove contacts from a group or to list all groups.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_or_get', 'add_member', 'remove_member', 'list_groups', 'delete_group'],
          description: 'What to do: create_or_get a group (idempotent), add/remove a member, list all groups, or delete a group',
        },
        group_name: { type: 'string', description: 'Name of the group (e.g. "closest friends", "family")' },
        group_emoji: { type: 'string', description: 'Optional emoji for the group (e.g. "⭐", "❤️")' },
        group_id:   { type: 'string', description: 'Group ID (required for add_member / remove_member / delete_group; get from list_groups or prior create_or_get call)' },
        contact_id: { type: 'string', description: 'Contact ID to add or remove (from lookup_contact)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'get_relationships',
    description: 'Get the user\'s relationships and active cadences (who they want to stay in touch with and how often).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_contact_preferences',
    description: 'Get stored preferences for a specific contact (availability, dietary, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'The contact\'s ID' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'get_private_preferences',
    description: 'Get the user\'s private preferences (exclusions, private notes). Sensitive — use only when needed for coordination.',
    input_schema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: 'Why you need this — logged in the audit trail' },
      },
      required: ['purpose'],
    },
  },
  {
    name: 'create_invite',
    description: 'Generate an invite link for a contact. Send this to invite someone to join ButterflAI.',
    input_schema: {
      type: 'object',
      properties: {
        contact_name: { type: 'string', description: 'Contact\'s name (pre-fills invite page)' },
      },
      required: ['contact_name'],
    },
  },
  {
    name: 'draft_contact_message',
    description: 'Draft a message to send to a contact on the user\'s behalf. Returns draft for user approval before sending. Use this for any message that carries sentiment or speaks as the user.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        message: { type: 'string', description: 'The draft message text' },
        message_type: {
          type: 'string',
          enum: ['logistics', 'expressive'],
          description: '"logistics" (scheduling/coordination info — can auto-send) or "expressive" (speaks as the user with sentiment — MUST get user approval first)',
        },
      },
      required: ['contact_id', 'message', 'message_type'],
    },
  },
  {
    name: 'send_logistics_sms',
    description: 'Send a message to a contact on the user\'s behalf (logistics, nudges, plans). ButterflAI users get it in the app, texted only if they don\'t open the app in time; everyone else gets a text. The sender is added automatically ("Allie\'s ButterflAI: …") — write only the message itself. Includes the full self-identify header on first contact with a non-user.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        message: { type: 'string' },
        is_first_contact: {
          type: 'boolean',
          description: 'Set true if this is the first outbound message to this contact — triggers self-identify + STOP notice',
        },
        via: {
          type: 'string', enum: ['app', 'text'],
          description: '"text" when the user asked for it to go by text ("text her now"). Otherwise omit — ButterflAI decides (in the app, or a text if they won\'t see it there).',
        },
      },
      required: ['contact_id', 'message'],
    },
  },
  {
    name: 'message_agent',
    description: 'Send a message to another ButterflAI user\'s AGENT (not the person). Use this to coordinate BEFORE bothering either user. Ask about availability, dietary constraints, RSVP status, or logistics. The other agent will respond autonomously without disturbing their user for factual questions. The person never sees it — to ask or tell the person something, use send_logistics_sms instead.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id:  { type: 'string', description: 'Contact ID of the other user (from lookup_contact)' },
        topic:       { type: 'string', enum: ['availability', 'constraints', 'rsvp', 'coordination'], description: 'What you\'re asking about' },
        message:     { type: 'string', description: 'Your question or message to the other agent. Be specific.' },
        thread_id:   { type: 'string', description: 'Thread ID to continue an existing conversation; omit to start a new one' },
        event_id:    { type: 'string', description: 'REQUIRED for topic "coordination": the eventId (from Open events) of the plan or trip this is about. Create it first with create_social_event (tentative: true if details are still open).' },
      },
      required: ['contact_id', 'topic', 'message'],
    },
  },
  {
    name: 'reply_agent',
    description: 'Reply to an agent message you received. Used when your agent receives a query from another agent and you want to respond on your user\'s behalf without bothering them.',
    input_schema: {
      type: 'object',
      properties: {
        message_id:  { type: 'string', description: 'ID of the agent message to reply to' },
        body:        { type: 'string', description: 'Your reply on behalf of your user' },
      },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'store_private_data',
    description: 'Store SENSITIVE information the user has shared — health/medical info, STI test results, sexual health, mental health, financial struggles, legal matters, or anything the user explicitly marked as private. This data is encrypted at rest and NEVER shared without explicit per-recipient approval. Use this instead of update_preferences for anything sensitive.',
    input_schema: {
      type: 'object',
      properties: {
        data_key:  { type: 'string', description: 'Namespaced key, e.g. "health.sti_status", "mental_health.therapy", "financial.debt_note"' },
        value:     { type: 'string', description: 'The sensitive information to store' },
        category:  { type: 'string', enum: ['HEALTH', 'SEXUAL', 'FINANCIAL', 'LEGAL', 'MENTAL_HEALTH', 'RELATIONSHIP', 'OTHER'], description: 'Category for access control' },
      },
      required: ['data_key', 'value', 'category'],
    },
  },
  {
    name: 'share_plan',
    description: 'Share what the user is up to with their friends, when the user offers it ("I\'m at Sully\'s tonight, the boys can come", "free all weekend", "laying low this week"). Friends see it in their Home feed; nobody is pinged. Pass the user\'s own words for how long it holds as `until` ("tonight", "this weekend", "until friday", "all week") — the server works out the date; never compute it yourself. Use `group` only if the user named one ("the boys").',
    input_schema: {
      type: 'object',
      properties: {
        text:  { type: 'string', description: 'The plan as friends should see it, e.g. "At Sully\'s from 9 — come by"' },
        until: { type: 'string', description: 'The user\'s wording for how long it holds: "tonight", "this weekend", "until friday", "for 3 days"' },
        group: { type: 'string', description: 'Optional contact group that can see it (default: all their contacts on ButterflAI)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'clear_my_plans',
    description: 'Remove the plans the user shared (plans changed, or "I\'m not doing that anymore").',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'check_friends_plans',
    description: 'Answer "what are my friends / my boys up to tonight?" from what those friends have SHARED with this user. Nobody is pinged; each friend asked sees a quiet "<user>\'s up for something" in their Home feed. Pass `group` if the user named one ("my boys"), and `when` in the user\'s words ("tonight", "this weekend"). Report only what comes back — never guess what someone is doing.',
    input_schema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Contact group name the user mentioned, e.g. "boys"' },
        when:  { type: 'string', description: 'The user\'s wording: "tonight", "this weekend"' },
      },
    },
  },
  {
    name: 'manage_avoid_list',
    description: 'The user\'s private AVOID LIST: people they don\'t want to be in plans with ("I don\'t want to hang out with Julie", "keep me away from Dave", "stop inviting me to things with Sam"). Use action=add as soon as the user says this — look the person up with lookup_contact first and pass their contact_id. Store NO reason. The list is encrypted and enforced in code: avoided people are never invited by this user, and their invites to this user are declined automatically ("not available", never a reason) unless the entry is set to ask. Use set_policy with on_invite="ask" when the user wants to decide each time ("ask me when Julie invites me"), or "auto_decline" to stop asking. Use remove when the user is fine with the person again.',
    input_schema: {
      type: 'object',
      properties: {
        action:     { type: 'string', enum: ['add', 'remove', 'set_policy', 'list'] },
        contact_id: { type: 'string', description: 'The person\'s contact id (from lookup_contact). Required for add, remove, set_policy.' },
        on_invite:  { type: 'string', enum: ['auto_decline', 'ask'], description: 'What to do when this person invites the user. Default auto_decline.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'update_preferences',
    description: 'Save something you learned about the user\'s preferences — allergies, dietary needs, activity likes/dislikes, vibe, budget, neighborhood, availability. Call this whenever the user mentions anything about their preferences, even casually ("I hate sushi", "I\'m usually free after 7", "I\'m allergic to nuts"). Do NOT wait to be asked — just save it. NEVER use this for sensitive data (health, medical, sexual, financial, legal, mental health) — use store_private_data instead.',
    input_schema: {
      type: 'object',
      properties: {
        food_allergies:        { type: 'array', items: { type: 'string' }, description: 'Life-threatening allergies, e.g. ["shellfish","peanuts"]' },
        dietary_restrictions:  { type: 'array', items: { type: 'string' }, description: 'e.g. ["vegetarian","gluten-free"]' },
        cuisine_loves:         { type: 'array', items: { type: 'string' } },
        cuisine_avoids:        { type: 'array', items: { type: 'string' } },
        activity_loves:        { type: 'array', items: { type: 'string' }, description: 'e.g. ["bars","hiking","live music"]' },
        activity_avoids:       { type: 'array', items: { type: 'string' } },
        vibe:                  { type: 'array', items: { type: 'string' }, description: 'e.g. ["low-key","dive bars","foodie","outdoorsy"]' },
        budget_low:            { type: 'number', description: 'Minimum spend per outing in USD' },
        budget_high:           { type: 'number', description: 'Maximum spend per outing in USD' },
        neighborhood:          { type: 'string' },
        city:                  { type: 'string' },
        availability_notes:    { type: 'string', description: 'Free-form, e.g. "weeknight evenings after 7, weekend afternoons"' },
        comm_style:            { type: 'string', enum: ['brief', 'detailed', 'just handle it'] },
        extra_notes:           { type: 'string', description: 'Anything else worth remembering' },
        health_safety_notes:   { type: 'string', description: 'Health/safety information the user has consented to share with trusted contacts\' agents when asked — e.g. "STI tests current as of 2026-06", "non-smoker", "sober". Stored ENCRYPTED at rest (never in plaintext prefs). Only store if the user explicitly says they\'re comfortable sharing this with other agents.' },
      },
    },
  },
  {
    name: 'get_contact_hard_constraints',
    description: 'Get the hard constraints (allergies, dietary restrictions) for a contact who is also a ButterflAI user — for agent-to-agent coordination. Only returns non-private constraint data, not soft preferences.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'Contact ID from lookup_contact' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'request_private_sharing',
    description: 'Ask the user to CONFIRM sharing ONE private datum with ONE specific contact. This does NOT share anything by itself — it sends the user a confirmation prompt, and the item is shared ONLY if they reply yes (confirmed in code, not by you). Use when a private item (e.g. a health/dietary note) would genuinely help coordinate. Do NOT assume it is shared until the user confirms. data_key is the private item\'s key (e.g. "health.safety_notes").',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'The contact who would receive the item' },
        data_key:   { type: 'string', description: 'Key of the private datum, e.g. "health.safety_notes"' },
      },
      required: ['contact_id', 'data_key'],
    },
  },
  {
    name: 'revoke_private_sharing',
    description: 'Withdraw the user\'s consent to share ONE private datum with ONE specific contact. Call when the user says to stop sharing something with someone.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'The contact to stop sharing with' },
        data_key:   { type: 'string', description: 'Key of the private datum, e.g. "health.safety_notes"' },
      },
      required: ['contact_id', 'data_key'],
    },
  },
  {
    name: 'check_invitee_locations',
    description: 'Before coordinating time/logistics for a group event, check how far each invitee is from the host. Returns each invitee\'s city, distance, and a ROUTING RECOMMENDATION: "flexible" (all nearby, no need to coordinate time), "mixed" (some nearby, some distant — coordinate time for distant only), or "coordinate" (all distant — must agree on a specific time). ALWAYS call this first when planning a group event where you do not already know everyone\'s location.',
    input_schema: {
      type: 'object',
      properties: {
        contact_ids: { type: 'array', items: { type: 'string' }, description: 'Contact IDs of invitees to check' },
      },
      required: ['contact_ids'],
    },
  },
  {
    name: 'confirm_coordination_invite',
    description: 'Respond to an event invitation from another ButterflAI user. Updates your RSVP status, optionally adds the event to YOUR calendar, and notifies the host\'s agent in the background — without sharing your private preferences.',
    input_schema: {
      type: 'object',
      properties: {
        invitation_id: { type: 'string', description: 'inv_id from the coordination invite in your state snapshot' },
        status: { type: 'string', enum: ['accepted', 'declined'], description: 'Your response' },
        add_to_calendar: { type: 'boolean', description: 'Whether to add this event to your own Google Calendar' },
      },
      required: ['invitation_id', 'status'],
    },
  },
  {
    name: 'record_rsvp',
    description: 'Record an RSVP for a contact on an event YOU host when they answered outside the invite (in person, by text, or in a reply from their ButterflAI). Use when the user says "Allison said she\'s in", or when a friend\'s ButterflAI reply shows they\'re clearly in ("I\'m good with that", "count me in") → accepted. On a tentative event, accepted shows as "interested" and puts it on their ButterflAI calendar.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event ID from the state snapshot' },
        contact_phone: { type: 'string', description: 'Contact phone number (E.164)' },
        status: { type: 'string', enum: ['accepted', 'declined'], description: 'Their response' },
        source: { type: 'string', description: 'How they confirmed, e.g. "in person", "phone call"' },
      },
      required: ['event_id', 'contact_phone', 'status'],
    },
  },
  {
    name: 'defer_on_plan',
    description: 'Your user is invited to a plan and says they don\'t want to weigh in — they\'ll go with whatever certain people decide ("whatever Melanie wants", "you and Sean figure it out", "I don\'t care, it\'s her birthday"). Records that they\'re in and who decides, for THIS plan only. From then on questions about it are answered for them (no reasons given) and they only get an FYI on big changes. undo: true if they want to be asked again.',
    input_schema: {
      type: 'object',
      properties: {
        invitation_id: { type: 'string', description: 'inv_id from "You have been invited to" in your state' },
        defer_to:      { type: 'array', items: { type: 'string' }, description: 'First names of who decides, e.g. ["Melanie", "Sean"]' },
        undo:          { type: 'boolean', description: 'true = they want to be asked about this plan again' },
      },
      required: ['invitation_id'],
    },
  },
  {
    name: 'save_agent_note',
    description: 'Save a durable fact you have learned about the user — resolved contact disambiguations, preferences, standing instructions. These persist forever and appear in every future conversation. Use after confirming something that you\'d otherwise forget (e.g. "Allison = Allison McLaine ...7976", "user prefers evening events").',
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Short, factual note to remember permanently' },
      },
      required: ['note'],
    },
  },
  {
    name: 'check_contact_consent',
    description: 'Check whether a contact has opted in to receive messages from ButterflAI. Always check this before attempting to send a logistics SMS to a contact for the first time.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'get_contact_import_url',
    description: 'Get a link the user can open on their phone to import all their contacts at once. Send this when the user asks to import contacts, sync their address book, or add multiple people at once.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pending_invites',
    description: 'Get the list of pending invites the user has sent.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_importable_contacts',
    description: 'Get the list of contacts the user has added/imported but not yet invited (Tier 0). These are people the user could invite to coordinate via ButterflAI.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'send_contact_invite',
    description: 'Send a ButterflAI onboarding invite SMS to a Tier 0 (not yet connected) contact. Use ONLY when the user wants to invite someone to JOIN ButterflAI — NOT for inviting someone to a social activity, event, hangout, or gathering. For activity invites (dinner, drinks, testing the app together, etc.), use create_social_event. Will error if contact is already Tier 1+.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        context: { type: 'string', description: 'Brief context e.g. "quarterly lunch"' },
      },
      required: ['contact_id', 'context'],
    },
  },
  {
    name: 'check_calendar_availability',
    description: 'Check whether the user is free during proposed time slots. Returns free/busy for each slot.',
    input_schema: {
      type: 'object',
      properties: {
        slots: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'ISO 8601 datetime' },
              end:   { type: 'string', description: 'ISO 8601 datetime' },
            },
            required: ['start', 'end'],
          },
        },
      },
      required: ['slots'],
    },
  },
  {
    name: 'find_free_slots',
    description: 'Find upcoming free time slots on the user\'s calendar. Use when suggesting times to a contact.',
    input_schema: {
      type: 'object',
      properties: {
        duration_mins: { type: 'number', description: 'Duration needed in minutes (default 90)' },
        count: { type: 'number', description: 'Number of options to return (default 3)' },
        preferred_time: {
          type: 'string',
          enum: ['morning', 'lunch', 'afternoon', 'evening'],
          description: 'Preferred time of day (optional)',
        },
        search_days: { type: 'number', description: 'Days ahead to search (default 21)' },
      },
      required: [],
    },
  },
  {
    name: 'create_calendar_event',
    description: 'Create an event on the user\'s Google Calendar. Call this after a time is agreed.',
    input_schema: {
      type: 'object',
      properties: {
        title:       { type: 'string' },
        start:       { type: 'string', description: 'ISO 8601 datetime' },
        end:         { type: 'string', description: 'ISO 8601 datetime' },
        description: { type: 'string' },
        location:    { type: 'string' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    name: 'get_calendar_connect_url',
    description: 'Get a URL the user can open to connect their calendar. Supports Google Calendar (OAuth) and Apple/iCloud Calendar (app-specific password). Ask which they prefer, or offer both options.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['google', 'apple'], description: 'Which calendar to connect. If unsure, ask the user.' },
      },
    },
  },
  {
    name: 'suggest_venues',
    description: 'Suggest venue options for a planned activity. Returns up to 3 options (favorites + new discoveries).',
    input_schema: {
      type: 'object',
      properties: {
        activity_type: { type: 'string', description: 'e.g. "lunch", "dinner", "drinks"' },
        neighborhood:  { type: 'string', description: 'Preferred area (optional)' },
        dietary:       { type: 'array', items: { type: 'string' }, description: 'Dietary restrictions (optional)' },
        price_level:   { type: 'number', description: 'Max price level 1-4 (optional)' },
      },
      required: ['activity_type'],
    },
  },
  {
    name: 'get_venue_favorites',
    description: "Get the user's saved favorite venues.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'add_venue_favorite',
    description: "Save a venue to the user's favorites.",
    input_schema: {
      type: 'object',
      properties: {
        name:    { type: 'string' },
        address: { type: 'string' },
        cuisine: { type: 'string' },
        notes:   { type: 'string', description: 'Personal notes e.g. "great for dates"' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_social_event',
    description: 'Create a social event and optionally invite specific contacts. Host sets the plan; contacts are soft-RSVPed.',
    input_schema: {
      type: 'object',
      properties: {
        title:         { type: 'string', description: 'e.g. "Dinner at Carbone"' },
        activity_type: { type: 'string' },
        venue_name:    { type: 'string' },
        venue_address: { type: 'string' },
        when:          { type: 'string', description: 'PREFERRED. The user\'s day + time phrase exactly as they said it — "friday 7pm", "saturday evening", "tomorrow at 8pm", "tonight at 9". The server resolves the exact date in the user\'s timezone, so you do NOT compute or verify any date. Always use this instead of scheduled_at when the user gave a day/time in words. Include both a day and a time.' },
        scheduled_at:  { type: 'string', description: 'Only for an explicit calendar date the user gave as a date (e.g. "September 30 at 7pm"). ISO 8601 with offset. Prefer "when" for weekday/relative phrasing. OMIT both if the user said no fixed time ("open invite", "whenever").' },
        flexible_time: { type: 'boolean', description: 'Set true when the user explicitly says no fixed time — "come when you\'re ready", "open invite", "whenever works". Omit or false when a specific time is set.' },
        group:         { type: 'string', description: 'The contact group this plan is for ("my favorite mamas"). Its members are invited, and anyone added to the group later is caught up on it automatically.' },
        tentative:     { type: 'boolean', description: 'true while the group is still working out details (dates, where to stay, who\'s in) — e.g. a trip being planned. Use the best-known dates. Set false with update_event once it\'s settled.' },
        duration_mins: { type: 'number', description: 'Length in minutes. A weekend trip Fri–Sun is about 2880.' },
        notes:         { type: 'string' },
        event_type:    { type: 'string', enum: ['private', 'public'], description: '"private" (default) = user is hosting their own event. "public" = ONLY use this if the user explicitly says to make it public or open to anyone beyond their contacts — e.g. "make this public", "share this openly", "anyone can join". Do NOT infer public just because the venue is a public place.' },
        contact_ids:   { type: 'array', items: { type: 'string' }, description: 'Contacts to invite (must be Tier 1+)' },
      },
      required: ['title', 'activity_type'],
    },
  },
  {
    name: 'update_event',
    description: 'Update a social event YOU are hosting — use this after agent-to-agent negotiation to lock in an agreed time, add a time window note, or update venue/notes. Call this once invitee\'s agent confirms a time works. You can only update events you host.',
    input_schema: {
      type: 'object',
      properties: {
        event_id:      { type: 'string', description: 'ID of the event to update' },
        scheduled_at:  { type: 'string', description: 'New ISO 8601 datetime once a specific time is agreed (e.g. "2026-07-17T19:00:00-04:00")' },
        flexible_time: { type: 'boolean', description: 'Set false once a specific time is agreed; leave true if still a window/range' },
        notes:         { type: 'string', description: 'Free-text: time window agreed ("Sean arriving 7–9pm"), special context, etc.' },
        venue_name:    { type: 'string', description: 'Update venue if agreed during negotiation' },
        tentative:     { type: 'boolean', description: 'false once the plan is settled (dates/place agreed); true if it\'s back to being figured out' },
        title:         { type: 'string' },
        duration_mins: { type: 'number' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'get_event_rsvp_status',
    description: "Get the current RSVP status for a social event.",
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
      },
      required: ['event_id'],
    },
  },
  desires.TOOL_DEFINITION,
  desires.DELETE_TOOL_DEFINITION,

  {
    name: 'whats_happening',
    description: [
      'Answer "what\'s happening tonight?" or "what\'s going on this weekend?"',
      'Aggregates ambient social signals from contacts\' agents (who broadcast intent without revealing specifics),',
      'then fetches popular venue suggestions for the active categories.',
      'Never reveals who specifically is going where — only that there\'s interest in a category + area.',
      'Use when the user asks what friends are up to, what\'s going on tonight, or similar.'
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' }
      },
      required: []
    }
  },

  {
    name: 'store_pending_confirm',
    description: 'Store a booking/venue confirmation that needs user approval before proceeding. The next SMS from the user (yes/no) will resolve it.',
    input_schema: {
      type: 'object',
      properties: {
        summary:  { type: 'string', description: 'What the user is approving' },
        payload:  { type: 'object', description: 'Structured data to act on when approved' },
      },
      required: ['summary', 'payload'],
    },
  },
  {
    name: 'get_user_location',
    description: "Get the user's current city/region. Use this when looking up local events, venues, or anything location-specific.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_user_location',
    description: "Update the user's city. Use when the user tells you they've moved or mentions a different city.",
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City or region name' },
      },
      required: ['city'],
    },
  },
  {
    name: 'get_weather_forecast',
    description: 'Daily forecast for a place for the next 16 days: high/low °F, chance of rain/snow, conditions, and which nights hit freezing. Use it for any plan outdoors or travel ("will it freeze at Grover Hot Springs this weekend?"). Each day comes back with its weekday and date already labelled — use those labels, never compute weekdays yourself.',
    input_schema: {
      type: 'object',
      properties: {
        place:     { type: 'string', description: 'Town, park or address, e.g. "Grover Hot Springs State Park, CA" or "Markleeville, CA"' },
        latitude:  { type: 'number', description: 'Optional, if you know it' },
        longitude: { type: 'number', description: 'Optional, if you know it' },
      },
    },
  },
];

// Offered ONLY when answering another agent (agent_query). 2026-10-09: Allie and Melanie
// were texted their agent's reasoning ("I don't have an active event … Let me ask her
// directly: ---") because the final text of an agent_query turn went to the user. Now the
// final text of those turns goes nowhere; what reaches the user is only this tool's message.
const TELL_MY_USER_TOOL = {
  name: 'tell_my_user',
  description: 'ONLY while answering another agent: pass something to YOUR user — a plan or question from their friend that they should decide on. `message` is exactly what your user will read: short, friendly, plain text, naming the friend ("Sean says Grover Hot Springs may drop to 29°F Saturday night — heated cabin or different dates?"). No reasoning, no mention of agents or snapshots. Your final text in this turn is shown to no one.',
  input_schema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'What your user reads. Plain text, no markdown.' },
    },
    required: ['message'],
  },
};

// ── Tool execution (all scoped to userId) ─────────────────────────────────────

// Returns a short, friendly status line shown in the chat UI while a tool runs.
// Keep these concise — they appear as ephemeral status text under the typing dots.
function toolStatusLine(toolName, input) {
  switch (toolName) {
    case 'add_contact':            return `Adding ${input.name || 'contact'}…`;
    case 'update_contact':         return `Updating contact…`;
    case 'lookup_contact':         return `Looking up contact…`;
    case 'get_relationships':      return `Checking your contacts…`;
    case 'get_contact_preferences':return `Checking preferences…`;
    case 'get_private_preferences':return `Checking private notes…`;
    case 'update_preferences':     return `Saving your preferences…`;
    case 'manage_avoid_list':      return `Updating your private settings…`;
    case 'share_plan':             return `Sharing your plans…`;
    case 'get_weather_forecast':   return `Checking the forecast…`;
    case 'clear_my_plans':         return `Clearing your plans…`;
    case 'check_friends_plans':    return `Checking what your friends have shared…`;
    case 'manage_contact_group':   return `Managing contact group…`;
    case 'create_invite':          return `Sending invite…`;
    case 'draft_contact_message':  return `Drafting message…`;
    case 'send_logistics_sms':     return `Sending message…`;
    case 'message_agent':          return `Checking in with ${input.contact_name || "your friend"}'s agent…`;
    case 'reply_agent':            return `Replying to agent…`;
    case 'get_contact_hard_constraints': return `Checking hard constraints…`;
    case 'request_private_sharing': return `Asking you to confirm sharing…`;
    case 'revoke_private_sharing':  return `Updating what's shared…`;
    case 'check_invitee_locations':return `Checking everyone's locations…`;
    case 'confirm_coordination_invite': return `Confirming coordination…`;
    case 'record_rsvp':            return `Recording RSVP…`;
    case 'save_agent_note':        return `Saving note…`;
    case 'check_contact_consent':  return `Checking consent settings…`;
    case 'create_social_event':    return `Creating event…`;
    case 'update_event':           return `Updating event…`;
    case 'get_event_rsvp_status':  return `Checking RSVPs…`;
    case 'get_pending_invites':    return `Checking your invites…`;
    case 'parse_desires':          return `Thinking about what you want…`;
    case 'get_importable_contacts':return `Checking importable contacts…`;
    case 'get_contact_import_url': return `Getting import link…`;
    default:                       return null; // no status for unknown tools
  }
}

// Unanswered questions other users' agents sent to this user (newest first, last 7 days).
function openQuestionsFor(userId) {
  try {
    return db._raw().prepare(`
      SELECT am.id, substr(am.body, 1, 300) AS body, u.name AS from_name
      FROM agent_messages am JOIN users u ON u.id = am.from_user
      WHERE am.to_user = ? AND am.kind = 'query' AND am.processed = 0
        AND am.created_at > strftime('%s','now') - 7 * 86400
      ORDER BY am.created_at DESC LIMIT 5`).all(userId)
      .map((q) => ({ ...q, from_name: String(q.from_name || 'A friend').split(/\s+/)[0] }));
  } catch (_) { return []; }
}

// A contact_id must be a real contact of THIS user. The model has invented ids from names
// ("sean-gonzalez", "aphilos") — the draft tool accepted them and the send failed, and
// another user's contact id must never be usable. The error tells the model how to recover.
function ownContact(userId, contactId) {
  const contact = contactId ? db.getContact(contactId) : null;
  if (!contact || contact.invited_by_user_id !== userId) {
    return {
      error: 'CONTACT_NOT_FOUND',
      action_status: 'NOT_SENT',
      message: `No contact with id "${contactId}". Never guess ids — call lookup_contact with the person's name and use the "id" it returns, then retry.`,
    };
  }
  return contact;
}

// What the agent needs to know about a contact, computed from the database — not from
// the contact's `tier`, which goes stale (2026-10-08: Bam Bam had been a ButterflAI user
// since July but was "Tier 0" in Sean's contacts, so the agent kept saying he hadn't
// joined and couldn't be messaged).
function describeContact(c) {
  const onButterflai = !!(c.phone && db.getUserByPhone(c.phone));
  const optedOut = !!(c.phone && db.isOptedOut(c.phone));
  return {
    id: c.id, name: c.name, nickname: c.nickname || undefined, phone: c.phone,
    on_butterflai: onButterflai,
    how_to_reach: onButterflai
      ? 'On ButterflAI — to ask or tell them anything, use send_logistics_sms (they get it in the app).'
      : optedOut
        ? 'Opted out of texts from ButterflAI — cannot be messaged.'
        : 'Not on ButterflAI — send_logistics_sms texts them (first message: is_first_contact true).',
  };
}

// Tools whose text goes to another person or agent → checked by links.checkOutbound.
const OUTBOUND_TEXT_FIELDS = {
  send_logistics_sms: 'message', draft_contact_message: 'message',
  message_agent: 'message', reply_agent: 'body',
};

// The user explicitly asked for a TEXT ("text her now", "send him a text", "by SMS").
// Honoured in code — not left to the model to remember (2026-10-09).
const USER_ASKED_TEXT = /\b(text (?:her|him|them|it|me)|send (?:her|him|them) a text|by text|via text|over text|as a text|sms)\b/i;
let currentTurn = null; // { userText } for the turn being processed (tick is sequential)

// Tools that persist what the user says in plain text. Refused while private mode is on.
const PLAINTEXT_WRITE_TOOLS = ['update_preferences', 'save_agent_note'];

async function executeTool(toolName, toolInput, userId, userPhone) {
  if (_toolObserver) {
    try { _toolObserver(toolName, toolInput, userId); } catch (_) { /* observer must never break the agent */ }
  }
  // Every contact id, in every tool, must be one of this user's contacts — checked once,
  // here. The model has repeatedly invented ids ("bam_bam_contact_id", "aphilos"), and
  // tools without their own check failed with bare errors or silently skipped them.
  if (toolInput && toolInput.contact_id !== undefined) {
    const c = ownContact(userId, toolInput.contact_id);
    if (c.error) return c;
  }
  if (toolInput && Array.isArray(toolInput.contact_ids)) {
    const bad = toolInput.contact_ids.filter((id) => ownContact(userId, id).error);
    if (bad.length) {
      return {
        error: 'CONTACT_NOT_FOUND', action_status: 'NOT_SENT', invalid_contact_ids: bad,
        message: `Unknown contact id(s): ${bad.join(', ')}. Never guess ids — call lookup_contact with each person's name and use the "id" it returns, then retry.`,
      };
    }
  }

  // Messages to other people can't carry a made-up ButterflAI link or a "[link]"
  // placeholder (2026-10-09: four wrong login links sent to Melanie). Refused here with
  // the real links in the error, so the model can retry correctly.
  const outboundField = OUTBOUND_TEXT_FIELDS[toolName];
  if (outboundField && toolInput && toolInput[outboundField] !== undefined) {
    const chk = links.checkOutbound(toolInput[outboundField]);
    if (!chk.ok) return chk;
  }

  // Private mode is enforced here, not just in the prompt (PRIVACY.md Invariant 7):
  // while it's on, nothing the user says may be written to a plain-text store.
  if (PLAINTEXT_WRITE_TOOLS.includes(toolName) && sensitive.isSensitiveMode(userId)) {
    return {
      error: 'PRIVATE_MODE_ON',
      message: 'Private mode is on — nothing can be saved in plain text. Use store_private_data (or manage_avoid_list for people the user wants to avoid) instead.',
    };
  }
  switch (toolName) {

    case 'share_plan':
      return plans.sharePlan(userId, toolInput);

    case 'clear_my_plans':
      return plans.clearPlan(userId);

    case 'check_friends_plans':
      return plans.checkFriendsPlans(userId, toolInput);

    case 'manage_avoid_list': {
      const { action, contact_id, on_invite } = toolInput;
      if (action === 'list') {
        return { entries: avoid.listAvoid(userId, { context: 'agent list' }).map(e => ({ contact_id: e.contact_id, name: e.name, on_invite: e.on_invite })) };
      }
      if (!contact_id) return { error: 'contact_id is required — look the person up with lookup_contact first' };
      if (action === 'add') return avoid.addAvoid(userId, contact_id, { onInvite: on_invite || 'auto_decline' });
      const entry = avoid.listAvoid(userId, { context: `agent ${action}` }).find(e => e.contact_id === contact_id);
      if (!entry) return { error: 'NOT_ON_AVOID_LIST' };
      if (action === 'remove') return avoid.removeAvoid(userId, entry.id);
      if (action === 'set_policy') return avoid.setPolicy(userId, entry.id, on_invite);
      return { error: `Unknown action: ${action}` };
    }

    case 'add_contact': {
      const contactId = db.upsertContact({
        invited_by_user_id: userId,
        name: toolInput.name,
        phone: toolInput.phone,
        notes: toolInput.notes,
        tier: 0,
      });
      return { added: true, contact_id: contactId, name: toolInput.name };
    }

    case 'update_contact': {
      const allContacts = db.getContactsByUser(userId);
      const target = allContacts.find(c => c.id === toolInput.contact_id);
      if (!target) return { error: 'Contact not found or does not belong to you' };
      const updates = {};
      if (toolInput.name)          updates.name          = toolInput.name.trim();
      if (toolInput.nickname !== undefined) updates.nickname = toolInput.nickname ? toolInput.nickname.trim() : null;
      if (toolInput.also_known_as !== undefined) updates.also_known_as = toolInput.also_known_as ? toolInput.also_known_as.trim() : null;
      if (Object.keys(updates).length === 0) return { error: 'No fields to update' };
      db.updateContact(toolInput.contact_id, updates);
      return { updated: true, contact_id: toolInput.contact_id, ...updates };
    }

    case 'manage_contact_group': {
      const action = toolInput.action;

      if (action === 'list_groups') {
        return { groups: db.getContactGroups(userId) };
      }

      if (action === 'create_or_get') {
        if (!toolInput.group_name) return { error: 'group_name required' };
        const groupId = db.upsertContactGroup(userId, toolInput.group_name.trim(), toolInput.group_emoji);
        const groups = db.getContactGroups(userId);
        const group = groups.find(g => g.id === groupId);
        return { group_id: groupId, group_name: toolInput.group_name, created: true, members: group?.members || [] };
      }

      if (action === 'add_member') {
        if (!toolInput.group_id || !toolInput.contact_id) return { error: 'group_id and contact_id required' };
        // Verify group belongs to this user
        const groups = db.getContactGroups(userId);
        const group = groups.find(g => g.id === toolInput.group_id);
        if (!group) return { error: 'Group not found' };
        // Verify contact belongs to this user
        const contact = db.getContactsByUser(userId).find(c => c.id === toolInput.contact_id);
        if (!contact) return { error: 'Contact not found' };
        const already = db._raw().prepare('SELECT 1 FROM contact_group_members WHERE group_id = ? AND contact_id = ?').get(toolInput.group_id, toolInput.contact_id);
        db.addContactToGroup(toolInput.group_id, toolInput.contact_id);
        const contactName = contact.nickname || contact.name;
        // Joining a group = joining its upcoming plans, with one catch-up (groups.js).
        const catchUp = already ? { caught_up: 0 } : await groupPlans.onMemberAdded(userId, group.id, contact.id);
        return { added: true, contact_name: contactName, group_name: group.name, already_member: !!already || undefined,
          caught_up_on: catchUp.plans, catch_up_via: catchUp.via, note: catchUp.note };
      }

      if (action === 'remove_member') {
        if (!toolInput.group_id || !toolInput.contact_id) return { error: 'group_id and contact_id required' };
        db.removeContactFromGroup(toolInput.group_id, toolInput.contact_id);
        return { removed: true };
      }

      if (action === 'delete_group') {
        if (!toolInput.group_id) return { error: 'group_id required' };
        db.deleteContactGroup(toolInput.group_id, userId);
        return { deleted: true };
      }

      return { error: 'Unknown action' };
    }

    case 'lookup_contact': {
      const q = (toolInput.query || '').toLowerCase().trim();
      const allContacts = db.getContactsByUser(userId);

      // Score each contact (names.js) — "Alex Spargo" matches "Alexandria Spargo".
      const score = (c) => names.matchScore(c, q);

      const rank = (list) => list
        .map(c => ({ ...c, _score: score(c) }))
        .filter(c => c._score > 0)
        .sort((a, b) => b._score - a._score)
        .slice(0, 10);
      let scored = rank(allContacts);
      // No strong match (exact name, phone, or prefix)? Their Google contacts may have
      // changed since the last sync — sync now and look again (2026-10-09: "Alex Spargo"
      // wasn't found; contacts were last imported in June, once).
      let synced = null;
      if (!scored.length || scored[0]._score < 80) {
        synced = await contactsImport.syncGoogle(userId);
        if (synced.synced) scored = rank(db.getContactsByUser(userId));
      }
      const strong = scored.length && scored[0]._score >= 80;
      const status = contactsImport.syncStatus(userId);
      const lastImport = status.last_sync_at || status.last_import_at;
      return {
        contacts: scored.map(describeContact),
        count: scored.length,
        exact_match: !!strong,
        synced_google_contacts: synced?.synced ? `just now (${synced.imported} new)` : undefined,
        tip: strong
          ? 'Results ranked by match quality.'
          : `No exact match for "${toolInput.query}"${scored.length ? ' — these are only partial matches; do NOT assume one of them is the person. Ask your user, or for their number.' : '.'}`
            + (status.connected ? '' : ` Their Google contacts aren't kept in sync${lastImport ? ` (last imported ${new Date(lastImport * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})` : ''} — offer the contacts import link (get_contact_import_url) to turn on syncing, or ask for the person's number.`),
      };
    }

    case 'get_relationships': {
      const rels = db.getRelationshipsByUser(userId);
      const cadences = db.getCadencesByUser(userId);
      const contacts = db.getContactsByUser(userId);
      return { relationships: rels, cadences, contacts };
    }

    case 'get_contact_preferences': {
      const prefs = db.getContactPreferences(toolInput.contact_id);
      return prefs || { message: 'No preferences stored for this contact.' };
    }

    case 'get_private_preferences': {
      const prefs = await readUserPrivateData(userId, toolInput.purpose || 'agent_reasoning', db);
      return prefs || { message: 'No private preferences stored.' };
    }

    case 'create_invite': {
      const { v4: uuidv4 } = require('uuid');
      const token = uuidv4().replace(/-/g, '');
      db.createInvite({ token, created_by_user_id: userId, contact_name: toolInput.contact_name });
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
      return { token, url: `${baseUrl}/invite/${token}` };
    }

    case 'draft_contact_message': {
      const contact = ownContact(userId, toolInput.contact_id);
      if (contact.error) return contact;
      if (toolInput.message_type === 'expressive') {
        // Store pending approval so the next SMS from the user resolves it
        const { v4: uuidv4 } = require('uuid');
        db.createPendingAction({
          id: uuidv4(),
          user_id: userId,
          action_type: 'approve_message',
          payload: {
            contact_id: toolInput.contact_id,
            contact_name: contact?.name || 'your contact',
            draft_text: toolInput.message,
          },
          ttl_secs: 24 * 3600,
        });
      }
      return {
        draft: toolInput.message,
        contact_id: toolInput.contact_id,
        contact_name: contact?.name,
        message_type: toolInput.message_type,
        requires_approval: toolInput.message_type === 'expressive',
        note: toolInput.message_type === 'expressive'
          ? 'Draft stored. The next SMS from the user (yes/no/edited text) will resolve it.'
          : 'Logistics message — can be sent directly via send_logistics_sms.',
      };
    }

    case 'send_logistics_sms': {
      const contact = ownContact(userId, toolInput.contact_id);
      if (contact.error) return contact;
      if (!contact.phone) return { error: 'Contact has no phone number on file' };

      let messageBody = toolInput.message;
      const user = db.getUser(userId);
      // ButterflAI users get it in the app (SMS only as a fallback) — an SMS opt-out
      // doesn't block that. Everyone else can only be reached by text.
      const recipientIsUser = !!db.getUserByPhone(contact.phone);
      if (!recipientIsUser && db.isOptedOut(contact.phone)) return { error: 'Contact has opted out' };

      try {
        // Mandatory self-identify on first contact (§4.2)
        // NOTE: SMS paths go through send(), which enforces the consent gate.
        // If the contact has not opted in, ConsentRequired is thrown and caught below.
        if (toolInput.is_first_contact && !recipientIsUser) {
          await sms.sendContactInvite(
            contact.phone,
            contact.name,
            user.name,
            'scheduling coordination',
            messageBody
          );
          return { action_status: 'MESSAGE_SENT', sent: true, delivered_via: 'sms', to: contact.phone, contact_name: contact.name };
        }
        // In the app for ButterflAI users, by text otherwise — always naming the sender
        // ("Allie's ButterflAI: …"), with a "📤 To …" card in this user's chat.
        // Texted right away if the user asked for a text in this turn (their words, checked
        // in code) or via:"text"; deliver.js also texts people who can't see it in the app.
        const forceText = toolInput.via === 'text' || USER_ASKED_TEXT.test(currentTurn?.userText || '');
        return await deliver.deliverToContact({ fromUser: user, contact, message: messageBody, forceText });
      } catch (err) {
        if (err instanceof ConsentRequired) {
          // Contact has not opted in — return an assisted-compose fallback.
          // The user must send first-touch from their own device.
          const encodedBody = encodeURIComponent(messageBody);
          const smsLink = `sms:${contact.phone}?body=${encodedBody}`;
          return {
            action_status: 'NOT_SENT_CONSENT_REQUIRED',
            sent: false,
            reason: 'consent_required',
            IMPORTANT: 'DO NOT tell the user the message was sent. It was NOT sent.',
            contact_name: contact.name,
            contact_phone: contact.phone,
            sms_link: smsLink,
            draft: messageBody,
            instruction: `${contact.name} hasn't opted in to receive messages from ButterflAI yet. ` +
              `Send this first message from your own phone: tap the link or copy the draft. ` +
              `Once they reply and opt in, I can handle coordination automatically.`,
          };
        }
        throw err;
      }
    }

    case 'message_agent': {
      const { contact_id, topic, message: agentMsg, thread_id, event_id } = toolInput;
      // Coordinating a plan means there IS a plan: the event exists so it shows on Home and
      // calendars and RSVPs are tracked (2026-10-09: the Grover trip was coordinated across
      // three people's agents and never created). Enforced here, not left to the prompt.
      if (topic === 'coordination') {
        const ev = event_id ? db._raw().prepare('SELECT host_user_id FROM social_events WHERE id = ?').get(event_id) : null;
        const invited = ev && ev.host_user_id !== userId && db._raw().prepare(`
          SELECT 1 FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
          WHERE ei.event_id = ? AND c.phone = ?`).get(event_id, db.getUser(userId)?.phone);
        if (!ev || (ev.host_user_id !== userId && !invited)) {
          return { error: 'CREATE_EVENT_FIRST', action_status: 'NOT_SENT',
            message: 'Coordination needs the event it is about. Create it with create_social_event (tentative: true if dates or details are still open, contact_ids = everyone involved), then call message_agent again with event_id.' };
        }
      }
      const contact = db.getContact(contact_id);
      if (!contact?.phone) return { error: 'Contact not found' };
      const targetUser = db.getUserByPhone(contact.phone);
      if (!targetUser) return { error: 'Contact is not a ButterflAI user — they need to sign up first', contact_name: contact.name };
      // They deferred on this plan: don't bother them — here's their answer (defer.js).
      const deferred = event_id && defer.deferralFor(event_id, targetUser.id);
      if (deferred) {
        return { action_status: 'NOT_SENT_DEFERRED', sent: false, answer: deferred.answer,
          note: `${contact.name} deferred on this plan — that is their answer. Don't ask them about it; ask the people they defer to.` };
      }
      const msgId = db.sendAgentMessage({
        fromUserId: userId, toUserId: targetUser.id,
        threadId: thread_id || event_id, kind: 'query', topic, body: agentMsg,
      });
      // Queue message for target agent to process
      const senderUser = db.getUser(userId);
      db.storeInboundMessage({
        from_phone: targetUser.phone, from_type: 'user', from_id: targetUser.id,
        channel: 'agent_query', text: `[Agent query from ${senderUser?.name || userId}'s agent | thread=${msgId} | topic=${topic}] ${agentMsg}`,
      });
      return { sent: true, message_id: msgId, to: contact.name, note: 'Their agent will respond; watch for reply_received in next turns' };
    }

    case 'reply_agent': {
      const { message_id, body: replyBody } = toolInput;
      const original = db._raw().prepare('SELECT * FROM agent_messages WHERE id = ?').get(message_id);
      // Only a question addressed to THIS user's agent can be answered by it.
      if (!original || original.to_user !== userId) return { error: 'Message not found' };
      // Answer once. (2026-10-08: Bam Bam's agent replied twice to the same question.)
      if (original.processed) {
        return { error: 'ALREADY_REPLIED', message: 'You already answered this message. Do not reply again.' };
      }
      const replyId = db.sendAgentMessage({
        fromUserId: userId, toUserId: original.from_user,
        threadId: original.thread_id, kind: 'reply', topic: original.topic, body: replyBody,
      });
      db.markAgentMessageProcessed(message_id);
      // Deliver reply to originating agent's queue
      const sender = db.getUser(original.from_user);
      if (sender) {
        db.storeInboundMessage({
          from_phone: sender.phone, from_type: 'user', from_id: sender.id,
          channel: 'agent_reply',
          // executeTool has no `user` in scope — referencing it threw AFTER the reply was
          // stored, so the asker never got it and the model retried (Bam Bam's double
          // reply, 2026-10-08). Resolve the replier locally, as message_agent does.
          text: `[Agent reply from ${db.getUser(userId)?.name || 'their'}'s agent | thread=${original.thread_id} | topic=${original.topic}] ${replyBody}`,
        });
      }
      return { replied: true, reply_id: replyId };
    }

    case 'tell_my_user': {
      const turn = currentTurn || {};
      if (turn.channel !== 'agent_query') {
        return { error: 'NOT_AVAILABLE', message: 'Only for passing another agent\'s plan or question to your user. Just reply normally.' };
      }
      if (turn.toldUser) return { error: 'ALREADY_TOLD', message: 'You already passed this to your user. Do not send it again.' };
      const text = sms.toPlainSms(String(toolInput.message || '').trim()).slice(0, 600);
      if (!text) return { error: 'EMPTY_MESSAGE' };
      // Someone your user avoids doesn't get to put things in front of them.
      const asker = turn.askerId ? db.getUser(turn.askerId) : null;
      if (asker?.phone && avoid.findByPhone(avoid.listAvoid(userId), asker.phone)) {
        return { delivered: false, note: 'Not passed on. Answer the other agent with reply_agent that your user isn\'t available.' };
      }
      turn.toldUser = true;
      db.appendConversation(userId, 'assistant', text);
      const online = sse.push(userId, { role: 'assistant', text, ts: Math.floor(Date.now() / 1000) });
      const r = await deliver.notifySelf(db.getUser(userId), text, { online });
      return { delivered: true, via: r.via, event_id: turn.threadEvent || undefined, note: 'Your user has it. When they answer (in a later message), the question is listed under "Open questions from friends\' ButterflAIs" — reply with reply_agent then.' };
    }

    case 'defer_on_plan': {
      return defer.deferOnPlan(userId, toolInput);
    }

    case 'store_private_data': {
      const { data_key, value, category } = toolInput;
      // Validate the key shape: it becomes a label in confirmation SMSes, so no injection
      // characters and a bounded length. Dotted lowercase segments, e.g. "health.sti_status".
      if (typeof data_key !== 'string' || !/^[a-z0-9]+(\.[a-z0-9_]+)*$/i.test(data_key) || data_key.length > 64) {
        return { error: 'INVALID_DATA_KEY', message: 'data_key must be short and of the form "category.name" (letters, digits, underscores, dots).' };
      }
      return sensitive.storePrivateData(userId, data_key, value, category);
    }

    case 'update_preferences': {
      const input = { ...toolInput };

      // health_safety_notes is HEALTH-category sensitive data — it must NEVER be written to
      // plaintext user_preferences (PRIVACY.md Invariant 1). Decide the health action, then
      // remove the field so it can never reach db.upsertPreferences.
      const hasHealthField = Object.prototype.hasOwnProperty.call(input, 'health_safety_notes');
      const healthValue = typeof input.health_safety_notes === 'string' ? input.health_safety_notes.trim() : '';
      delete input.health_safety_notes;

      // Safety net on the remaining fields FIRST. If they're sensitive, reject the WHOLE call
      // BEFORE committing the health note — no partial commit.
      const allValues = Object.values(input).filter(v => typeof v === 'string').join(' ');
      const check = sensitive.classifyText(allValues);
      if (check.sensitive) {
        return {
          error: 'SENSITIVE_DATA_DETECTED',
          message: 'This data appears sensitive. Use store_private_data with the appropriate category instead of update_preferences.',
          detected_category: check.category,
        };
      }

      // Apply the health action: a non-empty value stores (encrypted); an explicit empty /
      // whitespace value CLEARS it, so "delete my health note" actually deletes.
      let healthAction = null;
      if (hasHealthField) {
        if (healthValue) {
          sensitive.storePrivateData(userId, sensitive.HEALTH_NOTES_KEY, healthValue, 'HEALTH');
          healthAction = 'health_safety_notes (encrypted)';
        } else {
          sensitive.deletePrivateData(userId, sensitive.HEALTH_NOTES_KEY);
          healthAction = 'health_safety_notes (cleared)';
        }
      }

      // Only touch prefs if there are non-health fields (upsertPreferences can't build an
      // empty UPDATE — and a health-only call has nothing left to write here).
      if (Object.keys(input).length > 0) db.upsertPreferences(userId, input);
      return { saved: true, fields: [...Object.keys(input), ...(healthAction ? [healthAction] : [])] };
    }

    case 'get_contact_hard_constraints': {
      // Agent-to-agent: fetch only hard constraints (allergies, diet) for a contact who is a user
      // Never exposes soft preferences or private notes
      // Health/safety notes ONLY if the contact has explicitly approved sharing them (health_sharing_approved=1)
      const contact = db.getContact(toolInput.contact_id);
      if (!contact?.phone) return { error: 'Contact not found or no phone' };
      // Scope to the requester's OWN address book — never resolve another user's contact_id.
      if (contact.invited_by_user_id !== userId) return { error: 'Contact not in your address book' };
      const contactUser = db.getUserByPhone(contact.phone);
      if (!contactUser) return { is_butterflai_user: false, note: 'Contact is not a ButterflAI user — ask them directly' };
      // Don't gate the private-data sharing check behind having a prefs row — a contact may
      // have an (encrypted) health note but no user_preferences row.
      const contactPrefs = db.getPreferences(contactUser.id) || {};
      const result = {
        is_butterflai_user: true,
        constraints_known: true,
        food_allergies: contactPrefs.food_allergies || [],
        dietary_restrictions: contactPrefs.dietary_restrictions || [],
        // Deliberately omit: vibe, budget, soft preferences — those are private
      };
      // Health/safety notes are PRIVATE. Consent is PER-EDGE (PRIVACY.md Invariant 2): the
      // contact must have approved sharing this datum with THIS requesting user specifically —
      // not a global toggle. readPrivateDataForSharing enforces the per-record approved list
      // and logs the attempt. (health_sharing_approved is deprecated as a gate.)
      const shared = sensitive.readPrivateDataForSharing(contactUser.id, sensitive.HEALTH_NOTES_KEY, userId);
      if (shared.allowed) {
        result.health_safety_notes = shared.value;
        result.health_sharing_note = 'Contact approved sharing this with you';
      } else if (shared.reason === 'not_approved') {
        // The note exists but is not shared with you — surface only that it exists, never the
        // value, so your agent knows to ask the user to request it.
        result.health_safety_notes = null;
        result.health_sharing_note = 'Contact has health info on file but has not approved sharing it with you — their agent must ask them first';
      }
      // reason 'not_found' → contact has no health note on file; say nothing about it.
      return result;
    }

    case 'request_private_sharing': {
      // Code-gated consent: the agent can only REQUEST a share. The grant happens in
      // handlePendingAction when the user replies YES (matched in code, not by the LLM), so a
      // prompt-injected or over-eager agent can never silently share sensitive data.
      const contact = db.getContact(toolInput.contact_id);
      if (!contact?.phone) return { error: 'Contact not found or no phone' };
      if (contact.invited_by_user_id !== userId) return { error: 'Contact not in your address book' };
      const contactUser = db.getUserByPhone(contact.phone);
      if (!contactUser) return { error: 'Contact is not a ButterflAI user — nothing to share agent-to-agent' };
      if (!sensitive.hasPrivateData(userId, toolInput.data_key)) {
        return { error: 'No such private item on file', data_key: toolInput.data_key };
      }
      if (sensitive.listSharingApprovals(userId, toolInput.data_key).includes(contactUser.id)) {
        return { already_shared: true, data_key: toolInput.data_key, contact: contact.name };
      }
      const { v4: uuidv4 } = require('uuid');
      const safeName = _safeForSms(contact.name, 32);
      const label    = _safeForSms(humanizePrivateKey(toolInput.data_key), 40);
      db.createPendingAction({
        id: uuidv4(),
        user_id: userId,
        action_type: 'approve_share',
        payload: { data_key: toolInput.data_key, contact_id: contact.id, contact_user_id: contactUser.id, contact_name: safeName },
        ttl_secs: 3600, // short window — a share confirmation must not linger
      });
      // System-composed prompt, sanitized so an attacker-chosen name/key can't reframe it.
      // Confirm word is SHARE (not a bare "yes") so a casual affirmative meant for another
      // prompt cannot grant a share.
      await sms.notifyUser(userPhone,
        `🔒 Share your "${label}" with ${safeName}? This lets their ButterflAI factor it in. Reply SHARE to confirm, or NO to keep it private.`
      ).catch(() => {});
      return { confirmation_requested: true, contact: safeName, note: 'Asked the user to reply SHARE to confirm — nothing shared yet.' };
    }

    case 'revoke_private_sharing': {
      const contact = db.getContact(toolInput.contact_id);
      if (!contact?.phone) return { error: 'Contact not found or no phone' };
      if (contact.invited_by_user_id !== userId) return { error: 'Contact not in your address book' };
      const contactUser = db.getUserByPhone(contact.phone);
      if (!contactUser) return { revoked: false, note: 'Contact is not a ButterflAI user' };
      const ok = sensitive.revokeSharing(userId, toolInput.data_key, contactUser.id);
      return { revoked: ok, data_key: toolInput.data_key, contact: contact.name };
    }

    case 'check_invitee_locations': {
      // Haversine distance in km between two lat/lng points
      function haversineKm(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }
      const NEARBY_KM = 80; // ~50 miles — close enough for flexible/open invite

      const hostUser = db.getUser(userId);
      const hostLat = hostUser?.lat, hostLng = hostUser?.lng;

      const results = (toolInput.contact_ids || []).map(cid => {
        const contact = db.getContact(cid);
        if (!contact) return { contact_id: cid, error: 'not found' };
        const contactUser = contact.phone ? db.getUserByPhone(contact.phone) : null;
        // Respect share_location preference — 0 means hidden from other agents
        const sharesLocation = !contactUser || contactUser.share_location !== 0;
        const city = sharesLocation ? (contactUser?.city || null) : null;
        const lat = sharesLocation ? contactUser?.lat : null;
        const lng = sharesLocation ? contactUser?.lng : null;
        let distance_km = null, is_nearby = null;
        if (hostLat && hostLng && lat && lng) {
          distance_km = Math.round(haversineKm(hostLat, hostLng, lat, lng));
          is_nearby = distance_km <= NEARBY_KM;
        }
        return {
          contact_id: cid,
          name: contact.nickname || contact.name,
          is_butterflai_user: !!contactUser,
          city: sharesLocation ? (city || 'unknown') : 'hidden (user paused location sharing)',
          distance_km,
          is_nearby,
        };
      });

      const known = results.filter(r => r.distance_km !== null);
      const allNearby   = known.length > 0 && known.every(r => r.is_nearby);
      const anyNearby   = known.some(r => r.is_nearby);
      const anyDistant  = known.some(r => !r.is_nearby);
      const anyUnknown  = results.some(r => r.distance_km === null);

      let routing_recommendation;
      if (!hostLat || !hostLng) {
        routing_recommendation = 'host_location_unknown — ask user to set their location in Settings, then re-check';
      } else if (allNearby && !anyUnknown) {
        routing_recommendation = 'flexible — all invitees are nearby; open invite works, no need to coordinate a specific time';
      } else if (anyDistant || anyUnknown) {
        routing_recommendation = anyNearby
          ? 'mixed — some nearby (flexible invite ok), some distant or unknown (coordinate time via message_agent)'
          : 'coordinate — invitees are distant or location unknown; agree on a specific time via message_agent';
      } else {
        routing_recommendation = 'coordinate — location data incomplete; use message_agent to check availability';
      }

      return { invitees: results, routing_recommendation, nearby_threshold_km: NEARBY_KM };
    }

    case 'confirm_coordination_invite': {
      const { invitation_id, status, add_to_calendar } = toolInput;
      // executeTool only receives userId — resolve the acting user (and their tz)
      // locally, same idiom as the message_agent case. Referencing a bare `user`
      // here previously threw ReferenceError, aborting before the host was notified.
      const user = db.getUser(userId);
      const userTimezone = user?.timezone || 'America/Los_Angeles';
      const inv = db._raw().prepare(`
        SELECT ei.*, se.title, se.activity_type, se.scheduled_at, se.venue_name,
               se.host_user_id, se.id as event_id
        FROM event_invitations ei
        JOIN social_events se ON se.id = ei.event_id
        WHERE ei.id = ?
      `).get(invitation_id);
      if (!inv) return { error: 'Invitation not found' };

      // Update RSVP status
      db._raw().prepare(`
        UPDATE event_invitations SET status = ?, responded_at = strftime('%s','now') WHERE id = ?
      `).run(status, invitation_id);

      // Add to this user's own calendar if requested
      let calendarResult = null;
      if (add_to_calendar && status === 'accepted') {
        try {
          const startISO = new Date(inv.scheduled_at * 1000).toISOString();
          const endISO = new Date((inv.scheduled_at + 3600) * 1000).toISOString();
          calendarResult = await calendar.createEvent(userId, {
            summary: inv.title,
            description: `Invited by ${db.getUser(inv.host_user_id)?.name || 'a friend'} via ButterflAI`,
            start: { dateTime: startISO, timeZone: userTimezone },
            end: { dateTime: endISO, timeZone: userTimezone },
          });
        } catch (err) {
          calendarResult = { error: err.message };
        }
      }

      // Notify the host's agent (agent-to-agent: share only RSVP result, not private prefs).
      // Queued as an inbound_message so the host's agent proactively texts the host.
      // Shared with avoid-list auto-declines so both look identical to the host.
      const host = db.getUser(inv.host_user_id);
      if (host) multiparty.queueHostRsvpNotice(inv, user, status);
      // The user has now decided, so the invite no longer waits on them.
      db._raw().prepare('UPDATE event_invitations SET needs_owner_decision = 0 WHERE id = ?').run(invitation_id);

      const calFailed = calendarResult?.error;
      return {
        action_status: 'RSVP_CONFIRMED',   // RSVP is done regardless of calendar
        rsvp_status: status,
        host_notified: !!host,
        calendar: calendarResult && !calFailed
          ? 'added'
          : add_to_calendar
            ? `not_added — ${calFailed || 'calendar not connected'} — RSVP still confirmed`
            : 'skipped',
        instruction: 'RSVP is confirmed. If calendar was not added, offer to connect calendar as a separate follow-up. Do NOT report this as a failure or ask the user to retry the RSVP.',
      };
    }

    case 'record_rsvp': {
      const { event_id, contact_phone, status, source } = toolInput;
      // Only on events this user hosts, for this user's own contacts (it used to accept
      // any event_id and any contact row with that phone).
      const ev = db._raw().prepare('SELECT host_user_id FROM social_events WHERE id = ?').get(event_id);
      if (!ev || ev.host_user_id !== userId) return { error: 'EVENT_NOT_FOUND', message: 'Use an eventId of an event you host (from Open events).' };
      const phone = toE164(contact_phone) || contact_phone;
      const contact = db.getContactsByUser(userId).find((c) => c.phone === phone);
      if (!contact) return { error: 'Contact not found' };
      // Upsert invitation record
      const existing = db._raw().prepare(
        'SELECT id FROM event_invitations WHERE event_id = ? AND contact_id = ?'
      ).get(event_id, contact.id);
      if (existing) {
        db._raw().prepare(
          'UPDATE event_invitations SET status = ?, responded_at = strftime(\'%s\',\'now\') WHERE id = ?'
        ).run(status, existing.id);
      } else {
        const { v4: uuidv4 } = require('uuid');
        db._raw().prepare(
          'INSERT INTO event_invitations (id, event_id, contact_id, status, responded_at) VALUES (?, ?, ?, ?, strftime(\'%s\',\'now\'))'
        ).run(uuidv4(), event_id, contact.id, status);
      }
      db.appendConversation(userId, 'assistant',
        `[System] RSVP recorded (${source || 'out of band'}): ${contact.name} has ${status} the event.`
      );
      return { action_status: 'RSVP_RECORDED', contact: contact.name, status, source };
    }

    case 'save_agent_note': {
      const current = user.agent_notes || '';
      const timestamp = new Date().toISOString().slice(0, 10);
      const updated = [current, `[${timestamp}] ${toolInput.note}`].filter(Boolean).join('\n');
      db.updateUser(userId, { agent_notes: updated });
      return { saved: true, note: toolInput.note };
    }

    case 'check_contact_consent': {
      const contact = db.getContact(toolInput.contact_id);
      if (!contact) return { error: 'Contact not found' };
      const hasConsent = contact.phone ? db.hasConsent(contact.phone) : false;
      return {
        contact_name: contact.name,
        has_consent: hasConsent,
        can_receive_messages: hasConsent && !db.isOptedOut(contact.phone),
        note: hasConsent
          ? 'This contact has opted in — you can send via send_logistics_sms.'
          : 'This contact has NOT opted in yet. Do NOT use send_logistics_sms. Instead, use send_contact_invite to send them a first-touch invite with self-identify header.',
      };
    }

    case 'get_contact_import_url': {
      const baseUrl = process.env.BASE_URL || 'https://butterflai.social';
      // Signed, expiring links — never a bare userId (linktoken.js, 2026-10-09).
      const sync = contactsImport.syncStatus(userId);
      if (sync.connected) {
        const r = await contactsImport.syncGoogle(userId, { force: true });
        return { google_contacts: 'connected — they stay in sync', synced_now: r.synced ? `${r.imported} new` : undefined };
      }
      return {
        url: `${baseUrl}/auth/google?t=${linktoken.sign(userId, 'google', linktoken.TTL.link)}`,
        other_ways: `${baseUrl}/contacts-import.html?t=${linktoken.sign(userId, 'contacts', linktoken.TTL.link)}`,
        message: 'The url connects Google (Calendar and Contacts in one step) and keeps contacts in sync. other_ways is for contacts not in Google (paste or a .vcf file).',
      };
    }

    case 'get_pending_invites': {
      const invites = db.getPendingInvitesByUser(userId);
      return { invites };
    }

    case 'get_importable_contacts': {
      return { contacts: contactsImport.getImportableContacts(userId) };
    }

    case 'send_contact_invite': {
      const contact = ownContact(userId, toolInput.contact_id);
      if (contact.error) return contact;
      const result = await contactsImport.sendInvite(userId, toolInput.contact_id, toolInput.context);
      return { sent: true, ...result };
    }

    case 'check_calendar_availability': {
      const results = await calendar.checkAvailability(userId, toolInput.slots);
      return { availability: results };
    }

    case 'find_free_slots': {
      return calendar.findFreeSlots(userId, {
        duration_mins: toolInput.duration_mins,
        count: toolInput.count,
        preferred_time: toolInput.preferred_time,
        search_days: toolInput.search_days,
      });
    }

    case 'create_calendar_event': {
      const eventId = await calendar.createEvent(userId, toolInput);
      return { created: true, eventId };
    }

    case 'get_calendar_connect_url': {
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
      const provider = calendar.getCalendarProvider(userId);
      if (provider) return { connected: true, provider, message: `${provider} Calendar already connected.` };
      const requestedProvider = toolInput.provider || 'google';
      const urls = {
        google: `${baseUrl}/auth/google?t=${linktoken.sign(userId, 'google', linktoken.TTL.link)}`,   // Calendar + Contacts in one step
        apple:  `${baseUrl}/auth/apple/calendar?t=${linktoken.sign(userId, 'calendar', linktoken.TTL.link)}`,
      };
      return {
        connected: false,
        provider: requestedProvider,
        url: urls[requestedProvider],
        also_available: requestedProvider === 'google' ? { apple: urls.apple } : { google: urls.google },
        message: `Send this URL to connect ${requestedProvider === 'google' ? 'Google' : 'Apple'} Calendar.`,
      };
    }

    case 'suggest_venues': {
      const result = await venues.suggestVenues(userId, toolInput);
      // Record proposal provenance.
      // TODO(human): use 'user_request' when the user explicitly asked (vs unprompted cadence flow).
      // For now defaulting to 'agent_discovery' — needs upstream context to distinguish reliably.
      await recordProposal(userId, 'agent_discovery', { activityType: toolInput.activity_type });
      return {
        ...result,
        formatted: venues.formatOptionsForSMS(result.options),
      };
    }

    case 'get_venue_favorites': {
      return { favorites: venues.getFavorites(userId) };
    }

    case 'add_venue_favorite': {
      const id = venues.addFavorite(userId, toolInput);
      return { added: true, id };
    }

    case 'create_social_event': {
      const { contact_ids: givenIds, when, group, ...eventData } = toolInput;
      let contact_ids = givenIds;
      // A plan for a group: link it and invite every member (plus anyone named).
      if (group) {
        const { group: g, groups: all } = plans.findGroup(userId, group);
        if (!g) return { error: 'GROUP_NOT_FOUND', message: `No group called "${group}". Groups: ${all.map((x) => x.name).join(', ') || 'none yet'}.` };
        eventData.group_id = g.id;
        contact_ids = [...new Set([...(givenIds || []), ...g.members.map((m) => m.id || m.contact_id).filter(Boolean)])];
      } else if (contact_ids?.length) {
        // Inviting everyone in one of the user's groups makes it that group's plan —
        // inferred in code; the user shouldn't have to say "group plan" (2026-10-09).
        const g = groupPlans.groupCoveredBy(userId, contact_ids);
        if (g) eventData.group_id = g.id;
      }
      // Deterministic date resolution: when the model passes the user's day+time
      // phrase, resolve it server-side in the user's timezone (Haiku is unreliable at
      // date math). This OVERRIDES any scheduled_at the model may have computed.
      let resolvedWhen = null;
      if (when && !eventData.flexible_time) {
        const tz = db.getUser(userId)?.timezone || 'America/New_York';
        resolvedWhen = datetime.resolveEventDateTime(when, tz);
        if (resolvedWhen) eventData.scheduled_at = resolvedWhen.iso;
      }
      const eventId = multiparty.createEvent(userId, eventData);
      let inviteResult = { sent: 0, skipped: 0 };
      if (contact_ids?.length) {
        inviteResult = await multiparty.inviteContacts(eventId, contact_ids);
      }

      // Record proposal provenance for user-initiated event creation.
      // TODO(human): distinguish user_request (explicit ask) from cadence-driven creation.
      // Default origin='user_request' when there is no prior proposal to convert.
      // Try to convert any existing proposal linked to the cadence or event.
      try {
        const cadenceId = eventData.cadence_id || null;
        let converted = false;
        if (cadenceId) {
          // Look for a recent cadence_nudge proposal to convert
          const proposals = db._raw()
            .prepare(`SELECT * FROM proposals WHERE cadence_id = ? AND outcome IS NULL ORDER BY proposed_at DESC LIMIT 1`)
            .get(cadenceId);
          if (proposals) {
            await convertProposal(proposals.id, eventId);
            converted = true;
          }
        }
        if (!converted) {
          // No prior proposal — record a new user_request provenance
          await recordProposal(userId, 'user_request', {
            cadenceId,
            activityType: eventData.activity_type || null,
          });
          // Link it to the event
          const newProposal = db.getProposalByEvent(null); // won't find by event yet
          // Update by fetching latest for this user
          const latest = db._raw()
            .prepare(`SELECT * FROM proposals WHERE user_id = ? AND event_id IS NULL ORDER BY proposed_at DESC LIMIT 1`)
            .get(userId);
          if (latest) {
            db.updateProposalOutcome(latest.id, { outcome: 'converted', event_id: eventId });
          }
        }
      } catch (proposalErr) {
        console.error('[agent] proposal provenance error (non-fatal):', proposalErr.message);
      }

      return {
        action_status: inviteResult.sent > 0 ? 'EVENT_CREATED_INVITES_SENT' : 'EVENT_CREATED_NO_INVITES_SENT',
        eventId,
        invites_sent: inviteResult.sent,
        invites_skipped: inviteResult.skipped,
        // Authoritative date the server scheduled — state THIS weekday+date back to the
        // user verbatim; do not recompute or relabel it.
        scheduled_for: resolvedWhen ? resolvedWhen.label : undefined,
        // Not invited because they're on the user's own avoid list. Tell the user (only
        // the user) and offer to remove them from the list if this was intentional.
        avoided_not_invited: inviteResult.avoided,
        tentative: !!eventData.tentative || undefined,
        group: eventData.group_id ? db.getContactGroups(userId).find((g) => g.id === eventData.group_id)?.name : undefined,
        note: inviteResult.sent > 0
          ? `Invite(s) sent. Contacts can reply YES/NO and their response will be tracked automatically.`
          : `Event created but no invites sent (check contact_ids are valid and contacts aren't opted out).`,
      };
    }

    case 'update_event': {
      const { event_id, scheduled_at, flexible_time, notes, venue_name, tentative, title, duration_mins } = toolInput;
      // Verify ownership — agent can only update events they host
      const evCheck = db._raw().prepare('SELECT id, host_user_id FROM social_events WHERE id = ?').get(event_id);
      if (!evCheck) return { error: 'Event not found' };
      if (evCheck.host_user_id !== userId) return { error: 'You can only update events you host' };
      const updates = {};
      if (scheduled_at !== undefined) {
        updates.scheduled_at = typeof scheduled_at === 'string'
          ? Math.floor(new Date(scheduled_at).getTime() / 1000)
          : scheduled_at;
      }
      if (flexible_time !== undefined) updates.flexible_time = flexible_time ? 1 : 0;
      if (notes !== undefined) updates.notes = notes;
      if (venue_name !== undefined) updates.venue_name = venue_name;
      if (tentative !== undefined) updates.tentative = tentative ? 1 : 0;
      if (title) updates.title = String(title).slice(0, 200);
      if (duration_mins !== undefined && Number(duration_mins) > 0) updates.duration_mins = Math.round(Number(duration_mins));
      if (!Object.keys(updates).length) return { ok: true, note: 'No fields to update' };
      const before = db._raw().prepare('SELECT scheduled_at, venue_name, tentative FROM social_events WHERE id = ?').get(event_id);
      const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      db._raw().prepare(`UPDATE social_events SET ${sets} WHERE id = ?`)
        .run(...Object.values(updates), event_id);
      // People who deferred on this plan get an FYI (not a question) on big changes.
      const tz = db.getUser(userId)?.timezone || 'America/Los_Angeles';
      const changes = [];
      if (updates.scheduled_at && updates.scheduled_at !== before.scheduled_at) {
        changes.push(`the date is now ${new Date(updates.scheduled_at * 1000).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })}`);
      }
      if (updates.venue_name && updates.venue_name !== before.venue_name) changes.push(`it's now at ${updates.venue_name}`);
      if (updates.tentative === 0 && before.tentative) changes.push("it's locked in");
      const fyi = changes.length ? defer.notifyDeferred(event_id, changes.join('; ')) : 0;
      return { ok: true, event_id, updated: Object.keys(updates), fyi_sent_to_deferred: fyi || undefined };
    }

    case 'get_event_rsvp_status': {
      const event = multiparty.getEvent(toolInput.event_id);
      if (!event) return { error: 'Event not found' };
      return {
        event: { title: event.title, scheduled_at: event.scheduled_at, status: event.status },
        rsvp: multiparty.getRsvpSummary(toolInput.event_id),
        invitations: event.invitations,
      };
    }

    case 'parse_desires': {
      return desires.handleParseTool(toolInput, userId);
    }

    case 'whats_happening': {
      // Default to the USER's local calendar date (en-CA → YYYY-MM-DD), not the UTC date.
      // In the evening in a UTC-negative zone, the UTC date is already tomorrow, so
      // "what's happening tonight?" would query the wrong day's ambient signals.
      const whTz    = db.getUser(userId)?.timezone || 'America/Los_Angeles';
      const date    = toolInput.date || new Date().toLocaleDateString('en-CA', { timeZone: whTz });
      const signals = coord.getAmbientSummary(date);

      if (!signals.length) {
        return { date, summary: 'Nothing in the signal yet — no one\'s broadcast intent for tonight.' };
      }

      // Build a venue suggestion for each active category+area
      // (venue names come from our lookup, NOT from the broadcast — severs the identity link)
      const withVenues = await Promise.all(signals.map(async s => {
        let venueOptions = [];
        try {
          const result = await venues.suggestVenues(userId, {
            activity_type: s.category,
            neighborhood:  s.area || undefined
          });
          venueOptions = (result.options || []).slice(0, 3).map(v => v.name);
        } catch { /* venue lookup optional */ }

        return {
          category:       s.category,
          area:           s.area,
          period:         s.period,
          certainty:      s.certainty,
          open_to_company: s.openToCompany,
          count:          s.count,
          venue_suggestions: venueOptions
          // deliberately absent: who, exact venue they mentioned, group size
        };
      }));

      return { date, signals: withVenues };
    }

    case 'delete_desires': {
      // transport is not available in executeTool scope — pass null; cancels are best-effort
      return desires.handleDeleteTool(toolInput, userId, null);
    }

    case 'store_pending_confirm': {
      const { v4: uuidv4 } = require('uuid');
      db.createPendingAction({
        id: uuidv4(),
        user_id: userId,
        action_type: 'confirm_booking',
        payload: { summary: toolInput.summary, ...toolInput.payload },
        ttl_secs: 24 * 3600,
      });
      return { stored: true, note: `Confirmation request stored. Tell the user: "${toolInput.summary} — reply yes to confirm."` };
    }

    case 'get_user_location': {
      const user = db.getUser(userId);
      return {
        city:    user?.city    || null,
        lat:     user?.lat     || null,
        lng:     user?.lng     || null,
        country: user?.country || 'US',
      };
    }

    case 'set_user_location': {
      const { city } = toolInput;
      db.updateUser(userId, { city });
      return { updated: true, city };
    }

    case 'get_weather_forecast':
      return weather.forecast(toolInput);

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Process a single inbound message ─────────────────────────────────────────

/**
 * A contact (someone invited to an event, NOT a registered user) texted
 * ButterflAI. They have no agent of their own, so relay the message to the
 * agent of the user coordinating with them: the host of the most recent event
 * they were invited to (within 7 days), else whoever invited them.
 *
 * Returns a rewritten message addressed to the host's agent (from_id = host,
 * text reframed as a relay), or `null` when no relay target can be resolved.
 * The host's agent then decides how to help — it can reply to the contact via
 * send_logistics_sms, or loop in its own user. This is what makes the router's
 * "I'll pass that along" honest: previously these rows dead-ended here because
 * db.getUser(contact_id) returns nothing.
 */
function resolveContactRelay(msg) {
  const contact = db.getContact(msg.from_id);
  if (!contact) return null;

  let hostUserId = null;
  let eventContext = '';
  try {
    const row = db._raw().prepare(`
      SELECT se.host_user_id, se.title, se.activity_type
      FROM event_invitations ei
      JOIN social_events se ON se.id = ei.event_id
      WHERE ei.contact_id = ? AND ei.notified_at > strftime('%s','now') - 604800
      ORDER BY ei.notified_at DESC LIMIT 1
    `).get(contact.id);
    if (row) {
      hostUserId = row.host_user_id;
      const label = row.title || row.activity_type;
      if (label) eventContext = ` regarding "${label}"`;
    }
  } catch (_) { /* fall back to the inviter below */ }

  // Fallback: the user who invited this contact (contacts.invited_by_user_id is NOT NULL).
  if (!hostUserId) hostUserId = contact.invited_by_user_id;
  if (!hostUserId) return null;

  const who = contact.name || contact.phone || 'a contact';
  const phoneNote = contact.phone ? ` (${contact.phone})` : '';
  const framed =
    `[Relayed SMS from your contact ${who}${phoneNote}${eventContext}. ` +
    `They texted ButterflAI and are NOT a registered ButterflAI user.] ` +
    `Their message: "${msg.text}". Help however makes sense — if it is a logistics ` +
    `question you can answer from the event details, reply to them with ` +
    `send_logistics_sms; otherwise handle it or ask your user for a decision. ` +
    `Never share anyone's private information.`;

  return { ...msg, from_type: 'user', from_id: hostUserId, text: framed };
}

async function processMessage(msg) {
  // Contact relay: a non-user contact texted in. Rewrite the message so it is
  // processed by the host/inviter's agent (see resolveContactRelay). Do this
  // before the getUser lookup below, which only resolves user ids.
  if (msg.from_type === 'contact') {
    const relayed = resolveContactRelay(msg);
    if (!relayed) {
      console.warn(`[agent] contact relay: no host for contact from_id=${msg.from_id}, skipping`);
      db.markMessageProcessed(msg.id);
      return;
    }
    msg = relayed;
  }

  // Agent-to-agent channels: handle silently on behalf of the user where possible.
  if (msg.channel === 'agent') {
    msg = { ...msg, text: `[System notification — inform the user proactively via SMS] ${msg.text}` };
  }
  // agent_query: another agent is asking a question — answer from preferences without bothering the user
  // agent_reply: a reply to something we asked — process and update our state
  // Both arrive as normal messages but the agent knows to handle them autonomously
  console.log(`[agent] processing msg id=${msg.id} from_type=${msg.from_type} channel=${msg.channel||'sms'} text="${(msg.text||'').slice(0,60)}"`);

  const user = db.getUser(msg.from_id);
  if (!user) {
    console.warn(`[agent] No user found for from_id=${msg.from_id}, skipping`);
    db.markMessageProcessed(msg.id);
    return;
  }

  const userId = user.id;
  const userPhone = user.phone;

  // A question about a plan this user deferred on: answered in code — no model call,
  // nothing shown to them (defer.js).
  if (msg.channel === 'agent_query' && defer.handleQuery(msg, userId)) {
    console.log(`[agent] agent_query ${msg.id} answered from deferral for user=${userId}`);
    return;
  }

  // Build live user state snapshot — injected into system prompt so agent
  // always has current context regardless of conversation history window.
  const userTimezone = user.timezone || 'America/Los_Angeles';
  const calendarProvider   = calendar.getCalendarProvider(userId);   // 'google' | 'apple' | null
  const calendarConnected  = !!calendarProvider;
  const prefs = db.getPreferences(userId);
  // agent_query = another user's agent is asking us something, and we compose an
  // outbound reply to them. In that mode private/soft context must NOT enter the
  // snapshot — it is the structural wall that stops it leaking into the peer-facing
  // message. See PRIVACY.md / docs/REARCHITECTURE.md Phase 0. Enforced in code.
  const coordinationOnly = msg.channel === 'agent_query';
  const contactCount = db.getContactsByUser(userId).length;
  const pendingEvents = (() => {
    try {
      const events = multiparty.getEventsByHost(userId).filter(e => e.status === 'open');
      const rows = [];
      for (const e of events) {
        const recency = eventRecency(e.scheduled_at, e.flexible_time);
        if (recency === 'stale') continue;   // long-past events are noise — never surface them as current
        const invitations = db._raw
          ? db._raw().prepare(`
              SELECT c.name, ei.status, ei.defers_to FROM event_invitations ei
              JOIN contacts c ON c.id = ei.contact_id
              WHERE ei.event_id = ?
            `).all(e.id)
          : [];
        const inviteeList = invitations.map(i => i.defers_to
          ? `${i.name} (in — goes with whatever ${defer.joinNames(defer.parseNames(i.defers_to))} decide; don't ask them about it)`
          : `${i.name} (${i.status})`).join(', ') || 'no invitees yet';
        const ts = recency === 'flexible'
          ? 'open invite (no fixed time)'
          : new Date(e.scheduled_at * 1000).toLocaleString('en-US', { timeZone: userTimezone, weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
        const pastTag = recency === 'past' ? '  [ALREADY HAPPENED — do NOT present as upcoming]' : '';
        const tentTag = e.tentative ? ' | TENTATIVE (details still being worked out; "accepted" = interested)' : '';
        rows.push(`  - eventId="${e.id}" | "${e.title}" | ${ts}${pastTag}${tentTag} | invitees: ${inviteeList}`);
      }
      return rows.length ? rows.join('\n') : '  (none)';
    } catch (_) { return '  (none)'; }
  })();

  const userLocalTime = new Date().toLocaleString('en-US', { timeZone: userTimezone, weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const dateContext = buildDateContext(userTimezone);
  // Pending coordination: events this user was invited to by OTHER users' agents
  // Injected so this agent can act on them (update own calendar, notify host agent)
  const pendingCoordination = (() => {
    try {
      // Match on phone, not one contact row: each host has their own contact row for
      // this user, so a single getContactByPhone() lookup missed other hosts' invites.
      const rows = db._raw().prepare(`
        SELECT ei.id as inv_id, ei.status, ei.needs_owner_decision, ei.defers_to, se.id as event_id, se.title,
               se.activity_type, se.scheduled_at, se.venue_name, u.name as host_name
        FROM event_invitations ei
        JOIN contacts c ON c.id = ei.contact_id
        JOIN social_events se ON se.id = ei.event_id
        JOIN users u ON u.id = se.host_user_id
        WHERE c.phone = ? AND se.host_user_id != ? AND COALESCE(se.status, 'open') != 'cancelled'
          AND (ei.notified_at > strftime('%s','now') - 604800 OR se.scheduled_at > strftime('%s','now') - 86400)
        ORDER BY se.scheduled_at LIMIT 8
      `).all(user.phone, userId);
      if (!rows.length) return '';
      const lines = rows.map(r => {
        const ts = new Date(r.scheduled_at * 1000).toLocaleString('en-US', { timeZone: userTimezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const venue = r.venue_name ? ` at ${r.venue_name}` : '';
        const ask = r.needs_owner_decision && r.status === 'invited' ? ' | ⚠ ASK YOUR USER before responding (never say why)' : '';
        const def = r.defers_to ? ` | your user deferred — goes with whatever ${defer.joinNames(defer.parseNames(r.defers_to))} decide` : '';
        return `  - inv_id="${r.inv_id}" | "${r.title}" hosted by ${r.host_name} | ${ts}${venue} | your status: ${r.status}${def}${ask}`;
      }).join('\n');
      return `\n## You have been invited to (by other ButterflAI users)\n${lines}\n- Use confirm_coordination_invite to RSVP and optionally add to your calendar`;
    } catch (_) { return ''; }
  })();

  // Questions friends' agents asked this user that haven't been answered. After
  // tell_my_user passes one on, the user answers in a LATER turn — without this list the
  // agent had no message_id to reply_agent with, and told Allie, Melanie and Bam Bam "I
  // already replied to Sean's agent" when nothing went back (2026-10-09).
  const openQuestions = coordinationOnly ? [] : openQuestionsFor(userId);
  const openQuestionsSection = openQuestions.length
    ? `\n## Open questions from friends' ButterflAIs (your user hasn't answered yet)\n`
      + openQuestions.map((q) => `  - message_id="${q.id}" | from ${q.from_name}'s ButterflAI | "${q.body}"`).join('\n')
      + `\n- If your user's message answers one, call reply_agent with that message_id — it is the ONLY way the answer gets back. Never say you replied unless reply_agent returned replied: true.`
    : '';

  const agentNotes = user.agent_notes?.trim();
  const inSensitiveMode = sensitive.isSensitiveMode(userId);
  const prefsSection = buildPrefsSection(prefs, { coordinationOnly });

  const stateSnapshot = [
    `## Current state`,
    `- User timezone: ${userTimezone} (current local time: ${userLocalTime})`,
    dateContext,
    `- Location: ${user.city ? `${user.city}${user.lat ? ` (${Number(user.lat).toFixed(4)}, ${Number(user.lng).toFixed(4)})` : ''}` : 'unknown — ask user or request browser location'}`,
    `- Calendar: ${calendarConnected ? `✅ connected (${calendarProvider}) — can check availability & create events` : '❌ not connected — offer Google or Apple Calendar setup'}`,
    `- Contacts: ${contactCount} in address book`,
    (() => {
      const groups = db.getContactGroups(userId);
      if (!groups.length) return '- Groups: none yet';
      return '- Groups: ' + groups.map(g => `${g.emoji || ''}${g.name} (${g.members.length})`).join(', ');
    })(),
    coordinationOnly
      ? `\n## ${user.name}'s hard constraints (coordination-only context)\n${prefsSection}`
      : `\n## ${user.name}'s preferences\n${prefsSection}`,
    coordinationOnly ? '' : `\n## Open events\n${pendingEvents}`,
    pendingCoordination,
    openQuestionsSection,
    (agentNotes && !coordinationOnly) ? `\n## Remembered facts (use these — don't ask again)\n${agentNotes}` : '',
  ].filter(Boolean).join('\n');

  // Build system prompt (lean — context comes from tools, not prompt stuffing)
  const systemPrompt = buildSystemPrompt(user, stateSnapshot, { sensitiveMode: inSensitiveMode });

  // Load recent conversation history so the agent has context across SMS turns (continued below)
  // NOTE: processMessage continues after buildSystemPrompt definition
  try {
    return await _processMessageContinue({ msg, user, userId, userPhone, systemPrompt });
  } finally {
    currentTurn = null;   // turn state (e.g. tell_my_user's once-only flag) never leaks to the next call
  }
}

/**
 * Sanitize a string for inclusion in a user-facing confirmation SMS. Strips control chars
 * and any punctuation that could reframe the prompt (parens/brackets/quotes/colons), and
 * caps length — so an attacker-chosen contact name or data_key can't rewrite the meaning.
 */
function _safeForSms(s, maxLen = 40) {
  return String(s || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\p{L}\p{N} .,'&-]/gu, '')  // conservative charset: no ()[]{}<>"":; etc.
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen) || 'your contact';
}

/**
 * Human-readable label for a private data_key, for user-facing confirmation prompts.
 * Sanitized (data_key is agent-chosen and must not be able to inject into the SMS).
 */
function humanizePrivateKey(dataKey) {
  const labels = { 'health.safety_notes': 'health & safety note' };
  if (labels[dataKey]) return labels[dataKey];
  const tail = String(dataKey || '').split('.').pop().replace(/_/g, ' ').trim();
  return _safeForSms(tail, 40) === 'your contact' ? 'private note' : _safeForSms(tail, 40);
}

/**
 * buildPrefsSection — renders a user's preferences for the state snapshot.
 *
 * coordinationOnly=true is used when the agent is answering ANOTHER user's agent
 * (channel === 'agent_query'). In that mode ONLY hard constraints (allergies,
 * dietary restrictions) are rendered — never soft preferences or free-text notes
 * (availability_notes, comm_style, extra_notes, cuisine/activity/vibe/budget/
 * neighborhood). This is a structural wall: private context cannot leak into a
 * message composed for a peer because it never enters the prompt. Enforced in
 * code and verified by tests, NOT by a system-prompt rule. See PRIVACY.md and
 * docs/REARCHITECTURE.md Phase 0.
 *
 * Exported for the test suite.
 */
/**
 * buildDateContext — a deterministic weekday→date table injected into the state
 * snapshot so the agent NEVER has to compute calendar dates itself. Haiku is
 * unreliable at date arithmetic (it repeatedly mislabeled weekdays — e.g. calling
 * Sep 13 "Saturday" — and gave inconsistent dates across messages). Handing it the
 * exact dates removes the arithmetic entirely. `now` is injectable for tests.
 * Exported for the test suite.
 */
function buildDateContext(timezone, now = new Date()) {
  const tz  = timezone || 'America/Los_Angeles';
  const wd  = (d) => d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' });
  const iso = (d) => d.toLocaleDateString('en-CA', { timeZone: tz });   // YYYY-MM-DD in tz
  const timeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });

  const rows = [];
  const firstByWeekday = {};   // weekday name -> soonest matching ISO date
  for (let i = 0; i < 11; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const w = wd(d), date = iso(d);
    const tag = i === 0 ? '  <- TODAY' : i === 1 ? '  <- tomorrow' : '';
    rows.push(`  - ${w} ${date}${tag}`);
    if (firstByWeekday[w] === undefined) firstByWeekday[w] = date;
  }
  const todayW = wd(now), todayISO = iso(now);

  return [
    `\n## Date context — use these EXACT dates; NEVER compute a date yourself`,
    `- Right now it is ${todayW}, ${todayISO}, ${timeStr} (${tz}).`,
    `- "This weekend" = Saturday ${firstByWeekday['Saturday']} and Sunday ${firstByWeekday['Sunday']}.`,
    `- Calendar for the next 10 days (weekday -> date):`,
    ...rows,
    `- When the user names a day ("Friday", "this weekend", "tomorrow", "the 20th"), FIND it in this list and use that exact YYYY-MM-DD in scheduled_at. If they name today's weekday, they mean TODAY unless they say "next". Every message you send about the event MUST use the weekday shown here for the date you picked.`,
  ].join('\n');
}

/**
 * eventRecency — classify an event's time relative to now so the agent never
 * presents a past event as if it's happening tonight. 'flexible' = open invite
 * (no fixed time); 'upcoming' = still in the future; 'past' = happened within the
 * last ~2 days (kept for "did you make it?" follow-ups); 'stale' = long past (noise
 * — excluded from the snapshot). Exported for tests.
 */
function eventRecency(scheduledAt, flexibleTime, now = Date.now()) {
  if (flexibleTime || !scheduledAt) return 'flexible';
  const nowSec = Math.floor(now / 1000);
  if (scheduledAt >= nowSec) return 'upcoming';
  if (scheduledAt >= nowSec - 48 * 3600) return 'past';
  return 'stale';
}

function buildPrefsSection(prefs, { coordinationOnly = false } = {}) {
  if (!prefs) {
    return coordinationOnly
      ? '- No hard dietary constraints on file'
      : '- Preferences: not set yet (ask conversationally to learn them)';
  }
  const parts = [];
  // HARD CONSTRAINTS — safety-critical; the only fields allowed to cross for coordination.
  if (prefs.food_allergies?.length)       parts.push(`⚠️  Allergies: ${prefs.food_allergies.join(', ')}`);
  if (prefs.dietary_restrictions?.length) parts.push(`Diet: ${prefs.dietary_restrictions.join(', ')}`);

  if (coordinationOnly) {
    // Nothing below this line may enter a peer-facing composition.
    return parts.length ? parts.map(p => `- ${p}`).join('\n') : '- No hard dietary constraints on file';
  }

  // SOFT PREFERENCES + free-text notes — only in the user's OWN session, never a peer's.
  if (prefs.cuisine_loves?.length)        parts.push(`Loves: ${prefs.cuisine_loves.join(', ')}`);
  if (prefs.cuisine_avoids?.length)       parts.push(`Avoids: ${prefs.cuisine_avoids.join(', ')}`);
  if (prefs.activity_loves?.length)       parts.push(`Activities: ${prefs.activity_loves.join(', ')}`);
  if (prefs.activity_avoids?.length)      parts.push(`Dislikes: ${prefs.activity_avoids.join(', ')}`);
  if (prefs.vibe?.length)                 parts.push(`Vibe: ${prefs.vibe.join(', ')}`);
  if (prefs.budget_low || prefs.budget_high) parts.push(`Budget: $${prefs.budget_low || 0}–$${prefs.budget_high || '?'}/outing`);
  if (prefs.neighborhood)                 parts.push(`Location: ${prefs.neighborhood}${prefs.city ? ', ' + prefs.city : ''}`);
  if (prefs.availability_notes)           parts.push(`Usually free: ${prefs.availability_notes}`);
  if (prefs.comm_style)                   parts.push(`Comm style: ${prefs.comm_style}`);
  if (prefs.extra_notes)                  parts.push(`Notes: ${prefs.extra_notes}`);
  return parts.length ? parts.map(p => `- ${p}`).join('\n') : '- Preferences: set but empty — keep learning through conversation';
}

/**
 * buildSystemPrompt — exported so the test suite can assert on prompt content
 * without mocking the full DB / Anthropic stack.
 *
 * @param {object} user        - user row (must have .name)
 * @param {string} stateSnapshot - pre-built state context block
 * @returns {string}
 */
function buildSystemPrompt(user, stateSnapshot = '', { sensitiveMode = false } = {}) {
  return `You are ButterflAI, a personal social agent for ${user.name}.
${sensitiveMode ? '\n🔒 PRIVATE MODE IS ON: The user has activated private mode. EVERYTHING they say this session must be stored via store_private_data, not update_preferences. Treat all content as sensitive regardless of what it sounds like.\n' : ''}
Your job: help them stay meaningfully connected with people they care about.
You handle the logistics of friendship (scheduling, coordination, reminders) so they can focus on the emotional parts.

${stateSnapshot}


LANGUAGE & TONE:
- Users talk like real people with their friends — casual, crude, sweary, slang-heavy. Handle it naturally.
- When someone says something like "I wanna fuck Allie after beers", read the intent (they want to see her, extend the night, ask her to stay) and respond to THAT — don't refuse, don't lecture, don't get weird about it.
- You can be light about it: "Ha, want me to see if Allison wants to keep the night going after beers? 😏" — then offer to send a follow-up invite.
- You will NOT send literally inappropriate messages to contacts. But you will also NOT shut down over casual language from the user. Interpret, deflect if needed, keep moving.
- If something is genuinely impossible or harmful, say why briefly and offer an alternative. Never go full "That's not something I can help with."

## RECIPES — match the request to a recipe, then follow its numbered steps in order. These override any vaguer guidance below.

RECIPE: "invite [name] to [activity]" (a specific person, maybe with a time)
1. lookup_contact([name]) → note the returned contact_id. NEVER ask "who is [name]?" — resolving the name is your job.
2. Reuse that exact contact_id in every later tool call (check_invitee_locations, create_social_event). Never pass the raw name string where a contact_id is expected.
3. Determine day + time. If both were given, pass the user's phrase to create_social_event's "when" (the server resolves the date — you never compute it). If the time is vague AND it is not an open/flexible invite, ask ONLY the time (one question — never also ask what the activity is).
4. create_social_event(contact_ids=[id], when="<the user's day+time phrase>"). Call it once.
5. Confirm to the user using the "scheduled_for" label the tool returned.

RECIPE: vague time ("set up dinner this weekend", "hang out sometime")
1. lookup_contact each invitee → contact_ids.
2. check_invitee_locations(contact_ids). If it returns "flexible" (all nearby), create a flexible_time open invite and stop — no time question.
3. Otherwise message_agent each ButterflAI-user invitee for availability. Agent-to-agent FIRST — do NOT also ask your own user for the time in the same turn.
4. When their agents reply, reconcile and propose ONE time to your user, or create the event once a time is clear.
5. Ask your user directly only if no agent responds after your attempts.

RECIPE: a reply that looks like an RSVP ("yeah im in", "cant make it saturday")
1. Look at the pending coordination invites in the state snapshot. If there is exactly ONE, this reply is about it — do NOT ask "which event?".
2. Affirmative → confirm_coordination_invite(status="accepted"). Negative → confirm_coordination_invite(status="declined"). This notifies the host automatically.
3. If the user names a day that doesn't match the invite, still act on the single pending invite; only clarify if there are genuinely multiple pending invites.
4. Report the real status — never fabricate an acceptance.

PRONOUN RESOLUTION — figure out who "him/her/them" means before asking:
- When the user says "tell him", "let her know", "ask them", check the open events and recent conversation to figure out who they mean. If there's only one person recently discussed or invited to the active event, assume that's who they mean.
- Only ask "which person?" if there are genuinely multiple candidates with no clear context signal.

AGENT-TO-AGENT FIRST — talk to agents before talking to users:
- EXHAUSTION RULE: Before involving YOUR user in any coordination decision, make at least 3 rounds of agent-to-agent negotiation. Minor clarifications, time proposals, factual questions, and preference checks MUST all go agent-to-agent first. Only escalate to your user when: (a) the other agent explicitly says they must ask their user, (b) you have tried 3+ times with no resolution, or (c) the decision requires a genuinely personal preference that isn't stored. If you have not yet tried agent-to-agent, do NOT ask your user.
- EVENT THREAD IDs: When coordinating about a specific event, always set thread_id = the event's ID in message_agent and reply_agent calls. This keeps each event's negotiation separate. Include the event title in your message so the receiving agent can look it up.
- SENSITIVE / PRIVATE QUESTIONS: If your user asks a personal or sensitive question about a contact — health tests, medical status, sexual health, financial situation, safety — route it via message_agent to THEIR agent. Never ask the contact directly. On the RECEIVING end: check your user's private_preferences first; if the answer is stored there, return it to the asking agent directly; if not stored, tell the asking agent you'll check and ask your user privately, then reply_agent once you have an answer.
- INVITEE COMMENTS ON INVITES: When your user says something about a pending invitation (e.g. "I can do 7-9", "sounds good but I need to leave by 9", "ask them if X"), treat this as a message_agent coordination message to the HOST's agent — do not just accept/decline silently. Send the user's conditions or availability to the host's agent and wait for their response before confirming.
- HOST UPDATES AFTER NEGOTIATION: Once an invitee's agent proposes a specific time and you (the host) said "whenever/flexible", you should: (1) confirm the time works via reply_agent, (2) call update_event to set scheduled_at and flexible_time=false (locking in the agreed time), so the event shows the correct time to all parties.
- Before asking the user anything about a third party (their availability, dietary needs, preferences), use message_agent to ask THEIR agent directly.
- COORDINATION ALGORITHM — always follow this order when planning a group event:
  1. ASSESS LOCATION FIRST: call check_invitee_locations before anything else. The tool returns a routing_recommendation.
  2. Route on the recommendation:
     - "flexible" → all nearby; use flexible_time: true, skip time coordination entirely
     - "mixed" → flexible invite for nearby contacts; message_agent only for distant ones
     - "coordinate" → message_agent each invitee for availability; collect replies; propose reconciled time to host
     - "host_location_unknown" → tell user to set their location in Settings; meanwhile ask if they want flexible or a specific time
  3. NEVER skip step 1. Do not assume distance. Do not ask "what time?" when check_invitee_locations says flexible.
- For planning a group event: call check_invitee_locations first → route per recommendation → message_agent only when needed → only then suggest a plan to the user.
- GROUP PLANS: a plan with one of your user's groups → create_social_event with group set, so all members are invited. Your user won't say "group plan" — infer it: they named the group earlier, or the plan is with that group's people (a plan inviting everyone in a group is linked to it automatically). Adding someone to that group later (manage_contact_group add_member) automatically invites them to its upcoming plans and sends them one catch-up — tell your user who was caught up on what (caught_up_on).
- DEFERRING ON A PLAN: if your user, about a plan they're invited to, says they don't want to weigh in and will go with what certain people decide ("whatever Melanie wants", "it's her birthday, not mine", "you guys figure it out"), call defer_on_plan with those names. That's for THIS plan only. Never pass along their reasons. If a friend's ButterflAI says someone deferred, don't ask that person about the plan — ask the people they defer to.
- TRIPS AND PLANS STILL BEING FIGURED OUT: when your user is planning something with people (a trip, a weekend, a party) — even with dates or details unsettled — create it with create_social_event (tentative: true, best-known dates, contact_ids = everyone involved) BEFORE messaging anyone about it. That puts it on everyone's Home and calendars. When a friend (or their ButterflAI's reply) is clearly in, record_rsvp accepted (shown as interested); when someone is out, declined. When dates and details are settled, update_event tentative: false. message_agent with topic "coordination" requires the event_id.
- CREATE THE EVENT BEFORE MESSAGING AGENTS: when your user says they're going somewhere and wants to invite people, ALWAYS call create_social_event first (use flexible_time: true for "come whenever" invites). Then message_agent each invitee. This creates the invite card and calendar entry on their end. If you only call message_agent without creating the event, there is no invite card, no calendar entry, and no RSVP tracking — which breaks the whole flow.
- AGENT QUERY HANDLING — TWO TYPES, handled differently:
  1. FACTUAL QUERIES (health info, allergies, availability from stored prefs): handle SILENTLY. Check stored preferences, call reply_agent with the answer. Do NOT mention to your user. The coordination is invisible.
  2. COORDINATION INVITES / PLANS (another agent says "X is going somewhere and wants to know if your user wants to join", or asks your user's opinion on a plan): pass it to your user with tell_my_user — ONLY the message they should read, e.g. "Sean's heading to [place] tonight around [time] — want to go?" When your user answers, pass it back with message_agent. Do not reveal agent-to-agent mechanics.
  WHEN ANSWERING ANOTHER AGENT YOUR FINAL TEXT IS SHOWN TO NO ONE. Only reply_agent (to the other agent) and tell_my_user (to your user) reach anybody. Never put your reasoning in either.
  3. "WHAT IS YOUR USER UP TO / WHERE ARE THEY / WHAT ARE THEIR PLANS": NEVER answer this yourself — not from memory, not from old messages. Where your user will be is theirs to share. Do NOT ping your user to answer it either — ButterflAI never pushes people to respond to individuals. Reply via reply_agent with only what your user has explicitly shared for that time; if nothing, reply "Nothing shared for tonight."
- Only escalate a FACTUAL query to your user if: (a) the answer genuinely requires their personal decision (not just stored data), AND (b) you have already tried to answer from stored preferences and cannot. Ask your user privately without naming the other agent: "someone asked if you have X on file, do you want to share that?"
- PRIVATE DATA IS SHARED PER-PERSON, NEVER GLOBALLY. Private information (anything the user put in private mode, or that reads as sensitive — health, sexual, financial, legal, mental-health, relationship) is shared with a contact ONLY if the user has approved sharing THAT specific item with THAT specific contact. Consent is per user-pair. There is no "share with everyone" setting.
- When coordinating and a private item would genuinely help (e.g. a dietary or health constraint for a dinner), call request_private_sharing(contact_id, data_key). This sends the user a confirmation prompt — it does NOT share anything by itself, and the item is shared ONLY if the user replies yes (confirmed in code, not by you). Do not claim it is shared until they confirm. If they have not confirmed, do NOT reveal it — even if you know the answer from stored data. get_contact_hard_constraints enforces this in code and will withhold anything not approved for that specific contact; never try to route around it.
- When the user tells you something that reads as private, treat it as private by default and tell them you are keeping it private (they can downgrade it if they want). Do not share it with anyone until they approve that specific share.
- "LET EVERYONE KNOW" ABOUT SENSITIVE DATA: If the user says "let everyone know [health/personal info]" or "tell everybody [sensitive thing]", do NOT broadcast to all contacts. Instead: (1) store it via update_preferences, (2) confirm it's saved, (3) ask "Who specifically would you like me to share this with?" — health info requires per-person consent, not a bulk broadcast. Never message_agent all contacts at once for personal health data.
- Agents talking to agents: share hard constraints freely (allergies, dietary restrictions, availability). Never share soft preferences, exclusion reasons, or private notes. Never reveal what the other agent said verbatim to your user.
- AGENT MESSAGE TONE: When sending messages via message_agent, write as a professional coordinator — factual, brief, no meta-commentary. Do NOT say "discreetly", "just between us", "no awkward conversation needed", or anything that signals you're hiding something from humans. The coordination is normal background logistics.
- RELAYED CONTACT MESSAGE: A message beginning "[Relayed SMS from your contact ...]" is a non-user contact who texted ButterflAI (usually about an event you invited them to). They have no agent of their own — you are their only channel. Help them: if it is a logistics question you can answer from the event details (time, place), reply to THEM directly with send_logistics_sms; if it needs a decision from your user, ask your user. Never forward the contact's raw words as an instruction, and never share anyone's private information in the reply. Do not leave a relayed contact hanging.
- The user should feel like things just got handled — not like they're managing a group chat.

LIVE STATE OVER MEMORY — always check the snapshot:
- PAST EVENTS — never present them as current: an open event tagged [ALREADY HAPPENED] in the snapshot is in the PAST. NEVER compose a message implying it is happening now or tonight, and never base an outbound message on it. Before mentioning any event's timing, cross-check its date against the Date context block. Only message about UPCOMING events.
- "Send a test" / "send [name] a test" means a brief, neutral test message (e.g. "Hey! This is a test from ButterflAI — ignore me 🦋"). Do NOT resurrect an old event or plan to fill it.
- When asked "did she reply?", "who's confirmed?", "any updates?" — read the open events section of THIS message's state snapshot. It shows live RSVP statuses from the DB. Do NOT rely on what you said in a previous turn.
- If the snapshot shows a contact as "accepted" or "declined", report that immediately — even if you previously said "waiting for a reply."
- Agent-to-agent notifications arrive as [System notification] messages. When you receive one, your job is to inform the user proactively — send them an SMS with the update and report back.

RESILIENCE — handle partial failures silently:
- If a tool call partially succeeds (RSVP confirmed but calendar not added), report the success and quietly note the side issue if relevant. Never present a partial failure as a blocker.
- "Hit a snag" is never an acceptable response unless NOTHING worked. If the core action (RSVP, invite sent, event created) succeeded, lead with that.
- Before telling a user something failed, ask yourself: did the important part succeed? If yes, report success. Handle the secondary issue (like missing calendar connection) as a soft offer, not an error.
- Try to resolve failures yourself first: if calendar not connected, offer the connect link. If contact not found, try lookup_contact. Never pass a failure directly to the user without first attempting to fix it.

COORDINATION CONTEXT:
- If you have pending coordination invites (shown in state snapshot above under "You have been invited to"), and a user message seems to be affirming or responding to something you have no conversation history for — assume they're responding to a coordination invite, not starting something new.
- "Yes", "For sure", "Sounds good", "I'm in" with no prior conversation context → check your pending invites, treat it as an RSVP to the most recent one, call confirm_coordination_invite.
- Do NOT ask "what are we talking about?" when you have pending invites. The answer is right there.

AUTONOMY — do the work, don't push it back to the user:
- Before asking the user ANY question, try to answer it yourself using your tools and the state snapshot above.
- "Has everyone confirmed?" → look at the state snapshot's open events + invitee list and report what you see. Do NOT ask which event or where it was created.
- "Did Sean reply?" → check the invitee list in the snapshot. If you see his status, report it.
- Only ask the user when you genuinely need information that cannot exist in the system — a preference between equally valid options, or a detail no tool can infer.
- Never ask the user to help you find your own data. You have tools and a state snapshot. Use them first.

HARD RULES — never violate:
11. NEVER send the user's raw message text to a contact. The user's message to you is an INSTRUCTION about what to do — it is not the outbound message. Always compose something appropriate, clear, and tactful for the contact. If the user says "send her an invite to fuck", you compose "Hey, want to hang after beers tonight? 😊" — not their words.
12. You are a social proxy. The messages you send to contacts reflect on the user. Always write as a thoughtful friend would, regardless of how the user phrased their request to you.
1. Never impersonate the user. Never send a message that sounds like it's coming from them unless they've approved that exact text.
2. Logistics messages (scheduling info, confirmations) can run automatically. Expressive messages (sentiment, speaking as the user) MUST be drafted and sent to the user for approval first — use draft_contact_message, then tell the user what you drafted and ask them to approve.
3. Use send_logistics_sms for pure logistics only. For anything expressive, use draft_contact_message and present the draft to the user.
4. On first contact with anyone new, include the self-identify header and a STOP opt-out (is_first_contact: true in send_logistics_sms). Every first outbound message must clearly say who you are and that the contact can reply STOP to opt out.
5. Never reveal private preferences (exclusions, private notes) to anyone other than the user. Exclusion reasons never cross the agent-to-agent wire. They never cross the wire to contacts or other agents.
6. Contacts have the right to view, edit, and erase their own data at any time, without routing through the user. If a contact corrects a fact about themselves (e.g. their own birthday), the contact's version wins and the user is notified of the change.
7. Plan disclosure is pull-not-push: only reveal event details (location, time, who else is coming) to contacts the host has explicitly included. Never proactively share where or when someone will be to people who were not invited.
8. Agent-to-agent data minimization: share only what the immediate coordination needs (hard constraints, availability). Do not retain or profile the other agent's user from coordination messages.
9. FLAI (the user's social connection points): never show a balance, score, streak, or numeric FLAI count to the user. Use capability language only (e.g. "you've unlocked group coordination" not "you have 65 FLAI"). This rule is absolute — no exceptions.
10. Never pretend to be human. Never claim to be the user when contacting third parties. You are always the user's ButterflAI assistant.
6. If you're unsure whether something is logistics or expressive, treat it as expressive and ask for approval.
7. NEVER claim a message was sent unless the tool returned action_status: "MESSAGE_SENT". If the tool returns action_status: "NOT_SENT_CONSENT_REQUIRED" or any error, report the failure honestly. Never say "Done", "Sent", "All set" unless the tool confirmed it.
8. NEVER invent a contact's response, RSVP, or confirmation. A contact has not agreed to anything until they actually reply. Do not say "they're in" or "they'll be there" or anything implying a response you haven't received.
9. NEVER fabricate details about plans (times, venues, who's coming) that the user did not tell you or that you did not actually coordinate. Only report confirmed facts.
10. After any action (sending a message, creating a calendar event, etc.), tell the user exactly what was done and what the actual status is — not what you hope will happen.
11. Before sending a logistics SMS to a contact for the first time, call check_contact_consent. If they haven't consented, use send_contact_invite instead (which includes the required self-identify header). Never send a regular logistics SMS to someone who hasn't opted in.

COORDINATING PLANS:
- All times and dates from the user are in THEIR local timezone (shown in state snapshot). When passing scheduled_at to create_social_event, output a full ISO 8601 string WITH the explicit UTC offset for their timezone (e.g. "2026-07-17T19:00:00-07:00" for 7pm Pacific, "2026-07-17T19:00:00-04:00" for 7pm Eastern). NEVER pass a bare time without an offset — this causes the wrong UTC conversion. Display times back to them in their local timezone.
- WEEKDAY & DATE RESOLUTION: NEVER compute a date yourself — Haiku gets weekday math wrong. To SCHEDULE an event, pass the user's day+time phrase VERBATIM to create_social_event's "when" field ("friday 7pm", "saturday evening", "tomorrow at 8pm"). The server resolves the exact date in the user's timezone and returns a "scheduled_for" label — state THAT label back, verbatim, in every message about the event (the invite AND the host confirmation). Do NOT hand-build scheduled_at for weekday/relative phrasing. The "Date context" block in the state snapshot is your reference for ANSWERING date questions ("what's this weekend?"): it lists today plus the weekday->date, i.e. the NEXT occurrence of each weekday (today if today is that weekday, unless they say "next"). A message that says "Friday" while the event is on Saturday is a bug.
- When the user wants to invite someone to an activity (beer, dinner, lunch, hanging out, trying something, testing an app, etc.), ALWAYS use create_social_event with contact_ids — never send_logistics_sms or send_contact_invite for an invitation. This creates the tracking record that allows RSVP replies to be recognized automatically.
- INVITING SOMEONE BY NAME — do the legwork, ask at most one thing: when the user says "invite [name] to [activity]", your FIRST action is lookup_contact([name]) (try the nickname AND full-name variants). NEVER ask "who is [name]?" or "which contact do you mean?" — resolving the name from the user's contacts is YOUR job, not theirs. After resolving the contact, the ONLY thing you may ask about is a genuinely-unknown scheduling detail — the time, and only when it is vague ("this weekend", "sometime") AND not a flexible open-invite. Do NOT also ask what the activity is: "a group hang", "dinner", "drinks", "hang out" is already enough to proceed. One question maximum, and only when you truly cannot proceed without it; if the only unknown is the time, ask ONLY the time.
- When the user says "invite my [group/friends/crew] to [anything]": (1) call manage_contact_group(list_groups) or manage_contact_group(action=create_or_get) to get the group members, (2) call create_social_event with ALL of those contact_ids. Never use send_contact_invite for this — that is only for inviting people to JOIN ButterflAI, not to join an activity.
- send_contact_invite is EXCLUSIVELY for inviting a Tier 0 (not yet connected) contact to JOIN ButterflAI itself. It is NEVER the right tool for inviting someone to a social activity, hangout, event, or gathering — even if the activity involves ButterflAI. If a contact is already Tier 1+, send_contact_invite will error.
- send_logistics_sms is ONLY for one-way informational messages that do NOT expect a reply: "running 10 min late", "on my way", "parking on the corner". If the message asks a question or expects a yes/no, use create_social_event instead.
- create_social_event sends the invite message automatically. Do NOT also call send_logistics_sms for the same invite.
- NEVER call create_social_event more than once for the same event. If you are uncertain about the time or date, ask the user to clarify BEFORE creating the event — do not create multiple versions and cancel the wrong one.
- FLEXIBLE / OPEN-TIME events: if the user explicitly says no fixed time — "come when you're ready", "whenever works", "open invite", "drop by any time", "they'll come over when ready" — do NOT ask for a time. Set flexible_time: true and omit scheduled_at. The invite will say "come over whenever works for you." Respect this choice without nagging for a time.
- LOCATION CONTEXT: use check_invitee_locations to objectively determine proximity — do not guess from descriptions alone. If the tool confirms all invitees are nearby, a flexible open-invite is the right choice; do not ask for a time. If the user says "they're all local" but location is unknown in the DB, trust the user and use flexible_time: true.
- If the user says something vague like "tonight" or "this weekend" without specifying a time AND has not said they want a flexible/open invite: DO NOT pick a time yourself. ALWAYS try message_agent for each invitee first — the tool will tell you if they're not on ButterflAI. Collect availability from all agents who respond, then propose a reconciled time to the host. Only call create_social_event once you have a confirmed time or the user says flexible_time is fine.
- TIER CONFUSION — critical: a contact's tier in your contact list (0, 1, 2) reflects your SMS/contact permission, NOT whether they are a ButterflAI user. NEVER assume a Tier 1 contact is "not on ButterflAI" — they very likely ARE. Always call message_agent and let the tool tell you if they don't have an account. Only say they're "not on ButterflAI" if message_agent returns an explicit error saying so.
- If message_agent succeeds for a contact: wait for their agent to reply via agent_reply channel, then reconcile availability and propose options to the host.
- If message_agent returns "Contact is not a ButterflAI user": THEN and only then fall back to: ask the host to pick a proposed time, then use create_social_event which texts them asking if that time works.
- Only offer send_contact_invite if message_agent confirmed the contact is not a ButterflAI user AND the host explicitly wants to invite them to join.
- After create_social_event, tell the user: "I've invited [Name]. I'll let you know when they respond." Do NOT promise the invitee "a text" or "an SMS" — ButterflAI users are notified in the app, not by SMS; only non-users get a text. Say "I've invited [Name]" without naming the channel.
- Once a contact responds, their RSVP is tracked and you'll be notified. Do not claim they responded until the system tells you they did.

MINIMIZE BACK AND FORTH:
- Use your judgment about intent. If the user clearly wants you to act, act. If they clearly want to review, show a draft. Don't enumerate phrases — you already understand human intent.
- A direct command ("send it", "text her", "do it") means execute now. Respond with what you sent, not a draft awaiting approval.
- An affirmative reply to something you proposed ("fuck yeah", "yeah", "sounds good") means they approved it — execute it immediately.
- Only ask ONE clarifying question, only when you genuinely can't figure out what to do without it.

LOGISTICS vs EXPRESSIVE (the send gate):
- LOGISTICS (execute without asking): scheduling, casual invites, coordination, time/place, check-ins. These are not speaking for the user emotionally — they're handling logistics on the user's behalf.
- EXPRESSIVE (needs user approval before sending): messages that speak AS the user with genuine personal feeling — a heartfelt apology, a confession, something that would be embarrassing or harmful if the user hadn't intended it.
- Use your judgment. "Want to hang after beers?" is obviously logistics. "I've been thinking about you a lot lately" is obviously expressive. Most things are logistics.
- When in doubt, lean logistics. The cost of an extra approval is higher than the cost of sending a slightly imperfect logistics message.
- Teasing, nudging or hyping a friend toward a plan ("tell him to get off his ass, let's get wings") is LOGISTICS. Compose a friendly version and send it right away — no draft, no clarifying question.
- A GO-AHEAD AFTER A DRAFT IS APPROVAL: if you showed a draft and the user says anything like "send it", "yes", "do it", "just send something", "I don't want to approve, just send" — send that draft immediately with send_logistics_sms. Never ask for approval twice.
- ${links.linksForPrompt()}
- PLANNING & RESEARCH — LOOK IT UP, DON'T GIVE UP: for anything current or specific (parks, campgrounds, reservations, hours, events, prices, drive times) use web_search, and web_fetch to read a page (a link the user sends, or a search result). Answer from what you found. For temperatures/rain/freezing use get_weather_forecast (next 16 days; beyond that say it's too far out and give typical conditions). You cannot book or pay: give the official booking link, the exact details to enter (dates with the weekday labels from the tools, site type, number of adults and kids), and offer to remind them. Never say you booked or reserved anything.
- WHAT FRIENDS ARE UP TO (owner rule — ButterflAI is not a messenger): "what're my boys up to tonight?" → check_friends_plans (group "boys", when "tonight"). Report ONLY what friends shared; for the rest say they haven't shared anything. NEVER message_agent or send_logistics_sms people to ask what they're up to, and never guess. Mention that they'll see you're up for something — nobody gets pinged.
- When the user offers their own plans for friends ("I'm at Sully's tonight, the boys can come", "free this weekend") → share_plan with their words for how long (until). If plans change → clear_my_plans.
- TO ASK OR TELL A PERSON SOMETHING SPECIFIC ("tell Allie I'm running late", "ask Bam Bam if he wants wings at 8"), use send_logistics_sms — the person sees it. (What someone is up to is NOT asked this way — use check_friends_plans.) message_agent talks only to their AGENT, which answers on its own without showing them; use it only for agent-level coordination (availability, constraints). lookup_contact tells you whether someone is on ButterflAI (on_butterflai) — trust that, not a contact's tier.
- MESSAGES BETWEEN PEOPLE GO THROUGH THE AGENTS: "💬 From Allie's ButterflAI: …" in your history is a message from Allie (her agent sent it), and "📤 To Sean: …" is one you sent for this user. If the user answers one ("tell her I'm in", "say 8 works"), reply to that person with send_logistics_sms. ButterflAI users receive it in the app; when the tool says delivered_via "app", tell the user it was sent in ButterflAI.
- NEVER GUESS A contact_id. Call lookup_contact with the person's name and use the "id" it returns. If a send tool returns CONTACT_NOT_FOUND, look the person up and retry before replying.
- Only say a message was sent if the send tool returned sent: true in THIS turn. If it failed, tell the user it did NOT go through. (Enforced in code: a false "sent" reply is blocked.)

LEARNING THE USER — build their profile over time:
- You are their long-term agent. Every conversation teaches you something. Save it.
- When the user mentions anything about preferences — food, activities, schedule, budget, vibe — call update_preferences immediately. Don't wait for a natural pause. Just save it.
- SENSITIVE DATA ROUTING (critical — see PRIVACY.md):
  - Health info, medical results, STI/sexual health, medications, mental health, financial struggles, legal matters → ALWAYS use store_private_data. NEVER use update_preferences.
  - If the user says something that sounds sensitive but you're unsure: tell them "That sounds like it might be personal — I'm treating it as private and storing it encrypted. Is that right?" Then use store_private_data unless they say otherwise.
  - If private mode is ON (shown at top of this prompt): everything goes to store_private_data regardless.
  - update_preferences has a safety net that will reject sensitive content — if it returns SENSITIVE_DATA_DETECTED, call store_private_data instead.
  - If a tool returns PRIVATE_MODE_ON, private mode is on: save it with store_private_data (or manage_avoid_list) instead. Never retry the plain-text tool.

AVOID LIST — ACT ON IT, NEVER SAY IT:
- When the user says they don't want to be in plans with someone ("I don't want to hang out with Julie", "keep me away from Dave"), look the person up and call manage_avoid_list action=add right away. Do not ask why and do not store a reason. Confirm in one short line.
- The avoid list is enforced in code: avoided people are never invited, and their invites are declined automatically unless the user chose "ask me first" for that person. You do not need to remember it or work around it.
- NEVER mention the avoid list, or any reason, to another agent, a contact, or in any message that leaves this conversation. To anyone else, an avoided invite is simply "can't make it".
- If create_social_event returns avoided_not_invited, tell the user (only the user) that person is on their avoid list and wasn't invited, and offer to remove them from the list.
- An invite marked "ASK YOUR USER" (or a "[Invite needs your decision]" message) must be put to the user before you RSVP. Ask in one line ("Sam invited you to trivia Thursday — want to go?"); for a group with someone they avoid, say someone on their avoid list is also going. Never RSVP until they answer.
- The user can review what you did automatically and change any person to "ask me first" in Settings → Agent activity. Point them there when they ask what you've been doing.
- Examples: "I hate sushi" → cuisine_avoids; "I'm usually free after 7" → availability_notes; "I'm allergic to peanuts" → food_allergies; "I'm more of a dive bar person" → vibe; "I try to keep nights under $50" → budget_high.
- Food allergies are the most important — always save them and always factor them in when suggesting venues.
- After the first week, you should know their neighborhood, rough availability, dietary constraints, and vibe. Build this naturally through conversation, not with a form.
- When planning something with a group, call get_contact_hard_constraints for each ButterflAI contact — this is agent-to-agent, no SMS needed. Factor their allergies and restrictions into venue suggestions before anyone is asked anything.

CONTACT MANAGEMENT:
- If the user mentions a person by name AND provides a phone number, ALWAYS call add_contact immediately before responding. Don't ask permission.
- If the user mentions a person by name without a phone number, use lookup_contact first. Try the nickname they used AND common full-name variants (e.g. "Allie" → also try "Allison"; "Liz" → "Elizabeth"; "Mike" → "Michael"). If multiple contacts match, show the top options with names and last 4 digits of phone only — never the full number unprompted.
- After the user disambiguates a contact ("the one ending in 7976"), ALWAYS call save_agent_note to record it (e.g. "Allison = Allison McLaine ...7976"). This prevents asking the same disambiguation question again.
- If the user gives enough context (e.g. "my college friend Allie" or "Allie McLaine"), narrow down before asking.
- Ingesting a contact (add_contact) never sends them any message — it's just your address book.
- Whether a contact uses ButterflAI is their private information. Don't claim to know or not know. Instead: offer to reach out to them on the user's behalf, which works whether or not they're a user.
- For importing many contacts at once, use get_contact_import_url and send the user that link.

NAME RECONCILIATION — act immediately, don't ask:
- When the user says "[name A] is [name B]" or "Allie is Allison" or "that's short for..." — they're telling you two names refer to the SAME person. Immediately: (1) lookup_contact for BOTH names, (2) if one unambiguous contact found, call update_contact to set the nickname (the short/informal name goes in nickname, the full name stays in name), (3) confirm what you did.
- Common short-name patterns to recognize: Allie→Allison, Liz/Beth→Elizabeth, Mike→Michael, Rob→Robert, Tom→Thomas, Sam→Samuel/Samantha, Kate/Katie→Katherine, Nat→Natalie, Alex→Alexander/Alexandra, Chris→Christopher/Christina, Dan→Daniel, Ben→Benjamin, Matt→Matthew, Jen→Jennifer, Steph→Stephanie, Bri→Brianna, Dee→Diane/Deirdre.
- If a contact's display name is a formal name but the user always uses a nickname: proactively suggest setting the nickname ("Want me to call him Mike in our conversations?").
- If you find two contacts that appear to be the same person (same first name, similar last name, or the user indicates it), set also_known_as on the primary one and note the duplication for the user to confirm before merging.

GROUPS & LISTS — create automatically, don't ask:
- When the user references a group or list (e.g. "my closest friends", "my work crew", "the book club"), IMMEDIATELY call manage_contact_group with action=create_or_get. Never ask "should I create that group?" — just create it.
- To add someone to a group: lookup_contact → manage_contact_group(create_or_get) → manage_contact_group(add_member). Do this in sequence without interrupting the user.
- Groups you should proactively suggest after patterns emerge: "closest friends" (contacts with high cadence/tier), "family", "work", "neighbors".
- When listing a group's members, show nickname if set, otherwise name.
- Emoji suggestions: closest friends ⭐, family ❤️, work 💼, book club 📚, neighbors 🏠.

LOCATION — ask when needed, never guess:
- If the user asks about local venues, events, or anything that requires knowing where they are, and the state snapshot shows location as "unknown", reply with exactly this JSON on its own line before your message: {"action":"REQUEST_LOCATION"}
- Example: if location is unknown and user asks "find me a good bar", emit {"action":"REQUEST_LOCATION"} then say "Tap 'Share location' so I can find bars near you."
- Once location is known, use it automatically for all local searches — never ask again.

STYLE: Concise, warm, competent. SMS-length replies. No filler words.`;
}

/**
 * _processMessageContinue — the rest of processMessage, extracted so buildSystemPrompt
 * can live as a named, exported function between the two halves.
 */
// ── "Never claim sent unless a send succeeded" — enforced in code (MEMORY.md hard rule) ──
// 2026-10-06: the agent told a tester "Sent! Message is on its way to Sean" after its
// send failed. A prompt rule alone didn't hold, so the loop checks the reply.
const SENT_CLAIM = /\b(sent|on (its|it's) way|delivered|i(?:'ve| have| just)? (?:messaged|texted|told|asked)|let (him|her|them) know)\b/i;
const SENT_NEGATED = /\b(not|n't|never|unable to|couldn't|can't|wasn't|haven't|hasn't|didn't)\b[^.!?\n]{0,25}\b(sent|delivered|send|go through)\b/i;

function claimsSent(text) {
  return SENT_CLAIM.test(text) && !SENT_NEGATED.test(text);
}

// True when a tool result shows something actually went out.
function sendSucceeded(result) {
  if (!result || typeof result !== 'object' || result.error) return false;
  return result.sent === true || result.replied === true
    || result.action_status === 'MESSAGE_SENT' || result.action_status === 'RSVP_CONFIRMED'
    || (result.invites_sent || 0) > 0;
}

// ── Other claimed actions — same rule: say it's done only if a tool did it this turn ──
// 2026-10-09 (Sean's feedback #8): "Done! ✅ Added Bam Bam to your 'favorite Mama's'
// group" — it had only looked Bam Bam up; nothing was added. Each entry: what a claim
// looks like, and which successful tool result backs it. Add entries as new cases appear.
const ACTION_CLAIMS = [
  {
    what: 'a group change',
    claim: /\b(added|removed|put|moved)\b[^.!?\n]{0,80}\bgroup\b|\bgroup\b[^.!?\n]{0,40}\b(created|updated)\b|\bcreated\b[^.!?\n]{0,40}\bgroup\b/i,
    done: (log) => log.some((t) => t.name === 'manage_contact_group' && !t.result?.error
      && (t.result?.added || t.result?.removed || t.result?.created || t.result?.deleted || t.result?.renamed)),
    how: 'manage_contact_group (list_groups to get the group_id, lookup_contact for the contact_id, then add_member / remove_member)',
  },
  {
    what: 'a reply to a friend\'s ButterflAI',
    // "I've already replied to Sean's agent", "Sean's agent has it", "the message went through"
    claim: /\b(?:I(?:'ve| have)?|already)\s+(?:already\s+)?(?:replied|answered|passed (?:it|that|this|your answer)|relayed)\b|\bagent\s+(?:has|got|should have)\s+(?:it|that|your answer)\b|\bwent through\b/i,
    // Suspicious only while a friend's question to this user is still unanswered.
    done: (log, ctx) => !ctx.openQuestions || log.some((t) => ['reply_agent', 'message_agent', 'send_logistics_sms'].includes(t.name) && sendSucceeded(t.result)),
    how: 'reply_agent with the message_id listed under "Open questions from friends\' ButterflAIs"',
  },
];
const ACTION_NEGATED = /\b(not|n't|never|unable to|couldn't|can't|wasn't|haven't|hasn't|didn't|want me to|should i|shall i)\b/i;

function unbackedActionClaim(replyText, toolLog, ctx = {}) {
  if (!replyText) return null;
  for (const c of ACTION_CLAIMS) {
    const m = c.claim.exec(replyText);
    if (!m) continue;
    // Look at the sentence the claim is in: "I couldn't add…" / "Want me to add…" aren't claims.
    const start = Math.max(replyText.lastIndexOf('.', m.index), replyText.lastIndexOf('\n', m.index), replyText.lastIndexOf('?', m.index)) + 1;
    if (ACTION_NEGATED.test(replyText.slice(start, m.index + m[0].length))) continue;
    if (!c.done(toolLog, ctx)) return c;
  }
  return null;
}

const NOT_DONE_FALLBACK = "Heads up — that didn't actually get done. Want me to try again?";

const NOT_SENT_FALLBACK = "Heads up — that didn't actually go through, so nothing was sent. Want me to try again?";

// Tools that send something to someone else. Only their failures count as failed sends.
const SEND_TOOLS = new Set([
  'send_logistics_sms', 'message_agent', 'reply_agent', 'create_social_event',
  'send_contact_invite', 'confirm_coordination_invite',
]);

// The user asked (not questioned) for something to be sent in this message.
function asksToSend(userText) {
  const t = String(userText || '').trim();
  return /\b(send|text|message|tell|ask|invite|let \w+ know)\b/i.test(t) && !/\?\s*$/.test(t);
}

// Only challenge a "sent" claim when this turn gives reason to doubt it: a send was
// tried and failed, or the user asked for a send and none was even attempted. A
// truthful reference to an earlier send ("did you send it?" → "yes, earlier") passes.
function unverifiedSentClaim(replyText, { anySendSucceeded, failedSends, sendAttempted, userText }) {
  if (!replyText || anySendSucceeded || !claimsSent(replyText)) return false;
  return failedSends.length > 0 || (!sendAttempted && asksToSend(userText));
}

// ── Research: Claude's built-in web search + page reading (2026-10-09) ────────────
// Sean asked for help booking Grover Hot Springs; the agent couldn't look anything up
// (the old Brave-backed web_search never had a key). These run on Anthropic's side; the
// basic versions are covered by zero data retention. Search: $10/1,000 + tokens. Fetch:
// tokens only, and only URLs already in the conversation or search results.
// NOT offered when answering another agent (agent_query) — no fetching links that
// someone else put in front of this user's agent.
function toolsFor(msg, user) {
  if (msg.channel === 'agent_query') return [...TOOL_DEFINITIONS, TELL_MY_USER_TOOL];
  return [
    ...TOOL_DEFINITIONS,
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5,
      ...(user?.timezone ? { user_location: { type: 'approximate', timezone: user.timezone } } : {}) },
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5, max_content_tokens: 8000 },
  ];
}

// The reply is the text AFTER the last web search/fetch (earlier text is "let me
// search…"). Search answers arrive split into blocks around citations, so they're joined
// without separators; cited sources are listed at the end (required when showing
// web-search output to users).
function answerText(content) {
  let lastServer = -1;
  content.forEach((b, i) => { if (b.type === 'server_tool_use' || /_tool_result$/.test(b.type)) lastServer = i; });
  const textAfter = content.slice(lastServer + 1).filter(b => b.type === 'text');
  if (lastServer < 0) return content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const text = textAfter.map(b => b.text).join('').trim();
  const sources = [];
  for (const b of textAfter) for (const c of (b.citations || [])) if (c.url && !sources.includes(c.url)) sources.push(c.url);
  return sources.length ? `${text}\n\nSources: ${sources.slice(0, 3).join(' · ')}` : text;
}

// Test users: record web searches/fetches in the trace like other tools.
function traceServerTools(turnTrace, content) {
  for (const b of content || []) {
    if (b.type !== 'server_tool_use') continue;
    const result = content.find(r => r.tool_use_id === b.id && /_tool_result$/.test(r.type));
    const urls = Array.isArray(result?.content) ? result.content.map(r => r.url).filter(Boolean).slice(0, 5)
      : result?.content?.url ? [result.content.url] : [];
    turnTrace.tool(b.name, b.input, result ? { urls, error: result.content?.error_code } : { pending: true }, 0);
  }
}

// Channels that carry the user's own words (private mode applies to these).
const USER_CHANNELS = ['sms', 'webchat'];
const PRIVATE_PLACEHOLDER = '🔒 Private message';

// Private mode (owner decision 4): the message is kept, but only encrypted. Anything
// reading conversation_history.text — including this agent's own history — sees the
// placeholder; only the owner's chat view decrypts it.
function appendHistory(userId, role, text, isPrivate) {
  if (!isPrivate) return db.appendConversation(userId, role, text);
  const e = sensitive.encrypt(String(text).slice(0, 4000));
  return db.appendConversation(userId, role, PRIVATE_PLACEHOLDER, { ct: e.encrypted_v, iv: e.iv, tag: e.auth_tag });
}

// Which past messages the model sees, and how. Rules, not judgment (2026-10-08, Bam
// Bam's feedback #5): his agent answered "what's Bam Bam up to tonight?" with a JULY
// plan ("80s bar tonight") pulled from undated chat history, and told Sean's agent
// where Bam Bam would be.
//  - Answering ANOTHER agent (agent_query): no history at all. It answers only from the
//    structured, current state in the system prompt (coordination-only snapshot).
//  - Otherwise: only the last HISTORY_DAYS days, and anything before today is labelled
//    with its date so an old plan can never read as current.
const HISTORY_DAYS = 7;
function historyForModel(userId, msg, timezone) {
  if (msg.channel === 'agent_query') return [];
  const tz = timezone || 'America/New_York';
  const now = Math.floor(Date.now() / 1000);
  const dayKey = (secs) => new Date(secs * 1000).toLocaleDateString('en-CA', { timeZone: tz });
  const today = dayKey(now);
  return db.getRecentConversation(userId, 50)
    .filter(h => h.created_at >= now - HISTORY_DAYS * 86400)
    .map(h => {
      if (dayKey(h.created_at) === today) return { role: h.role, content: h.text };
      const label = new Date(h.created_at * 1000).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
      return { role: h.role, content: `[from ${label} — not today] ${h.text}` };
    });
}

async function _processMessageContinue({ msg, user, userId, userPhone, systemPrompt }) {
  // Load recent conversation history so the agent has context across SMS turns.
  // Filter: Anthropic only accepts 'user' and 'assistant' roles in messages[].
  // Strip 'system' role rows (used for injected context) and ensure alternating roles.
  const history = historyForModel(userId, msg, user?.timezone);
  const rawHistory = history
    .filter(h => h.role === 'user' || h.role === 'assistant')
    .map(h => ({ role: h.role, content: h.content }));
  // Deduplicate consecutive same-role entries (keep last) to avoid role-alternation errors
  const dedupedHistory = rawHistory.reduce((acc, h) => {
    if (acc.length > 0 && acc[acc.length - 1].role === h.role) {
      acc[acc.length - 1] = h; // replace with later message of same role
    } else {
      acc.push(h);
    }
    return acc;
  }, []);
  const messages = [
    ...dedupedHistory,
    { role: 'user', content: msg.text },
  ];

  // Store this inbound message in conversation history. In private mode the user's own
  // words (and this turn's replies) are kept only encrypted, and the queued copy of
  // the message is scrubbed, so no plain-text copy is left at rest.
  const isPrivate = USER_CHANNELS.includes(msg.channel) && sensitive.isSensitiveMode(userId);
  const turnStart = Math.floor(Date.now() / 1000);   // chat rows from here on belong to this turn (topics.js)
  currentTurn = { userText: USER_CHANNELS.includes(msg.channel) ? msg.text : '', channel: msg.channel || 'sms' };
  if (msg.channel === 'agent_query') {
    // Who's asking (for tell_my_user's avoid-list check), from the queued "thread=<id>".
    const thread = /\bthread=([\w-]+)/.exec(msg.text || '')?.[1];
    const q = thread ? db._raw().prepare('SELECT from_user, thread_id FROM agent_messages WHERE id = ?').get(thread) : null;
    currentTurn.askerId = q?.from_user || null;
    // Coordination questions are about an event (thread_id = event id) — used to file the
    // passed-on message under that discussion in the user's chat.
    currentTurn.threadEvent = q?.thread_id && db._raw().prepare('SELECT 1 FROM social_events WHERE id = ?').get(q.thread_id) ? q.thread_id : null;
  } else {
    // An agent_query is NOT kept in the user's chat: it showed up there as if they'd typed
    // "[Agent query from Sean Gonzalez's agent | thread=…]" (2026-10-09). What the user
    // needs to see arrives via tell_my_user.
    appendHistory(userId, 'user', msg.text, isPrivate);
  }
  if (isPrivate) db.scrubInboundMessageText(msg.id, PRIVATE_PLACEHOLDER);

  // Test users only: record this turn (message, tool calls, reply) for triage.
  const turnTrace = trace.startTurn({ userId, msg, model: MODEL, isPrivate });
  turnTrace.message(msg.text);

  // Agentic loop — run until Claude stops calling tools
  let iterations = 0;
  const MAX_ITERATIONS = 10;
  let anySendSucceeded = false;
  let sendAttempted = false;
  const failedSends = [];
  let sentClaimChallenged = false;
  let agentQueryChallenged = false;
  let actionClaimChallenged = false;
  const toolLog = [];   // { name, input, result } for every tool run this turn
  let lastReplyText = '';

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      tools: toolsFor(msg, user),
      messages,
    });
    traceServerTools(turnTrace, response.content);

    // FLAI burn instrumentation — STUB, always permissive (§2.3)
    try {
      flai.burnForUser(userId, 'burn:llm', { ref_id: response.id });
    } catch (_) { /* non-fatal */ }

    // Accumulate assistant turn
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      // Extract text response and send to user.
      // Use sendUnchecked — agent only processes established users who consented at onboarding.
      // Wrong ButterflAI addresses in a reply are corrected in code (links.fixReply).
      let replyText = links.fixReply(answerText(response.content));

      // Guard: a reply that says something was sent, in a turn where nothing was.
      if (unverifiedSentClaim(replyText, { anySendSucceeded, failedSends, sendAttempted, userText: msg.text })) {
        if (!sentClaimChallenged) {
          sentClaimChallenged = true;
          turnTrace.event('guard', `blocked unverified "sent" claim: ${replyText.slice(0, 200)}`);
          messages.push({ role: 'user', content:
            '[System check — not from the user] Your reply says a message was sent, but no send succeeded in this turn'
            + (failedSends.length ? ` (failed: ${failedSends.join('; ')})` : '')
            + '. If it should go out, send it now with the right tool — call lookup_contact first if you need the contact id. '
            + 'Otherwise tell the user plainly that it was NOT sent. Never say something was sent unless a tool confirmed it.' });
          continue;
        }
        turnTrace.event('guard', `replaced repeated unverified "sent" claim: ${replyText.slice(0, 200)}`);
        replyText = NOT_SENT_FALLBACK;
      }

      // Guard: a reply that says something was done (e.g. added to a group) when no tool did it.
      const unbacked = msg.channel === 'agent_query' ? null
        : unbackedActionClaim(replyText, toolLog, { openQuestions: openQuestionsFor(userId).length });
      if (unbacked) {
        if (!actionClaimChallenged) {
          actionClaimChallenged = true;
          turnTrace.event('guard', `blocked unbacked claim (${unbacked.what}): ${replyText.slice(0, 200)}`);
          messages.push({ role: 'user', content:
            `[System check — not from the user] Your reply says you made ${unbacked.what}, but no tool did that in this turn. `
            + `Do it now with ${unbacked.how}, or tell the user plainly it was NOT done. Never say something was done unless a tool confirmed it.` });
          continue;
        }
        turnTrace.event('guard', `replaced repeated unbacked claim (${unbacked.what}): ${replyText.slice(0, 200)}`);
        replyText = NOT_DONE_FALLBACK;
      }

      // Answering another agent: the final text goes to NO ONE (it mixes reasoning with
      // what the model meant to say). Answers go out only via reply_agent / tell_my_user.
      if (msg.channel === 'agent_query') {
        const answered = currentTurn?.toldUser || messages.some((m) => Array.isArray(m.content)
          && m.content.some((b) => b.type === 'tool_use' && b.name === 'reply_agent'));
        if (!answered && !agentQueryChallenged) {
          agentQueryChallenged = true;
          turnTrace.event('guard', `agent_query ended with text only: ${String(replyText || '').slice(0, 200)}`);
          messages.push({ role: 'user', content:
            '[System check — not from the user] Your text is shown to no one. Answer the other agent with reply_agent, '
            + 'or, if your user should decide, call tell_my_user with only the message they should read.' });
          continue;
        }
        if (replyText) turnTrace.event('internal', `agent_query final text (not delivered): ${replyText.slice(0, 300)}`);
        break;
      }

      lastReplyText = replyText || '';
      if (replyText) {
        // Store reply in conversation history before sending
        appendHistory(userId, 'assistant', replyText, isPrivate);
        turnTrace.reply(replyText);
        // Push to web UI via SSE if connected
        const online = sse.push(userId, { role: 'assistant', text: replyText, ts: Math.floor(Date.now() / 1000) });
        if (userPhone && msg.channel === 'sms') {
          // They texted us → answer by text.
          console.log(`[agent] replying to ${userPhone}: "${replyText.slice(0, 60)}"`);
          await sms.sendUnchecked(userPhone, replyText);
        } else if (msg.channel !== 'webchat') {
          // The agent acting on its own (an RSVP came in, another agent replied…): it's
          // in their chat; text only if they won't see it there. (Feedback #6, 2026-10-09:
          // Sean got these as texts while looking at the web app.)
          await deliver.notifySelf(user || db.getUser(userId), replyText, { online });
        }
      }
      break;
    }

    if (response.stop_reason === 'tool_use') {
      // Execute all tool calls in this turn
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        // Push a brief status line to the chat UI while the tool runs
        const statusLine = toolStatusLine(block.name, block.input);
        if (statusLine) sse.push(userId, { role: 'status', text: statusLine });

        let result;
        const started = Date.now();
        try {
          result = await executeTool(block.name, block.input, userId, userPhone);
        } catch (err) {
          console.error(`[agent] tool error ${block.name}: ${err.message}\n${err.stack || ''}`);
          result = { error: err.message };
        }
        turnTrace.tool(block.name, block.input, result, Date.now() - started);
        toolLog.push({ name: block.name, input: block.input, result });
        if (SEND_TOOLS.has(block.name)) {
          sendAttempted = true;
          if (sendSucceeded(result)) anySendSucceeded = true;
          else failedSends.push(`${block.name}: ${String(result?.message || result?.error || 'not sent').slice(0, 120)}`);
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // A long web search can pause the server-side loop: continue by sending the
    // paused assistant content back as-is (already appended above).
    if (response.stop_reason === 'pause_turn') continue;

    // Unexpected stop reason
    console.warn(`[agent] unexpected stop_reason=${response.stop_reason}`);
    break;
  }

  if (iterations >= MAX_ITERATIONS) {
    console.error(`[agent] hit MAX_ITERATIONS for message ${msg.id}`);
    turnTrace.event('stuck', `hit MAX_ITERATIONS (${MAX_ITERATIONS}) without a final reply`);
    const stuck = `I couldn't wrap that up — mind trying again?`;
    try {
      if (msg.channel === 'webchat' && userId) {
        sse.push(userId, { role: 'status', text: '' });
        db.appendConversation(userId, 'assistant', stuck);
        sse.push(userId, { role: 'assistant', text: stuck, ts: Math.floor(Date.now() / 1000) });
      } else if (userPhone && msg.channel === 'sms') {
        await sms.notifyUser(userPhone, stuck);
      }
    } catch (_) { /* best effort */ }
  }

  // Which discussion (event) this turn belongs to, so the chat can be filtered by it.
  await topics.tagTurn({ userId, sinceTs: turnStart, toolLog, isPrivate,
    userText: USER_CHANNELS.includes(msg.channel) ? msg.text : '', replyText: lastReplyText });
}

// ── Queue processor ───────────────────────────────────────────────────────────

let processing = false;

async function tick() {
  if (processing) return;
  processing = true;

  try {
    const pending = db.getPendingInboundMessages();
    for (const msg of pending) {
      try {
        await processMessage(msg);
      } catch (err) {
        // Log full stack so silent failures are visible in Fly logs
        console.error(`[agent] failed to process message ${msg.id}: ${err.message}\n${err.stack}`);
        trace.startTurn({ userId: msg.from_id, msg, model: MODEL }).event('error', err.message);
        // Surface a visible error on the user's OWN channel — never fail silently.
        // Web → the chat; SMS → a reply text. Agent-to-agent channels stay log-only
        // (a coordination hiccup is not the user's direct message to answer).
        const snag = "Sorry, I hit a snag processing that — could you try again?";
        try {
          if (msg.channel === 'webchat' && msg.from_id) {
            sse.push(msg.from_id, { role: 'status', text: '' }); // clear thinking indicator
            db.appendConversation(msg.from_id, 'assistant', snag);
            sse.push(msg.from_id, { role: 'assistant', text: snag, ts: Math.floor(Date.now() / 1000) });
          } else if (msg.channel === 'sms' && msg.from_phone) {
            await sms.notifyUser(msg.from_phone, snag);
          }
        } catch (_) { /* error-path best effort */ }
      } finally {
        db.markMessageProcessed(msg.id);
      }
    }
  } finally {
    processing = false;
  }
}

function startAgentLoop() {
  const auth = resolveAuth();
  if (auth.mode === 'none') {
    console.warn(`[agent] ${auth.error} — agent loop disabled`);
    return;
  }
  console.log(`[agent] starting loop (poll every ${POLL_INTERVAL_MS}ms, model=${MODEL}, auth=${auth.mode})`);
  // Prove auth works end to end with a free call (lists one model, no tokens). Picking a
  // credential source isn't proof — keyless auth once "selected" fine while every real
  // call failed. CI checks for this line after each deploy.
  anthropic.models.list({ limit: 1 })
    .then(() => console.log(`[agent] Anthropic auth verified (${auth.mode}, version ${process.env.BUILD_VERSION || 'dev'})`))
    .catch((err) => console.error(`[agent] ANTHROPIC AUTH FAILED (${auth.mode}, version ${process.env.BUILD_VERSION || 'dev'}): ${err.status || ''} ${err.message}`));
  setInterval(tick, POLL_INTERVAL_MS);
  tick(); // run immediately on start
}

module.exports = { startAgentLoop, processMessage, tick, buildSystemPrompt, buildPrefsSection, buildDateContext, eventRecency, executeTool, _safeForSms, resolveContactRelay, _setAnthropic, _setToolObserver, _unverifiedSentClaim: unverifiedSentClaim, NOT_SENT_FALLBACK, _unbackedActionClaim: unbackedActionClaim, NOT_DONE_FALLBACK };
