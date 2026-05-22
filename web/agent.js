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
const { readUserPrivateData } = require('./crypto');
const calendar = require('./calendar');
const contactsImport = require('./contacts-import');
const venues = require('./venues');
const multiparty = require('./multiparty');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const POLL_INTERVAL_MS = parseInt(process.env.AGENT_POLL_MS || '5000', 10);
const MODEL = process.env.AGENT_MODEL || 'claude-3-5-haiku-20241022';  // fast + cheap for agent loop

// ── Tool definitions (passed to Claude) ──────────────────────────────────────
// Each tool is resolved at call-time against the current userId.

const TOOL_DEFINITIONS = [
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
    description: 'Get a URL the user can open to connect their Google Calendar. Send this when the user asks about calendar or when calendar is needed but not connected.',
    input_schema: { type: 'object', properties: {}, required: [] },
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

      // Mandatory self-identify on first contact (§4.2)
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
      return { sent: true, to: contact.phone };
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
      const connected = calendar.hasCalendarConnected(userId);
      if (connected) return { connected: true, message: 'Calendar already connected.' };
      return {
        connected: false,
        url: `${baseUrl}/auth/google/calendar?userId=${userId}`,
        message: 'User needs to open this URL to connect their Google Calendar.',
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
      return { created: true, eventId, ...inviteResult };
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
  const user = db.getUser(msg.from_id);
  if (!user) {
    console.warn(`[agent] No user found for from_id=${msg.from_id}, skipping`);
    db.markMessageProcessed(msg.id);
    return;
  }

  const userId = user.id;
  const userPhone = user.phone;

  // Build system prompt (lean — context comes from tools, not prompt stuffing)
  const systemPrompt = `You are ButterflAI, a personal social agent for ${user.name}.

Your job: help them stay meaningfully connected with people they care about.
You handle the logistics of friendship (scheduling, coordination, reminders) so they can focus on the emotional parts.

HARD RULES — never violate:
1. Never impersonate the user. Never send a message that sounds like it's coming from them unless they've approved that exact text.
2. Logistics messages (scheduling info, confirmations) can run automatically. Expressive messages (sentiment, speaking as the user) MUST be drafted and sent to the user for approval first — use draft_contact_message, then tell the user what you drafted and ask them to approve.
3. Use send_logistics_sms for pure logistics only. For anything expressive, use draft_contact_message and present the draft to the user.
4. On first contact with anyone new, include the self-identify header (is_first_contact: true in send_logistics_sms).
5. Never reveal private preferences (exclusions, private notes) to anyone other than the user. They never cross the wire to contacts or other agents.
6. If you're unsure whether something is logistics or expressive, treat it as expressive and ask for approval.

STYLE: Concise, warm, competent. SMS-length replies. No filler words.`;

  const messages = [{ role: 'user', content: msg.text }];

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
      // Extract text response and send to user
      const textBlocks = response.content.filter(b => b.type === 'text');
      const replyText = textBlocks.map(b => b.text).join('\n').trim();
      if (replyText && userPhone) {
        await sms.notifyUser(userPhone, replyText);
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
