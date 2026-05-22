#!/bin/sh
# ButterflAI — first-time Fly.io deploy
#
# Prerequisites:
#   brew install flyctl   (or https://fly.io/docs/hands-on/install-flyctl/)
#   fly auth login
#
# Run once. After this, use: fly deploy

set -e
APP="butterflai"
REGION="ewr"
VOLUME_SIZE_GB=3

echo "==> Creating Fly app (if not already created)"
fly apps create "$APP" --org personal 2>/dev/null || echo "App already exists, continuing."

echo "==> Creating persistent volume for SQLite"
fly volumes create butterflai_data \
  --app "$APP" \
  --size "$VOLUME_SIZE_GB" \
  --region "$REGION" \
  2>/dev/null || echo "Volume may already exist, continuing."

echo ""
echo "==> NEXT: Set your secrets"
echo "    Edit scripts/set-secrets.sh with real values, then run it."
echo ""
echo "==> THEN: Deploy"
echo "    fly deploy"
echo ""
echo "==> THEN: Configure Twilio webhook"
echo "    In the Twilio console, set your number's SMS webhook to:"
echo "    https://${APP}.fly.dev/sms"
echo "    HTTP POST, application/x-www-form-urlencoded"
echo ""
echo "==> THEN: Configure Google OAuth"
echo "    In Google Cloud Console → APIs & Services → Credentials:"
echo "    Add authorised redirect URI: https://${APP}.fly.dev/auth/google/callback"
echo "    Enable: Google Calendar API, People API, Places API (New)"
