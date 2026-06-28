# Stripe Subscription Billing Service

Single-file Node.js/Express backend for SaaS subscription management with Stripe.

## Quick Start

```bash
npm install
STRIPE_SECRET_KEY=sk_test_xxx \
STRIPE_WEBHOOK_SECRET=whsec_xxx \
PRICE_ID_STARTER=price_xxx \
PRICE_ID_PRO=price_xxx \
node server.js
```

## Design Decisions

### Storage: In-Memory Maps
Two `Map` structures replace PostgreSQL for this scope:
- `subscriptions` — keyed by customer email, holds full subscription record
- `processedEvents` — keyed by Stripe event ID, the idempotency store

**To swap in PostgreSQL:** replace `subscriptions.get/set` with `SELECT`/`INSERT INTO subscriptions` and `processedEvents.has/set` with a `processed_webhook_events` table. The key shapes are identical.

### Idempotency Mechanism
Every webhook event has a globally unique `event.id` from Stripe. Before processing any event, we check `processedEvents.has(event.id)`. If found, we return `HTTP 200` immediately without re-running any state logic.

**Why 200 (not 409)?** Stripe retries on any non-2xx response. Returning 200 tells Stripe "I've seen this, all good, stop retrying." This is the Stripe-recommended pattern for duplicate handling.

**Why not 409?** Returning 409 Conflict would cause Stripe to keep retrying the event indefinitely — the opposite of what we want for duplicates.

### Webhook Raw Body
The `/webhook` route uses `express.raw()` (not `express.json()`) to preserve the raw Buffer. `stripe.webhooks.constructEvent()` needs the exact raw bytes to verify the HMAC-SHA256 signature. Parsing the body first would break signature verification.

## API Reference

### POST /subscribe
```json
{
  "email": "user@example.com",
  "paymentMethodId": "pm_card_visa",
  "plan": "starter"
}
```

**Responses:**
- `201` — Subscription created (status: pending, awaiting payment webhook)
- `400` — Missing/invalid fields
- `402` — Stripe payment error
- `500` — Server error

### POST /webhook
Receives Stripe events. Verifies signature. Handles:
- `invoice.payment_succeeded` → status: `active`
- `invoice.payment_failed` → status: `past_due`

**Responses:**
- `200 { received: true }` — Processed
- `200 { received: true, duplicate: true }` — Already processed (idempotent)
- `400` — Invalid signature (Stripe retries)
- `500` — Processing error (Stripe retries)

### GET /subscription/:email (debug)
Returns current subscription record for an email.

### GET /processed-events (debug)
Returns all events recorded in the idempotency store.

## Testing Idempotency

### Option 1: Automated test script
```bash
# Terminal 1: Start server
node server.js

# Terminal 2: Run idempotency test
node test-idempotency.js
```

### Option 2: Stripe CLI replay
```bash
# Install Stripe CLI, then:
stripe listen --forward-to localhost:3000/webhook

# In another terminal, trigger an event:
stripe trigger invoice.payment_succeeded

# Note the event ID from Stripe CLI output, then replay it:
stripe events resend evt_xxxxx

# Second delivery should return: { received: true, duplicate: true }
```

### Option 3: Manual curl (duplicate payload)
```bash
# First delivery
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "stripe-signature: t=1234567890,v1=fake_for_demo" \
  -d '{"id":"evt_manual_001","type":"invoice.payment_succeeded","data":{"object":{"subscription":"sub_abc","customer_email":"a@b.com"}}}'

# Send exact same request again — should return duplicate: true
```

## Subscription State Machine

```
[pending] ──invoice.payment_succeeded──▶ [active]
[active]  ──invoice.payment_failed────▶ [past_due]
[past_due] ──invoice.payment_succeeded──▶ [active]  (card updated)
```
