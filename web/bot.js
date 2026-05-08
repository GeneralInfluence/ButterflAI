/**
 * ButterflAI Telegram Bot
 *
 * Handles:
 *  - /start {contact_id}  — link a contact's Telegram chat_id after invite form
 *  - Inline button callbacks (Yes/No to activity proposals)
 *  - Free-text replies from Tier 1 contacts (routed to agent)
 */

const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'butterflai-secret';

if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

// Webhook mode for production (polling for local dev)
const bot = process.env.NODE_ENV === 'production'
  ? new TelegramBot(TOKEN, { webHook: { port: false } })  // express handles routing
  : new TelegramBot(TOKEN, { polling: true });

// ── /start handler ────────────────────────────────────────────────────────────

bot.onText(/\/start ?(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  const param = match[1]?.trim();

  // Deep link activation: /start contact_{contactId}
  if (param?.startsWith('contact_')) {
    const contactId = param.replace('contact_', '');
    const contact = db.getContact(contactId);

    if (!contact) {
      return bot.sendMessage(chatId,
        "Hmm, I can't find that invite. The link may have expired — ask your friend to send a new one."
      );
    }

    if (contact.tier === 0) {
      return bot.sendMessage(chatId, "You've opted out of ButterflAI. Nothing to do here!");
    }

    // Link their Telegram chat_id
    db.setContactTelegramId(contactId, telegramId, chatId);

    const inviter = db.getUser(contact.invited_by_user_id);
    const inviterName = inviter?.name || 'Your friend';

    await bot.sendMessage(chatId,
      `👋 Hey ${contact.name}! You're all set.\n\n` +
      `${inviterName}'s ButterflAI will reach out when they want to make plans. ` +
      `You'll get a message here with options — just tap a button or reply. No spam, just scheduling. 🦋`,
      { parse_mode: 'Markdown' }
    );

    // Notify inviter
    if (inviter?.telegram_chat_id) {
      await bot.sendMessage(inviter.telegram_chat_id,
        `✅ *${contact.name}* is now connected on Telegram! I can reach out to coordinate plans whenever you're ready.`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }

  // Deep link activation: /start user_{userId} (full signup path)
  if (param?.startsWith('user_')) {
    const userId = param.replace('user_', '');
    const user = db.getUser(userId);

    if (!user) {
      return bot.sendMessage(chatId, "I can't find that account. Try signing up again.");
    }

    db.setUserTelegramChatId(userId, telegramId, chatId);

    await bot.sendMessage(chatId,
      `🦋 *Welcome to ButterflAI, ${user.name}!*\n\n` +
      `I'm your social agent. I'll help you:\n` +
      `• Keep up with friends on your schedule\n` +
      `• Coordinate plans without the back-and-forth\n` +
      `• Discover new experiences through your network\n\n` +
      `To get started, tell me about a friend you want to keep in touch with — ` +
      `their name and how often you'd like to see them.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Generic /start (no param — someone found the bot directly)
  await bot.sendMessage(chatId,
    `🦋 *Hi! I'm ButterflAI.*\n\n` +
    `I'm a social agent — I help people stay connected with their friends without the scheduling chaos.\n\n` +
    `To get started, you'll need an invite from a friend who's already on ButterflAI.`,
    { parse_mode: 'Markdown' }
  );
});

// ── Inline button callbacks ───────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const telegramId = String(query.from.id);
  const data = query.data; // e.g. "activity_accept:activityId" or "activity_decline:activityId"

  await bot.answerCallbackQuery(query.id);

  if (data.startsWith('activity_accept:')) {
    const activityId = data.split(':')[1];
    const activity = db.getActivity(activityId);
    if (!activity) return bot.sendMessage(chatId, "Hmm, I can't find that plan. It may have changed.");

    db.updateActivityResponse(activityId, telegramId, 'accepted');

    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id
    });
    await bot.sendMessage(chatId,
      `✅ *You're in!* I'll send you the details once everything's confirmed.`,
      { parse_mode: 'Markdown' }
    );

    // Notify the organiser's agent
    notifyOrganiser(activity, telegramId, 'accepted');
    return;
  }

  if (data.startsWith('activity_decline:')) {
    const activityId = data.split(':')[1];
    const activity = db.getActivity(activityId);
    if (!activity) return;

    db.updateActivityResponse(activityId, telegramId, 'declined');

    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id
    });
    await bot.sendMessage(chatId,
      `No worries! I'll let them know and maybe suggest another time. 👍`,
    );

    notifyOrganiser(activity, telegramId, 'declined');
    return;
  }

  if (data.startsWith('time_pick:')) {
    // Format: "time_pick:{activityId}:{slotIndex}"
    const [, activityId, slotIndex] = data.split(':');
    const activity = db.getActivity(activityId);
    if (!activity) return;

    db.setActivityTimeChoice(activityId, telegramId, parseInt(slotIndex));

    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id
    });

    const slots = JSON.parse(activity.proposed_slots || '[]');
    const chosen = slots[parseInt(slotIndex)];
    await bot.sendMessage(chatId,
      `👍 *${chosen}* works for me! I'll confirm with everyone and send details.`,
      { parse_mode: 'Markdown' }
    );

    notifyOrganiser(activity, telegramId, 'time_chosen', slotIndex);
    return;
  }
});

// ── Free-text replies from contacts ──────────────────────────────────────────

bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return; // already handled

  const telegramId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = msg.text || '';

  const contact = db.getContactByTelegramId(telegramId);
  const user = contact ? null : db.getUserByTelegramId(telegramId);

  if (!contact && !user) {
    return bot.sendMessage(chatId,
      "I don't have you in my system yet. You'll need an invite link from a friend to get started. 🦋"
    );
  }

  // Store the message for the agent to process
  db.storeInboundMessage({
    from_telegram_id: telegramId,
    from_type: contact ? 'contact' : 'user',
    from_id: contact?.id || user?.id,
    text,
    chat_id: chatId,
  });

  // Simple acknowledgement — the agent will follow up
  await bot.sendMessage(chatId, `Got it! I'll pass that along. 👍`);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function notifyOrganiser(activity, responderTelegramId, response, extra) {
  const organiser = db.getActivityOrganiser(activity.id);
  if (!organiser?.telegram_chat_id) return;

  const responder = db.getContactByTelegramId(responderTelegramId) ||
                    db.getUserByTelegramId(responderTelegramId);
  const name = responder?.name || 'Someone';

  const messages = {
    accepted: `✅ *${name}* is in for ${activity.activity_type}!`,
    declined: `❌ *${name}* can't make it for ${activity.activity_type}. Want me to propose another time?`,
    time_chosen: `📅 *${name}* chose a time for ${activity.activity_type}. Waiting on others...`,
  };

  await bot.sendMessage(organiser.telegram_chat_id,
    messages[response] || `Update from ${name}.`,
    { parse_mode: 'Markdown' }
  );
}

// ── Outbound helpers (called by agent) ───────────────────────────────────────

/**
 * Send an activity proposal to a contact with Accept/Decline buttons.
 */
async function proposeActivity({ chatId, activityId, activityType, venue, dateTime, organiserName }) {
  await bot.sendMessage(chatId,
    `📅 *${organiserName}'s ButterflAI here!*\n\n` +
    `${organiserName} would love to grab *${activityType}* with you:\n\n` +
    `📍 ${venue}\n🕐 ${dateTime}\n\nWork for you?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ I\'m in!', callback_data: `activity_accept:${activityId}` },
          { text: '❌ Can\'t make it', callback_data: `activity_decline:${activityId}` },
        ]]
      }
    }
  );
}

/**
 * Send time slot options to a contact.
 */
async function proposeTimeSlots({ chatId, activityId, activityType, organiserName, slots }) {
  const buttons = slots.map((slot, i) => ([
    { text: slot, callback_data: `time_pick:${activityId}:${i}` }
  ]));

  await bot.sendMessage(chatId,
    `🦋 *${organiserName}'s ButterflAI here!*\n\n` +
    `${organiserName} wants to plan *${activityType}* — pick a time that works for you:`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    }
  );
}

/**
 * Send a plain message (confirmation, reminder, etc.)
 */
async function sendMessage(chatId, text) {
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

module.exports = { bot, proposeActivity, proposeTimeSlots, sendMessage };
