# SMS Debugging Lessons — June 18, 2026

This document captures hard-won lessons from a 3-hour debugging session getting
inbound SMS webhooks working on A2P 10DLC Twilio long codes on Fly.io. Future
agents: read this before touching the SMS stack.

---

## The Bug Chain (in order they were found)

### 1. Messaging Service swallows inbound webhooks

**Symptom:** Twilio shows `status: received` for inbound messages, but the webhook
is never called, no 11200 alerts, no replies.

**Root cause:** When a phone number is added to a Twilio Messaging Service (e.g. for
A2P 10DLC campaign registration), the Messaging Service's `inbound_request_url` takes
precedence over the phone number's own `sms_url`. If the service was created without
configuring `inbound_request_url` (which the Twilio A2P registration UI does NOT do
automatically), all inbound messages are silently dropped.

**Fix:**
```
POST https://messaging.twilio.com/v1/Services/{MessagingServiceSid}
InboundRequestUrl=https://yourapp.com/inbound
InboundMethod=POST
UseInboundWebhookOnNumber=false
```

**Verify via API:**
```js
fetch('https://messaging.twilio.com/v1/Services/{MgSid}', { headers: { 'Authorization': 'Basic ...' } })
  .then(r => r.json())
  .then(d => console.log(d.inbound_request_url, d.use_inbound_webhook_on_number))
```

---

### 2. `sendUnchecked` was trapped inside a lazy-init function

**Symptom:** Webhook returns 200, empty TwiML sent, but no outbound SMS ever created.
No error in logs.

**Root cause:** `sendUnchecked` was defined inside `_initDefaultClient()`, which is
only called lazily the first time `_getClient()` is invoked. Since `sendUnchecked`
was called BEFORE any `send()` call, `sms.sendUnchecked` was always `undefined`.
`TypeError: sms.sendUnchecked is not a function` was silently swallowed by a bare
`catch (_) {}`.

**Fix:** `sendUnchecked` must be a top-level exported function that calls `_getClient()`
internally, not something dynamically attached inside an init function.

**Lesson:** Never attach exported functions to a module object inside a lazy-init
function. Define them at the module level and let them trigger init internally.

---

### 3. `sendUnchecked` used undefined variable `client`

**Symptom:** Same as above — silent failure after the lazy-init fix.

**Root cause:** After extracting `sendUnchecked` from `_initDefaultClient`, the
function body still used `client` (a local variable only in scope inside the old
init function). The module-level variable is `_defaultClient`.

**Fix:** Use `_getClient()` (not `client` or `_defaultClient` directly).

---

### 4. `sendUnchecked` called `toE164()` which is not imported in sms.js

**Symptom:** `ReferenceError: toE164 is not defined` — another silent crash.

**Root cause:** `toE164` is defined in `phoneUtils.js` and imported in `db.js`, but
NOT imported in `sms.js`. Numbers coming from Twilio webhooks are already E.164, so
normalization is unnecessary anyway.

**Fix:** Remove the `toE164(to)` call; pass `to` directly to `client.messages.create`.

---

### 5. Twilio permanently blacklists a webhook path after a 500 response

**Symptom:** After a 500 response to a webhook, all subsequent inbound messages show
`status: received` but no 11200 alerts fire and the webhook is never called again.
Resetting the Messaging Service URL, redeploying, waiting — nothing restores it.

**Confirmed by:** Changing the Messaging Service URL to `/health` (which returns 404
on POST) immediately generated a 11200. Changing back to `/sms` → silence. The
`/sms` path was permanently blacklisted.

**Fix:** Use a fresh path (e.g. `/inbound`) that has no failure history. Register this
path on both the Messaging Service and the phone number's own `sms_url`.

**Rule:** Never let a webhook path return 5xx in production. Fix the bug and deploy
to a NEW path, not the same one.

---

### 6. Signature validation caused a 500 due to scope bug

**Symptom:** 11200 alert with `httpResponse=500`.

**Root cause:** `validateTwilioRequest` used `twilio.validateRequest(...)` but
`twilio` was only in scope inside `_initDefaultClient()`, not at the function level.

**Fix:**
```js
const valid = require('twilio').validateRequest(
  process.env.TWILIO_AUTH_TOKEN,
  twilioSignature,
  webhookUrl,
  req.body || {}
);
```

---

### 7. Signature validation URL mismatch behind Fly.io proxy

**Symptom:** `[SMS] Invalid Twilio signature — rejected`

**Root cause:** Fly.io terminates TLS at the edge. Inside the VM, `req.protocol` is
always `'http'`. If you reconstruct the webhook URL using `req.protocol`, you get
`http://butterflai.social/sms`, but Twilio signed it with `https://butterflai.social/sms`.

**Fix:** Use the forwarded headers:
```js
const proto = req.headers['x-forwarded-proto'] || 'https';
const host  = req.headers['x-forwarded-host']  || req.headers['host'];
const webhookUrl = `${proto}://${host}${req.originalUrl}`;
```

---

## Diagnostic Checklist for "inbound SMS not working"

Run through these in order:

1. **Is the message reaching Twilio at all?**
   ```
   GET /2010-04-01/Accounts/{SID}/Messages?To={your_number}&PageSize=5
   ```
   Look for `status: received`. If absent, the problem is upstream of Twilio.

2. **Is the number in a Messaging Service?**
   ```
   GET /2010-04-01/Accounts/{SID}/IncomingPhoneNumbers/{PN_SID}
   ```
   Check `messaging_service_sid`. If set, the service URL takes precedence.

3. **Does the Messaging Service have an inbound URL?**
   ```
   GET https://messaging.twilio.com/v1/Services/{MG_SID}
   ```
   Check `inbound_request_url`. If null → all inbound silently dropped.

4. **Is Twilio calling the webhook at all?**
   Temporarily point the webhook to `/health` (which 404s on POST → 11200). If
   you see a 11200, Twilio IS calling webhooks. If not, check opt-out status or
   account restrictions.

5. **Is Twilio getting a non-200 response?**
   Check `https://monitor.twilio.com/v1/Alerts` for 11200 errors. 11200 appears
   for any non-2xx response. No 11200 = either 200 or webhook not called.

6. **Is the webhook path blacklisted?**
   See bug #5. If a path has ever returned 500, Twilio may have blacklisted it.
   Switch to a fresh path and register it on the Messaging Service.

7. **Is the reply actually being sent?**
   ```
   GET /2010-04-01/Accounts/{SID}/Messages?From={your_number}&PageSize=5
   ```
   Look for `outbound-api` or `outbound-reply` direction. If empty, the handler
   ran but `send()` / `sendUnchecked()` failed silently.

8. **Test the endpoint directly:**
   ```bash
   curl -X POST https://yourapp.com/inbound \
     -d 'From=+1XXXXXXXXXX&To=+1XXXXXXXXXX&Body=test&MessageSid=SMtest'
   ```
   If this returns 200 but the Twilio-triggered call doesn't → signature validation
   or Twilio is not calling the webhook.

---

## Architecture Notes

### Why REST API instead of TwiML replies

TwiML `<Message>` outbound-reply responses are silently suppressed on A2P 10DLC
long codes in certain Twilio account states. Using the REST API (`client.messages.create`)
as `outbound-api` is more reliable. The handler now:
1. Returns empty `<Response></Response>` immediately (satisfies Twilio's webhook timeout)
2. Sends the reply asynchronously via `sms.sendUnchecked()` (REST API)

### Why `/inbound` not `/sms`

The `/sms` path accumulated failure history during debugging (a 500 from a scope bug).
Twilio blacklisted it. The app now listens on both `/sms` and `/inbound`, and all
Twilio configuration points to `/inbound`.

### Messaging Service vs direct phone number

Both the Messaging Service `inbound_request_url` AND the phone number's own `sms_url`
are set to `/inbound`. The Messaging Service URL takes precedence (since the number
is in the service), but the phone number fallback is consistent just in case.

---

## Key Identifiers

- Fly app: `butterflai`
- Fly machine: `876430a03623d8` (region: ewr)
- Twilio phone number SID: `PN37917821098eb17dc17c0d6bd015cda6`
- ButterflAI number: `+12202721479`
- Messaging Service SID: `MG21e415910920bb2fe7120bfc216de841`
- Webhook URL: `https://butterflai.social/inbound`
- SQLite DB path on volume: `/data/butterflai.sqlite`
