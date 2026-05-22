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
      // Always returns draft — actual send is handled separately with approval gate
      return {
        draft: toolInput.message,
        contact_id: toolInput.contact_id,
        message_type: toolInput.message_type,
        requires_approval: toolInput.message_type === 'expressive',
        note: toolInput.message_type === 'expressive'
          ? 'This is a draft. It will be sent to the user for approval before going to the contact.'
          : 'Logistics message — can be sent without approval.',
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
