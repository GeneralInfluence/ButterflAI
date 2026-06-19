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

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');
const sms = require('./sms');
const { ConsentRequired } = require('./sms');
const { readUserPrivateData } = require('./crypto');
const calendar = require('./calendar');
const contactsImport = require('./contacts-import');
const venues = require('./venues');
const multiparty = require('./multiparty');
const desires    = require('./desires');
const coord      = require('./coordination');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const POLL_INTERVAL_MS = parseInt(process.env.AGENT_POLL_MS || '5000', 10);
const MODEL = process.env.AGENT_MODEL || 'claude-3-5-haiku-20241022';  // fast + cheap for agent loop

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
    description: 'Send a logistics-only SMS to a contact (scheduling info, confirmations). No sentiment. Includes self-identify header if first contact.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        message: { type: 'string' },
        is_first_contact: {
          type: 'boolean',
          description: 'Set true if this is the first outbound message to this contact — triggers self-identify + STOP notice',
        },
      },
      required: ['contact_id', 'message'],
    },
  },
  {
    name: 'message_agent',
    description: 'Send a message to another ButterflAI user\'s agent. Use this to coordinate BEFORE bothering either user. Ask about availability, dietary constraints, RSVP status, or logistics. The other agent will respond autonomously without disturbing their user for factual questions.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id:  { type: 'string', description: 'Contact ID of the other user (from lookup_contact)' },
        topic:       { type: 'string', enum: ['availability', 'constraints', 'rsvp', 'coordination'], description: 'What you\'re asking about' },
        message:     { type: 'string', description: 'Your question or message to the other agent. Be specific.' },
        thread_id:   { type: 'string', description: 'Thread ID to continue an existing conversation; omit to start a new one' },
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
    name: 'update_preferences',
    description: 'Save something you learned about the user\'s preferences — allergies, dietary needs, activity likes/dislikes, vibe, budget, neighborhood, availability. Call this whenever the user mentions anything about their preferences, even casually ("I hate sushi", "I\'m usually free after 7", "I\'m allergic to nuts"). Do NOT wait to be asked — just save it.',
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
    description: 'Record an RSVP for a contact on an event when the confirmation happened outside the system (in person, verbally, via another channel). Use when the user says "Allison said she\'s in" or similar.',
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
    description: 'Send an invite SMS to a specific Tier 0 contact. This is Gate 2 of the two-gate rule — only call this when the user has explicitly asked to invite this person. Includes mandatory self-identify + STOP.',
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
        scheduled_at:  { type: 'string', description: 'ISO 8601 datetime' },
        duration_mins: { type: 'number' },
        notes:         { type: 'string' },
        contact_ids:   { type: 'array', items: { type: 'string' }, description: 'Contacts to invite (must be Tier 1+)' },
      },
      required: ['title', 'activity_type', 'scheduled_at'],
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
];

// ── Tool execution (all scoped to userId) ─────────────────────────────────────

async function executeTool(toolName, toolInput, userId, userPhone) {
  switch (toolName) {

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

    case 'lookup_contact': {
      const q = (toolInput.query || '').toLowerCase().trim();
      const allContacts = db.getContactsByUser(userId);

      // Score each contact — higher = better match
      function score(c) {
        const name = (c.name || '').toLowerCase();
        const phone = (c.phone || '');
        if (name === q) return 100;                          // exact name
        if (phone.includes(q)) return 90;                    // phone match
        if (name.startsWith(q)) return 80;                   // prefix match
        // Word-level prefix: "Allie" matches "Allison" because alli- prefix
        const prefix4 = q.slice(0, 4);
        const words = name.split(/\s+/);
        if (prefix4.length >= 3 && words.some(w => w.startsWith(prefix4))) return 60;
        // Substring anywhere
        if (name.includes(q)) return 50;
        // Query contains the contact name token (e.g. searching "allison" matches "allie")
        if (q.includes(name.split(' ')[0]) || name.split(' ')[0].includes(q.slice(0,4))) return 30;
        return 0;
      }

      const scored = allContacts
        .map(c => ({ ...c, _score: score(c) }))
        .filter(c => c._score > 0)
        .sort((a, b) => b._score - a._score)
        .slice(0, 10);

      return {
        contacts: scored,
        count: scored.length,
        tip: scored.length === 0
          ? 'No match found. Try a different spelling, full name, or phone number.'
          : 'Results ranked by match quality. If the right person isn\'t here, try their full name.',
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
      const contact = db.getContact(toolInput.contact_id);
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
      const contact = db.getContact(toolInput.contact_id);
      if (!contact) return { error: 'Contact not found' };
      if (!contact.phone) return { error: 'Contact has no phone number on file' };
      if (db.isOptedOut(contact.phone)) return { error: 'Contact has opted out' };

      let messageBody = toolInput.message;
      const user = db.getUser(userId);

      try {
        // Mandatory self-identify on first contact (§4.2)
        // NOTE: both paths go through send(), which enforces the consent gate.
        // If the contact has not opted in, ConsentRequired is thrown and caught below.
        if (toolInput.is_first_contact) {
          await sms.sendContactInvite(
            contact.phone,
            contact.name,
            user.name,
            'scheduling coordination',
            messageBody
          );
        } else {
          await sms.send(contact.phone, messageBody);
        }
        return {
          action_status: 'MESSAGE_SENT',
          sent: true,
          to: contact.phone,
          contact_name: contact.name,
          message_preview: messageBody.slice(0, 80),
        };
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
      const { contact_id, topic, message: agentMsg, thread_id } = toolInput;
      const contact = db.getContact(contact_id);
      if (!contact?.phone) return { error: 'Contact not found' };
      const targetUser = db.getUserByPhone(contact.phone);
      if (!targetUser) return { error: 'Contact is not a ButterflAI user — they need to sign up first', contact_name: contact.name };
      const msgId = db.sendAgentMessage({
        fromUserId: userId, toUserId: targetUser.id,
        threadId: thread_id, kind: 'query', topic, body: agentMsg,
      });
      // Queue message for target agent to process
      db.storeInboundMessage({
        from_phone: targetUser.phone, from_type: 'user', from_id: targetUser.id,
        channel: 'agent_query', text: `[Agent query from ${user.name}'s agent | thread=${msgId} | topic=${topic}] ${agentMsg}`,
      });
      return { sent: true, message_id: msgId, to: contact.name, note: 'Their agent will respond; watch for reply_received in next turns' };
    }

    case 'reply_agent': {
      const { message_id, body: replyBody } = toolInput;
      const original = db._raw().prepare('SELECT * FROM agent_messages WHERE id = ?').get(message_id);
      if (!original) return { error: 'Message not found' };
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
          text: `[Agent reply from ${user.name}'s agent | thread=${original.thread_id} | topic=${original.topic}] ${replyBody}`,
        });
      }
      return { replied: true, reply_id: replyId };
    }

    case 'update_preferences': {
      db.upsertPreferences(userId, toolInput);
      return { saved: true, fields: Object.keys(toolInput) };
    }

    case 'get_contact_hard_constraints': {
      // Agent-to-agent: fetch only hard constraints (allergies, diet) for a contact who is a user
      // Never exposes soft preferences or private notes
      const contact = db.getContact(toolInput.contact_id);
      if (!contact?.phone) return { error: 'Contact not found or no phone' };
      const contactUser = db.getUserByPhone(contact.phone);
      if (!contactUser) return { is_butterflai_user: false, note: 'Contact is not a ButterflAI user — ask them directly' };
      const contactPrefs = db.getPreferences(contactUser.id);
      if (!contactPrefs) return { is_butterflai_user: true, constraints_known: false };
      return {
        is_butterflai_user: true,
        constraints_known: true,
        food_allergies: contactPrefs.food_allergies || [],
        dietary_restrictions: contactPrefs.dietary_restrictions || [],
        // Deliberately omit: vibe, budget, soft preferences — those are private
      };
    }

    case 'confirm_coordination_invite': {
      const { invitation_id, status, add_to_calendar } = toolInput;
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
      // Queue as an inbound_message so the host's agent proactively processes it and
      // texts the host — without waiting for the host to ask.
      const host = db.getUser(inv.host_user_id);
      const contact = db.getContactByPhone(user.phone);
      if (host) {
        const emoji = status === 'accepted' ? '✅' : '❌';
        const ts = new Date(inv.scheduled_at * 1000).toLocaleString('en-US', {
          timeZone: host.timezone || 'America/Los_Angeles',
          weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        });
        const contactName = contact?.name || user.name;
        // Queue for host agent to process proactively
        const agentMsg = `[Agent-to-Agent RSVP] ${emoji} ${contactName} has ${status} the invite for "${inv.title}" on ${ts}. Update the host and notify them now.`;
        db.storeInboundMessage({
          from_phone: host.phone,
          from_type: 'user',
          from_id: host.id,
          channel: 'agent',
          text: agentMsg,
        });
      }

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
      const contact = db.getContactByPhone(contact_phone);
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
      return { url: `${baseUrl}/contacts-import.html?userId=${userId}` };
    }

    case 'get_pending_invites': {
      const invites = db.getPendingInvitesByUser(userId);
      return { invites };
    }

    case 'get_importable_contacts': {
      return { contacts: contactsImport.getImportableContacts(userId) };
    }

    case 'send_contact_invite': {
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
        google: `${baseUrl}/auth/google/calendar?userId=${userId}`,
        apple:  `${baseUrl}/auth/apple/calendar?userId=${userId}`,
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
      const { contact_ids, ...eventData } = toolInput;
      const eventId = multiparty.createEvent(userId, eventData);
      let inviteResult = { sent: 0, skipped: 0 };
      if (contact_ids?.length) {
        inviteResult = await multiparty.inviteContacts(eventId, contact_ids);
      }
      return {
        action_status: inviteResult.sent > 0 ? 'EVENT_CREATED_INVITES_SENT' : 'EVENT_CREATED_NO_INVITES_SENT',
        eventId,
        invites_sent: inviteResult.sent,
        invites_skipped: inviteResult.skipped,
        note: inviteResult.sent > 0
          ? `Invite(s) sent. Contacts can reply YES/NO and their response will be tracked automatically.`
          : `Event created but no invites sent (check contact_ids are valid and contacts aren't opted out).`,
      };
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
      const date    = toolInput.date || new Date().toISOString().slice(0, 10);
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

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Process a single inbound message ─────────────────────────────────────────

async function processMessage(msg) {
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

  // Build live user state snapshot — injected into system prompt so agent
  // always has current context regardless of conversation history window.
  const userTimezone = user.timezone || 'America/Los_Angeles';
  const calendarProvider   = calendar.getCalendarProvider(userId);   // 'google' | 'apple' | null
  const calendarConnected  = !!calendarProvider;
  const prefs = db.getPreferences(userId);
  const contactCount = db.getContactsByUser(userId).length;
  const pendingEvents = (() => {
    try {
      const events = multiparty.getEventsByHost(userId).filter(e => e.status === 'open');
      if (!events.length) return '  (none)';
      return events.map(e => {
        const rsvp = multiparty.getRsvpSummary(e.id);
        // Get invitee details with status
        const invitations = db._raw
          ? db._raw().prepare(`
              SELECT c.name, ei.status FROM event_invitations ei
              JOIN contacts c ON c.id = ei.contact_id
              WHERE ei.event_id = ?
            `).all(e.id)
          : [];
        const inviteeList = invitations.map(i => `${i.name} (${i.status})`).join(', ') || 'no invitees yet';
        const ts = new Date(e.scheduled_at * 1000).toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
        return `  - eventId="${e.id}" | "${e.title}" | ${ts} | invitees: ${inviteeList}`;
      }).join('\n');
    } catch (_) { return '  (none)'; }
  })();

  const userLocalTime = new Date().toLocaleString('en-US', { timeZone: userTimezone, weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  // Pending coordination: events this user was invited to by OTHER users' agents
  // Injected so this agent can act on them (update own calendar, notify host agent)
  const pendingCoordination = (() => {
    try {
      const contact = db.getContactByPhone(user.phone);
      if (!contact) return '';
      const rows = db._raw().prepare(`
        SELECT ei.id as inv_id, ei.status, se.id as event_id, se.title, se.activity_type,
               se.scheduled_at, se.venue_name, u.name as host_name
        FROM event_invitations ei
        JOIN social_events se ON se.id = ei.event_id
        JOIN users u ON u.id = se.host_user_id
        WHERE ei.contact_id = ? AND ei.notified_at > strftime('%s','now') - 604800
        ORDER BY ei.notified_at DESC LIMIT 5
      `).all(contact.id);
      if (!rows.length) return '';
      const lines = rows.map(r => {
        const ts = new Date(r.scheduled_at * 1000).toLocaleString('en-US', { timeZone: userTimezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const venue = r.venue_name ? ` at ${r.venue_name}` : '';
        return `  - inv_id="${r.inv_id}" | "${r.title}" hosted by ${r.host_name} | ${ts}${venue} | your status: ${r.status}`;
      }).join('\n');
      return `\n## You have been invited to (by other ButterflAI users)\n${lines}\n- Use confirm_coordination_invite to RSVP and optionally add to your calendar`;
    } catch (_) { return ''; }
  })();

  const agentNotes = user.agent_notes?.trim();
  const prefsSection = (() => {
    if (!prefs) return '- Preferences: not set yet (ask conversationally to learn them)';
    const parts = [];
    if (prefs.food_allergies?.length)       parts.push(`⚠️  Allergies: ${prefs.food_allergies.join(', ')}`);
    if (prefs.dietary_restrictions?.length) parts.push(`Diet: ${prefs.dietary_restrictions.join(', ')}`);
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
  })();

  const stateSnapshot = [
    `## Current state`,
    `- User timezone: ${userTimezone} (current local time: ${userLocalTime})`,
    `- Calendar: ${calendarConnected ? `✅ connected (${calendarProvider}) — can check availability & create events` : '❌ not connected — offer Google or Apple Calendar setup'}`,
    `- Contacts: ${contactCount} in address book`,
    `\n## ${user.name}'s preferences\n${prefsSection}`,
    `\n## Open events\n${pendingEvents}`,
    pendingCoordination,
    agentNotes ? `\n## Remembered facts (use these — don't ask again)\n${agentNotes}` : '',
  ].filter(Boolean).join('\n');

  // Build system prompt (lean — context comes from tools, not prompt stuffing)
  const systemPrompt = `You are ButterflAI, a personal social agent for ${user.name}.

Your job: help them stay meaningfully connected with people they care about.
You handle the logistics of friendship (scheduling, coordination, reminders) so they can focus on the emotional parts.

${stateSnapshot}


LANGUAGE & TONE:
- Users talk like real people with their friends — casual, crude, sweary, slang-heavy. Handle it naturally.
- When someone says something like "I wanna fuck Allie after beers", read the intent (they want to see her, extend the night, ask her to stay) and respond to THAT — don't refuse, don't lecture, don't get weird about it.
- You can be light about it: "Ha, want me to see if Allison wants to keep the night going after beers? 😏" — then offer to send a follow-up invite.
- You will NOT send literally inappropriate messages to contacts. But you will also NOT shut down over casual language from the user. Interpret, deflect if needed, keep moving.
- If something is genuinely impossible or harmful, say why briefly and offer an alternative. Never go full "That's not something I can help with."

PRONOUN RESOLUTION — figure out who "him/her/them" means before asking:
- When the user says "tell him", "let her know", "ask them", check the open events and recent conversation to figure out who they mean. If there's only one person recently discussed or invited to the active event, assume that's who they mean.
- Only ask "which person?" if there are genuinely multiple candidates with no clear context signal.

AGENT-TO-AGENT FIRST — talk to agents before talking to users:
- Before asking the user anything about a third party (their availability, dietary needs, preferences), use message_agent to ask THEIR agent directly.
- For planning a group event: message_agent each invitee's agent first for availability and constraints → only then suggest a plan to the user.
- When you receive an [Agent query] or [Agent reply] message, handle it autonomously: answer factual questions about your user from the preferences snapshot, use reply_agent to respond. Only involve your user if the question requires their judgment.
- Agents talking to agents: share hard constraints freely (allergies, dietary restrictions, availability). Never share soft preferences, exclusion reasons, or private notes.
- The user should feel like things just got handled — not like they're managing a group chat.

LIVE STATE OVER MEMORY — always check the snapshot:
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
4. On first contact with anyone new, include the self-identify header (is_first_contact: true in send_logistics_sms).
5. Never reveal private preferences (exclusions, private notes) to anyone other than the user. They never cross the wire to contacts or other agents.
6. If you're unsure whether something is logistics or expressive, treat it as expressive and ask for approval.
7. NEVER claim a message was sent unless the tool returned action_status: "MESSAGE_SENT". If the tool returns action_status: "NOT_SENT_CONSENT_REQUIRED" or any error, report the failure honestly. Never say "Done", "Sent", "All set" unless the tool confirmed it.
8. NEVER invent a contact's response, RSVP, or confirmation. A contact has not agreed to anything until they actually reply. Do not say "they're in" or "they'll be there" or anything implying a response you haven't received.
9. NEVER fabricate details about plans (times, venues, who's coming) that the user did not tell you or that you did not actually coordinate. Only report confirmed facts.
10. After any action (sending a message, creating a calendar event, etc.), tell the user exactly what was done and what the actual status is — not what you hope will happen.
11. Before sending a logistics SMS to a contact for the first time, call check_contact_consent. If they haven't consented, use send_contact_invite instead (which includes the required self-identify header). Never send a regular logistics SMS to someone who hasn't opted in.

COORDINATING PLANS:
- All times and dates from the user are in THEIR local timezone (shown in state snapshot). Convert to UTC unix timestamp when storing. Display times back to them in their local timezone.
- When the user wants to invite someone to an activity (beer, dinner, lunch, etc.), ALWAYS use create_social_event with contact_ids — never send_logistics_sms for an invitation. This creates the tracking record that allows RSVP replies to be recognized automatically.
- send_logistics_sms is ONLY for one-way informational messages that do NOT expect a reply: "running 10 min late", "on my way", "parking on the corner". If the message asks a question or expects a yes/no, use create_social_event instead.
- create_social_event sends the invite message automatically. Do NOT also call send_logistics_sms for the same invite.
- After create_social_event, tell the user: "I've sent [Name] an invite. I'll let you know when they respond."
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

LEARNING THE USER — build their profile over time:
- You are their long-term agent. Every conversation teaches you something. Save it.
- When the user mentions anything about preferences — food, activities, schedule, budget, vibe — call update_preferences immediately. Don't wait for a natural pause. Just save it.
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

STYLE: Concise, warm, competent. SMS-length replies. No filler words.`;

  // Load recent conversation history so the agent has context across SMS turns
  const history = db.getRecentConversation(userId, 50);
  const messages = [
    ...history.map(h => ({ role: h.role, content: h.text })),
    { role: 'user', content: msg.text },
  ];

  // Store this inbound message in conversation history
  db.appendConversation(userId, 'user', msg.text);

  // Agentic loop — run until Claude stops calling tools
  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    // Accumulate assistant turn
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      // Extract text response and send to user.
      // Use sendUnchecked — agent only processes established users who consented at onboarding.
      const textBlocks = response.content.filter(b => b.type === 'text');
      const replyText = textBlocks.map(b => b.text).join('\n').trim();
      if (replyText) {
        // Store reply in conversation history before sending
        db.appendConversation(userId, 'assistant', replyText);
        if (userPhone) {
          console.log(`[agent] replying to ${userPhone}: "${replyText.slice(0, 60)}"`);
          await sms.sendUnchecked(userPhone, replyText);
        }
      }
      break;
    }

    if (response.stop_reason === 'tool_use') {
      // Execute all tool calls in this turn
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        let result;
        try {
          result = await executeTool(block.name, block.input, userId, userPhone);
        } catch (err) {
          console.error(`[agent] tool error ${block.name}:`, err.message);
          result = { error: err.message };
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

    // Unexpected stop reason
    console.warn(`[agent] unexpected stop_reason=${response.stop_reason}`);
    break;
  }

  if (iterations >= MAX_ITERATIONS) {
    console.error(`[agent] hit MAX_ITERATIONS for message ${msg.id}`);
    if (userPhone) {
      await sms.notifyUser(userPhone, `Something went wrong on my end — I'll try again shortly. Sorry!`);
    }
  }
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
        console.error(`[agent] failed to process message ${msg.id}:`, err.message);
      } finally {
        db.markMessageProcessed(msg.id);
      }
    }
  } finally {
    processing = false;
  }
}

function startAgentLoop() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[agent] ANTHROPIC_API_KEY not set — agent loop disabled');
    return;
  }
  console.log(`[agent] starting loop (poll every ${POLL_INTERVAL_MS}ms, model=${MODEL})`);
  setInterval(tick, POLL_INTERVAL_MS);
  tick(); // run immediately on start
}

module.exports = { startAgentLoop, processMessage, tick };
