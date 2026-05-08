#!/usr/bin/env node
/**
 * Register the Telegram webhook with Telegram's servers.
 * Run once after deploy: node scripts/register-webhook.js
 */
require('dotenv').config({ path: '../web/.env' });

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;
const SECRET = process.env.WEBHOOK_SECRET || 'butterflai-secret';

if (!TOKEN || !BASE_URL) {
  console.error('Set TELEGRAM_BOT_TOKEN and BASE_URL in web/.env');
  process.exit(1);
}

const webhookUrl = `${BASE_URL}/webhook/telegram/${SECRET}`;

async function register() {
  const url = `https://api.telegram.org/bot${TOKEN}/setWebhook`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
    }),
  });
  const data = await res.json();

  if (data.ok) {
    console.log('✅ Webhook registered:', webhookUrl);
  } else {
    console.error('❌ Failed:', data.description);
    process.exit(1);
  }
}

async function status() {
  const url = `https://api.telegram.org/bot${TOKEN}/getWebhookInfo`;
  const res = await fetch(url);
  const data = await res.json();
  console.log('Webhook info:', JSON.stringify(data.result, null, 2));
}

const cmd = process.argv[2];
if (cmd === 'status') status();
else register();
