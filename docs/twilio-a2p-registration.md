# Twilio A2P 10DLC Registration — Social ButterflAI

> This document captures all the information needed to complete Twilio's
> A2P 10DLC **Brand** and **Campaign** registration for Social ButterflAI.
> Fill in the bracketed fields from your Twilio Console before submitting.

---

## Part 1 — Brand Registration

Brand registration establishes the legal entity behind the messaging traffic.

| Field | Value |
|---|---|
| **Legal Company Name** | [Your LLC / Corp name, e.g. "Social ButterflAI, Inc."] |
| **DBA / Brand Name** | Social ButterflAI / ButterflAI |
| **Website** | [https://your-fly-app.fly.dev or custom domain] |
| **Business Type** | Private Company |
| **Company Address** | [Registered address of your LLC/Corp] |
| **EIN / Tax ID** | [Your US EIN — required for US-based brands] |
| **Vertical / Industry** | Social / Relationship Management |
| **Stock Symbol** | *(not publicly traded — leave blank)* |
| **Brand Tier** | Standard (or Low-Volume Standard if <6k msgs/day initially) |

---

## Part 2 — Campaign Registration

Each campaign maps to a specific use case. ButterflAI has two distinct flows:

### Campaign A — User Onboarding & Agent Interaction (Primary)

This campaign covers messages between **ButterflAI and its registered users** (the people who sign up for the service).

| Field | Value |
|---|---|
| **Use Case** | Mixed / Conversational (or "App Notifications" if mixed is unavailable) |
| **Campaign Description** | ButterflAI is a personal social agent that helps users stay connected with friends and family. This campaign carries two-way conversational messages between the ButterflAI AI agent and the registered user: relationship nudges ("you haven't talked to Alex in a while"), scheduling coordination, RSVP confirmations, and calendar reminders. Users opt in via the ButterflAI web app by entering and verifying their mobile number. |
| **Message Flow** | User signs up at the ButterflAI web app → enters phone number → receives OTP → verifies → opts in to SMS from their agent. After onboarding, the agent sends contextual nudges and handles two-way scheduling via SMS. |
| **Subscriber Opt-In** | Web form on [https://your-domain/join] — user enters phone number and explicitly checks "I agree to receive SMS messages from my ButterflAI agent." |
| **Subscriber Opt-Out** | Reply **STOP** to any message. Immediately recorded in the database; no further messages sent from this number. Hard-blocked at the application layer (not just Twilio's built-in stop handling). |
| **Subscriber Help** | Reply **HELP** for assistance — agent responds with support URL and STOP instructions. |

**Sample Messages — Campaign A:**

> *Sample 1 (nudge):*
> ButterflAI: Hey! It's been about 6 weeks since you last caught up with Marcus. Want me to suggest a time this weekend? Reply YES to get options or STOP to unsubscribe.

> *Sample 2 (scheduling confirmation):*
> ButterflAI: Confirmed ✓ — Lunch with Jordan on Saturday Dec 14 at 1pm, Tartine Manufactory. I'll send a reminder Friday morning. Reply CHANGE to adjust or STOP to unsubscribe.

> *Sample 3 (inbound-driven):*
> ButterflAI: Got it! I'll reach out to Sofia to find a time. I'll let you know when she responds. Reply STOP to unsubscribe.

---

### Campaign B — Contact Coordination (Secondary / Outbound to 3rd Parties)

This campaign covers messages sent **from ButterflAI to the user's contacts** (people the user wants to schedule with). These contacts are NOT registered ButterflAI users — they are being messaged on behalf of the user.

| Field | Value |
|---|---|
| **Use Case** | Mixed / Notifications |
| **Campaign Description** | ButterflAI sends coordination messages to a registered user's contacts on that user's behalf. Examples include scheduling invites and RSVP requests for social gatherings. Every first-contact message identifies the agent and its nature, names the user it's acting for, and provides an unconditional STOP opt-out. Contacts are never messaged without the registered user explicitly initiating the action. No bulk blasts. Each message is triggered by a specific user action and directed at one named individual. |
| **Message Flow** | Registered user initiates a "reach out to [contact]" action in the app → ButterflAI checks consent record → if first contact: sends self-identifying message + STOP → if contact replies STOP: permanently blocked → if contact engages: continues coordination on behalf of user. |
| **Subscriber Opt-In** | No pre-opt-in required for the initial contact message (it IS the opt-in solicitation). The first message is always a self-identifying outreach that names the user and offers STOP. Continued reply-based engagement constitutes implicit consent to the ongoing coordination thread. |
| **Subscriber Opt-Out** | Reply **STOP** at any time. Immediately and permanently blocked at the application layer. User is notified their contact has opted out. |
| **Subscriber Help** | Reply **HELP** — agent responds with identity of the user it's acting for + a URL where the contact can view/edit/erase their data. |

**Sample Messages — Campaign B:**

> *Sample 1 (first-touch invite):*
> Hi Sofia! This is Sean's ButterflAI assistant reaching out for him — he'd love to grab dinner sometime this month. Does any weekend work for you? View or erase your data: https://butterflai.app/contact-portal/[token] Reply STOP and I won't message you again.

> *Sample 2 (follow-up after RSVP):*
> Hi Jordan! Sean's ButterflAI here — just confirming Saturday Dec 14 at 1pm at Tartine. Does that still work? Reply YES / NO / or suggest another time. Reply STOP to unsubscribe.

> *Sample 3 (STOP acknowledgement):*
> Got it — you've been removed from Sean's ButterflAI list and won't receive any more messages from this number on his behalf. To re-subscribe, reply START.

---

## Part 3 — Opt-In Language (for web form)

Place this on your `/join` and `/invite` pages where users/contacts enter their phone number:

```
By entering your phone number and clicking "Continue", you agree to receive
SMS messages from ButterflAI (your personal social agent) at the number
provided. Message frequency varies. Message and data rates may apply.
Reply STOP to cancel, HELP for help.
Privacy Policy: [URL]  Terms of Service: [URL]
```

---

## Part 4 — Standard Compliance Responses

These exact responses must be returned by your application when a user texts the keywords:

| Keyword | Required Response |
|---|---|
| **STOP** | "You have been unsubscribed from ButterflAI messages. You will receive no further messages. Reply START to resubscribe." |
| **START** | "You have re-subscribed to ButterflAI messages. Reply STOP at any time to unsubscribe." |
| **HELP** | "ButterflAI — your personal social agent. For support: [support URL]. Reply STOP to unsubscribe. Msg&data rates may apply." |

---

## Part 5 — Supporting URLs

These pages must be live (publicly accessible, no login) before submitting:

| Page | URL | Status |
|---|---|---|
| Privacy Policy | [https://your-domain/privacy] | ✅ Built (`/public/privacy.html`) |
| Terms of Service | [https://your-domain/terms] | ✅ Built (`/public/terms.html`) |
| Contact Portal (for contacts to view/edit/erase data) | [https://your-domain/contact-portal/:token] | ✅ Built |

---

## Part 6 — Volume & Throughput Estimates

| Metric | Estimate |
|---|---|
| **Messages per day (Campaign A)** | < 500 initially (scales with user growth) |
| **Messages per day (Campaign B)** | < 200 initially (1–3 contacts per user action) |
| **Peak messages per minute** | < 10 |
| **Phone number type** | 10DLC long code (US only for v1) |
| **Messaging Service SID** | Create one Messaging Service in Twilio Console and assign your number to it |

---

## Checklist Before Submitting

- [ ] Business is registered (LLC/Corp) with EIN
- [ ] Privacy Policy is live and publicly accessible
- [ ] Terms of Service is live and publicly accessible
- [ ] STOP / START / HELP auto-responses are implemented in `sms.js` (they are — see `server.js` inbound handler)
- [ ] Opt-in language is on the web form
- [ ] Contact portal is live for contact-side data access
- [ ] Twilio Messaging Service created and number assigned
- [ ] `TWILIO_FROM_NUMBER` set to the registered 10DLC number in Fly.io secrets

---

*Last updated: 2026-06-18 | Maintained by the ButterflAI agent*
