# ButterflAI 🦋

> *The agent does the logistics of friendship so you can do the emotional part.*

A personal social agent that helps you stay meaningfully connected with people you care about. Handles the scheduling, coordination, and nudging — you handle the actual friendship.

---

## How it works

You text your ButterflAI (SMS). It remembers who you want to stay in touch with and how often, checks your calendar, reaches out to coordinate, and surfaces a confirmation before sending anything that sounds like it came from you.

**The hard rules:**
- Logistics run automatically. Anything with sentiment? You approve it first.
- Every first outbound message self-identifies as an agent and offers STOP.
- Contacts can view, edit, or erase their data at any time — no going through you.
- Private preferences (exclusions, private notes) are encrypted at rest and every access is logged.

---

## Stack

| Layer | Tech |
|-------|------|
| Web / webhook server | Node.js + Express |
| Database | SQLite (persistent Fly.io volume) |
| Human channel | SMS via Twilio |
| Agent brain | Claude (claude-3-5-haiku for speed, configurable) |
| Calendar | Google Calendar API (OAuth2, read + write) |
| Contacts import | Google People API |
| Venue suggestions | Google Places API (New) |
| Encryption | AES-256-GCM, KMS-wrapped data keys |
| Hosting | Fly.io |

---

## Deploy (first time)

### 1. Install flyctl and log in
```sh
brew install flyctl
fly auth login
```

### 2. Create app + volume
```sh
./scripts/first-deploy.sh
```

### 3. Set secrets
Edit `scripts/set-secrets.sh` with real values, then:
```sh
./scripts/set-secrets.sh
```

**Secrets required:**

| Secret | Where to get it |
|--------|----------------|
| `TWILIO_ACCOUNT_SID` | [Twilio Console](https://console.twilio.com) |
| `TWILIO_AUTH_TOKEN` | Twilio Console |
| `TWILIO_FROM_NUMBER` | Your Twilio phone number (E.164) |
| `KMS_MASTER_KEY_HEX` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com) |
| `GOOGLE_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `https://butterflai.fly.dev/auth/google/callback` |
| `GOOGLE_PLACES_API_KEY` | Google Cloud Console (enable "Places API (New)") |
| `BASE_URL` | `https://butterflai.fly.dev` |
| `WEBHOOK_SECRET` | Any random string |

### 4. Configure Google Cloud
In [Google Cloud Console](https://console.cloud.google.com):
- Enable: **Google Calendar API**, **People API**, **Places API (New)**
- OAuth consent screen: add scopes `calendar.readonly`, `calendar.events`, `contacts.readonly`
- Authorised redirect URI: `https://butterflai.fly.dev/auth/google/callback`

### 5. Deploy
```sh
fly deploy
```

### 6. Configure Twilio webhook
In [Twilio Console](https://console.twilio.com) → Phone Numbers → your number → Messaging:
- **Webhook URL:** `https://butterflai.fly.dev/sms`
- **HTTP method:** POST
- **Content type:** application/x-www-form-urlencoded

### 7. Verify
```sh
fly logs                      # watch live logs
curl https://butterflai.fly.dev/health   # should return {"ok":true,...}
```

---

## Ongoing deploys
```sh
fly deploy          # build + deploy latest
fly logs            # tail logs
fly secrets list    # check secret names (never shows values)
fly ssh console     # shell into running machine
```

---

## Architecture

```
Inbound SMS (Twilio) ──► POST /sms
                          │
                          ├─ STOP?          → opt-out registry
                          ├─ Contact phone? → RSVP handler
                          ├─ Onboarding?    → state machine
                          ├─ Pending action?→ approval resolver
                          └─ Established    → inbound_messages queue
                                                     │
                                   Agent loop (5s poll)
                                   Claude (haiku) + tools
                                   └─ reply via SMS

Background loops:
  Cadence engine (4h) ──► find overdue relationships → SMS nudge to user
```

**Privacy model in one sentence:** *ButterflAI holds the keys and can technically read private data — we chose this so the agent can act autonomously over SMS. Revocation is trust-based. Every decrypt is logged. You can review the audit trail anytime.*

---

## Key files

| File | Purpose |
|------|---------|
| `web/server.js` | Express routes + OAuth callbacks + startup |
| `web/agent.js` | Claude agent loop + all tool implementations |
| `web/onboarding.js` | SMS onboarding state machine |
| `web/cadence.js` | "It's been a while" nudge engine |
| `web/calendar.js` | Google Calendar OAuth + availability + events |
| `web/contacts-import.js` | Two-gate contact ingestion + invite dispatch |
| `web/venues.js` | Favorites + Google Places venue suggestions |
| `web/multiparty.js` | Social events + RSVP + pull-not-push gate |
| `web/crypto.js` | AES-256-GCM + KMS-wrapped encryption |
| `web/sms.js` | Twilio wrapper (always self-identifies on first contact) |
| `web/db.js` | All SQL |
| `db/schema.sql` | Full schema |
| `db/migrations/` | Safe incremental migrations for existing DBs |

---

## Open questions (do not act unilaterally)

See `MEMORY.md` §5 for the full list. Key blockers:

- **Q1** — Agent-to-agent non-retention enforcement (blocks Tier 2 live coordination)
- **Q2** — Network-graph consent (blocks cross-user venue aggregation)

---

## What's not built yet

- MCP agent-to-agent coordination (design only — blocked on Q1)
- Real KMS (AWS/GCP) — currently using local dev KMS
- Venue reservation booking (OpenTable/Resy)
- Security page / SOC2 intent
