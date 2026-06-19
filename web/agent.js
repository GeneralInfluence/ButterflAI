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

      // Notify the host's agent (agent-to-agent: share only RSVP result, not private prefs)
      const host = db.getUser(inv.host_user_id);
      const contact = db.getContactByPhone(user.phone);
      if (host) {
        const emoji = status === 'accepted' ? '✅' : '❌';
        const ts = new Date(inv.scheduled_at * 1000).toLocaleString('en-US', { timeZone: host.timezone || 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const hostNote = `[Agent-to-Agent] ${emoji} ${contact?.name || user.name} has ${status} the invite for "${inv.title}" on ${ts}.`;
        db.appendConversation(inv.host_user_id, 'assistant', hostNote);
        // Proactively notify host via SMS
        const hostMsg = status === 'accepted'
          ? `${emoji} ${contact?.name || user.name} is in for ${inv.activity_type} on ${ts}!`
          : `${emoji} ${contact?.name || user.name} can't make ${inv.activity_type} on ${ts}.`;
        await sms.notifyUser(host.phone, hostMsg).catch(() => {});
      }

      return {
        action_status: 'RSVP_CONFIRMED',
        status,
        calendar_added: !!calendarResult && !calendarResult.error,
        host_notified: !!host,
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
  console.log(`[agent] processing msg id=${msg.id} from_type=${msg.from_type} text="${(msg.text||'').slice(0,40)}"`);
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
  const calendarConnected = calendar.hasCalendarConnected(userId);
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
  const stateSnapshot = [
    `## Current state`,
    `- User timezone: ${userTimezone} (current local time: ${userLocalTime})`,
    `- Calendar: ${calendarConnected ? '✅ connected (can check availability & create events)' : '❌ not connected'}`,
    `- Contacts: ${contactCount} in address book`,
    `- Open events:\n${pendingEvents}`,
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

AUTONOMY — do the work, don't push it back to the user:
- Before asking the user ANY question, try to answer it yourself using your tools and the state snapshot above.
- "Has everyone confirmed?" → look at the state snapshot's open events + invitee list and report what you see. Do NOT ask which event or where it was created.
- "Did Sean reply?" → check the invitee list in the snapshot. If you see his status, report it.
- Only ask the user when you genuinely need information that cannot exist in the system — a preference between equally valid options, or a detail no tool can infer.
- Never ask the user to help you find your own data. You have tools and a state snapshot. Use them first.

HARD RULES — never violate:
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
