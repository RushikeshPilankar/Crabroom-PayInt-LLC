/**
 * Stripe Subscription Billing Service
 * Single-file Node.js/Express backend for SaaS subscription management
 *
 * Storage choice: In-memory Map structures (subscriptions + processedEvents)
 * Rationale: For a scoped 60-90 min deliverable, in-memory storage lets us
 * demonstrate all correctness properties (idempotency, state transitions, schema)
 * without infra setup. In production, swap these Maps for a PostgreSQL
 * connection (e.g. pg/knex) with the same key shapes shown here.
 *
 * Idempotency mechanism: processedEvents Map keyed on stripe event ID.
 * On duplicate webhook delivery, we check this map first and return 200
 * immediately — telling Stripe "I already handled this, stop retrying."
 */

const express = require("express");
const Stripe = require("stripe");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Stripe Configuration ────────────────────────────────────────────────────
// In production: load from environment variables / secrets manager
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_YOUR_KEY_HERE";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_YOUR_WEBHOOK_SECRET_HERE";

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

// ─── Plan → Price ID Mapping ─────────────────────────────────────────────────
// These are Stripe test-mode Price IDs created in your Stripe dashboard.
// Replace with your actual Price IDs from: dashboard.stripe.com/test/products
const PRICE_IDS = {
  starter: process.env.PRICE_ID_STARTER || "price_starter_test_placeholder",
  pro: process.env.PRICE_ID_PRO || "price_pro_test_placeholder",
};

// ─── In-Memory Data Store ─────────────────────────────────────────────────────
/**
 * subscriptions: Map<customerEmail, SubscriptionRecord>
 *
 * SubscriptionRecord shape (mirrors what you'd store in PostgreSQL):
 * {
 *   email: string,
 *   stripeCustomerId: string,
 *   stripeSubscriptionId: string,
 *   plan: 'starter' | 'pro',
 *   status: 'active' | 'past_due' | 'pending' | 'cancelled',
 *   updatedAt: ISO timestamp string
 * }
 */
const subscriptions = new Map();

/**
 * processedEvents: Map<stripeEventId, { processedAt: string, eventType: string }>
 *
 * This is the idempotency guard. Before processing any webhook event,
 * we check if the event ID already exists here. If it does, we return
 * HTTP 200 immediately — Stripe interprets 2xx as "acknowledged, stop retrying."
 *
 * Why Map and not just a Set? Storing metadata (processedAt, eventType) helps
 * with debugging and audit trails in production.
 */
const processedEvents = new Map();

// ─── Middleware ───────────────────────────────────────────────────────────────
// IMPORTANT: /webhook must use raw body buffer for Stripe signature verification.
// express.json() would parse it and break stripe.webhooks.constructEvent().
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ─── POST /subscribe ──────────────────────────────────────────────────────────
/**
 * Creates or retrieves a Stripe Customer, attaches a payment method,
 * and creates a Stripe Subscription for the chosen plan.
 *
 * Request body:
 *   { email: string, paymentMethodId: string, plan: 'starter' | 'pro' }
 *
 * Flow:
 *   1. Validate input
 *   2. Find or create Stripe Customer by email
 *   3. Attach paymentMethod to Customer & set as default
 *   4. Create Subscription with price for chosen plan
 *   5. Persist to our in-memory store with status 'pending'
 *      (webhook invoice.payment_succeeded will flip it to 'active')
 */
app.post("/subscribe", async (req, res) => {
  const { email, paymentMethodId, plan } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!email || !paymentMethodId || !plan) {
    return res.status(400).json({
      error: "Missing required fields: email, paymentMethodId, plan",
    });
  }

  if (!["starter", "pro"].includes(plan)) {
    return res.status(400).json({
      error: "Invalid plan. Choose 'starter' or 'pro'.",
    });
  }

  const priceId = PRICE_IDS[plan];

  try {
    // ── Step 1: Find or create Stripe Customer ────────────────────────────
    // We search by email first to avoid creating duplicate customers.
    // This makes /subscribe idempotent for the same email.
    let customer;
    const existingCustomers = await stripe.customers.list({ email, limit: 1 });

    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
      console.log(`[subscribe] Found existing customer: ${customer.id}`);
    } else {
      customer = await stripe.customers.create({ email });
      console.log(`[subscribe] Created new customer: ${customer.id}`);
    }

    // ── Step 2: Attach payment method & set as invoice default ────────────
    // attach() is idempotent — Stripe won't error if already attached.
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customer.id,
    });

    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // ── Step 3: Create Subscription ───────────────────────────────────────
    // payment_behavior: 'default_incomplete' means the sub starts but won't
    // activate until the first invoice is paid. This pairs well with webhook
    // invoice.payment_succeeded to confirm activation.
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      expand: ["latest_invoice.payment_intent"],
    });

    // ── Step 4: Persist to local store (status = 'pending') ───────────────
    const record = {
      email,
      stripeCustomerId: customer.id,
      stripeSubscriptionId: subscription.id,
      plan,
      status: "pending",
      updatedAt: new Date().toISOString(),
    };
    subscriptions.set(email, record);

    console.log(`[subscribe] Created subscription ${subscription.id} for ${email} (plan: ${plan})`);

    return res.status(201).json({
      message: "Subscription created. Awaiting payment confirmation.",
      subscriptionId: subscription.id,
      customerId: customer.id,
      plan,
      status: "pending",
    });
  } catch (err) {
    console.error("[subscribe] Error:", err.message);

    // Stripe errors have a structured .type field
    if (err.type && err.type.startsWith("Stripe")) {
      return res.status(402).json({ error: err.message, stripeCode: err.code });
    }

    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /webhook ────────────────────────────────────────────────────────────
/**
 * Ingests Stripe webhook events, verifies signature, and handles:
 *   - invoice.payment_succeeded → mark subscription 'active'
 *   - invoice.payment_failed    → mark subscription 'past_due'
 *
 * Idempotency: Every event ID is recorded in processedEvents Map.
 * Duplicate deliveries (same event ID) return HTTP 200 immediately
 * without re-processing — Stripe stops retrying on any 2xx response.
 *
 * Why 200 (not 409 Conflict)? Stripe's retry logic stops on ANY 2xx.
 * Returning 4xx/5xx would cause Stripe to keep retrying. Returning 200
 * for duplicates is the Stripe-recommended pattern.
 */
app.post("/webhook", (req, res) => {
  const sig = req.headers["stripe-signature"];

  // ── Step 1: Verify Stripe signature ──────────────────────────────────────
  // req.body is a raw Buffer here (see middleware above).
  // constructEvent() hashes the raw body + secret + timestamp to verify authenticity.
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[webhook] Signature verification failed:", err.message);
    // Return 400 — tells Stripe this delivery was rejected (will retry)
    return res.status(400).json({ error: `Webhook signature invalid: ${err.message}` });
  }

  // ── Step 2: Idempotency guard ─────────────────────────────────────────────
  if (processedEvents.has(event.id)) {
    const prior = processedEvents.get(event.id);
    console.log(
      `[webhook] Duplicate event ${event.id} (${event.type}) — already processed at ${prior.processedAt}. Returning 200.`
    );
    // Return 200 to ACK to Stripe — do NOT re-process
    return res.status(200).json({
      received: true,
      duplicate: true,
      message: `Event ${event.id} already processed`,
    });
  }

  // ── Step 3: Handle event types ────────────────────────────────────────────
  const dataObject = event.data.object; // This is the invoice object for both events

  try {
    switch (event.type) {

      case "invoice.payment_succeeded": {
        /**
         * Stripe fires this when a subscription invoice is paid successfully.
         * dataObject.subscription is the Stripe subscription ID.
         * We find the matching local record and flip status to 'active'.
         */
        const subId = dataObject.subscription;
        const customerEmail = dataObject.customer_email || findEmailBySubId(subId);

        if (customerEmail && subscriptions.has(customerEmail)) {
          const record = subscriptions.get(customerEmail);
          record.status = "active";
          record.updatedAt = new Date().toISOString();
          subscriptions.set(customerEmail, record);
          console.log(`[webhook] ${event.type} → subscription ${subId} for ${customerEmail} marked ACTIVE`);
        } else {
          // Subscription not in our local store — could be from Stripe dashboard
          // or a customer not created via our /subscribe. Log and move on.
          console.warn(`[webhook] ${event.type} — no local record found for subscription ${subId}`);
        }
        break;
      }

      case "invoice.payment_failed": {
        /**
         * Stripe fires this when a subscription invoice payment fails.
         * Common causes: card declined, expired card, insufficient funds.
         * We mark the subscription 'past_due' — customer should update billing.
         */
        const subId = dataObject.subscription;
        const customerEmail = dataObject.customer_email || findEmailBySubId(subId);

        if (customerEmail && subscriptions.has(customerEmail)) {
          const record = subscriptions.get(customerEmail);
          record.status = "past_due";
          record.updatedAt = new Date().toISOString();
          subscriptions.set(customerEmail, record);
          console.log(`[webhook] ${event.type} → subscription ${subId} for ${customerEmail} marked PAST_DUE`);
        } else {
          console.warn(`[webhook] ${event.type} — no local record found for subscription ${subId}`);
        }
        break;
      }

      default:
        // Unhandled event types — acknowledge receipt without processing.
        // This prevents Stripe from retrying events we don't care about.
        console.log(`[webhook] Unhandled event type: ${event.type} — acknowledged.`);
    }

    // ── Step 4: Mark event as processed (idempotency record) ─────────────
    processedEvents.set(event.id, {
      eventType: event.type,
      processedAt: new Date().toISOString(),
    });

    return res.status(200).json({ received: true, eventId: event.id, type: event.type });

  } catch (err) {
    console.error("[webhook] Processing error:", err.message);
    // Return 500 — Stripe will retry this event, which is correct here
    // since we failed BEFORE recording it in processedEvents.
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

// ─── Helper: Find email by Stripe Subscription ID ────────────────────────────
/**
 * Linear scan of our in-memory store to find a subscription record by sub ID.
 * In PostgreSQL, this would be: SELECT email FROM subscriptions WHERE stripe_sub_id = $1
 * O(n) is fine here; in production, maintain a secondary Map<subId, email> for O(1).
 */
function findEmailBySubId(subscriptionId) {
  for (const [email, record] of subscriptions.entries()) {
    if (record.stripeSubscriptionId === subscriptionId) return email;
  }
  return null;
}

// ─── GET /subscription/:email (debug/test utility) ───────────────────────────
// Not part of the spec but invaluable for testing & verifying state changes.
app.get("/subscription/:email", (req, res) => {
  const record = subscriptions.get(req.params.email);
  if (!record) return res.status(404).json({ error: "No subscription found for this email" });
  return res.status(200).json(record);
});

// ─── GET /processed-events (debug/test utility) ──────────────────────────────
// Shows all events recorded in the idempotency store — useful for verifying
// that duplicate webhook deliveries are being caught correctly.
app.get("/processed-events", (req, res) => {
  const events = {};
  for (const [id, meta] of processedEvents.entries()) {
    events[id] = meta;
  }
  return res.status(200).json({ count: processedEvents.size, events });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Stripe Billing Service running on port ${PORT}`);
  console.log(`   POST /subscribe       — create subscription`);
  console.log(`   POST /webhook         — receive Stripe events`);
  console.log(`   GET  /subscription/:email — check subscription state`);
  console.log(`   GET  /processed-events    — view idempotency store\n`);
});

module.exports = app; // Export for testing
