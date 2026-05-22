#!/bin/sh
# ButterflAI — set all Fly.io secrets
#
# Usage: fill in each value below, then run:
#   chmod +x scripts/set-secrets.sh
#   ./scripts/set-secrets.sh
#
# Secrets are encrypted at rest by Fly and injected as env vars at runtime.
# Never commit real values here — this file is a template.
#
# To view current secrets (names only):  fly secrets list
# To remove a secret:                    fly secrets unset SECRET_NAME

set -e
APP="butterflai"

fly secrets set --app "$APP" \
  \
  # ── Twilio ────────────────────────────────────────────────────────────────
  TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  TWILIO_AUTH_TOKEN="your_twilio_auth_token" \
  TWILIO_FROM_NUMBER="+15551234567" \
  \
  # ── KMS (local mode — generate with the command below) ───────────────────
  # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  KMS_MASTER_KEY_HEX="replace_with_64_hex_chars" \
  \
  # ── Anthropic ─────────────────────────────────────────────────────────────
  ANTHROPIC_API_KEY="sk-ant-..." \
  \
  # ── Google OAuth (Calendar + Contacts) ───────────────────────────────────
  GOOGLE_CLIENT_ID="your_client_id.apps.googleusercontent.com" \
  GOOGLE_CLIENT_SECRET="your_client_secret" \
  GOOGLE_REDIRECT_URI="https://butterflai.fly.dev/auth/google/callback" \
  \
  # ── Google Places API ─────────────────────────────────────────────────────
  GOOGLE_PLACES_API_KEY="your_places_api_key" \
  \
  # ── App ───────────────────────────────────────────────────────────────────
  BASE_URL="https://butterflai.fly.dev" \
  WEBHOOK_SECRET="$(openssl rand -hex 32)"

echo "Secrets set for $APP"
