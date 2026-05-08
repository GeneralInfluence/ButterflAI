# ButterflAI

> Your personal social agent. Maximize fun per dollar.

## Architecture

- **Web** (`/web`) — Invite & onboarding pages, agent API. Node/Express.
- **DB** (`/db`) — SQLite schema (pinata-sqlite compatible).
- **Agent** (`/agent`) — OpenClaw agent skills (coming next).
- **Infra** — Fly.io (always-on), ClawBank (identity + budget, Phase II).

## Contact Tiers

| Tier | Description | How agent reaches them |
|------|-------------|----------------------|
| 0 | Opted out | Never |
| 1 | Contact mode | Direct Telegram |
| 2 | Full ButterflAI | Agent-to-agent (signed via ClawBank wallet) |

## Local Dev

```bash
cd web
cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN
npm install
npm run dev
# → http://localhost:3000/invite/test-token
```

## Deploy to Fly.io

```bash
# One-time setup
fly auth login
fly launch --no-deploy        # creates app, reads fly.toml
fly volumes create butterflai_data --size 1 --region ewr

# Set secrets
fly secrets set TELEGRAM_BOT_TOKEN=your_token
fly secrets set BASE_URL=https://butterflai.fly.dev

# Deploy
fly deploy
```

## Invite Flow

1. Agent calls `POST /api/agent/invite/create` with `userId` + optional `contactName`
2. Returns `{ token, url }` — share the URL with your friend
3. Friend lands on `/invite/:token` and picks a tier
4. Agent is notified via Telegram

## Next Steps

- [ ] Telegram bot webhook (receive replies from Tier 1 contacts)
- [ ] Agent skill: detect overdue cadences, generate invites
- [ ] Scheduling logic: propose times, confirm, book
- [ ] Venue discovery (Yelp/Google Places)
- [ ] ClawBank wallet for agent identity signing
- [ ] Agent-to-agent protocol (Tier 2)
