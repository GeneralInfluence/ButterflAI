const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

let bot;
if (TOKEN) {
  bot = new TelegramBot(TOKEN, { polling: false });
  console.log('Telegram bot ready');
} else {
  console.warn('TELEGRAM_BOT_TOKEN not set — Telegram notifications disabled');
}

/**
 * Send a notification to a user via their Telegram chat ID.
 */
async function notifyUser(telegramId, message) {
  if (!bot) return;
  try {
    await bot.sendMessage(telegramId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(`Telegram notify failed for ${telegramId}:`, err.message);
  }
}

/**
 * Send an interactive message with inline buttons.
 * options: [{ text: 'Label', callback_data: 'value' }]
 */
async function sendWithOptions(telegramId, message, options) {
  if (!bot) return;
  const keyboard = {
    inline_keyboard: [options.map(o => ({ text: o.text, callback_data: o.callback_data }))]
  };
  try {
    await bot.sendMessage(telegramId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error(`Telegram sendWithOptions failed for ${telegramId}:`, err.message);
  }
}

module.exports = { notifyUser, sendWithOptions };
