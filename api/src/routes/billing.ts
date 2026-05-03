import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { getSetting } from '../lib/settings.js';

export async function registerBillingRoutes(app: FastifyInstance) {
  // STRIPE_PRICE_ID_MONTHLY is now a runtime setting; resolved per-checkout
  // so an operator can switch the default plan from the admin UI without
  // restart. STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET deliberately stay
  // env-only -- rotating those mid-flight would brick in-flight checkouts
  // and the webhook signature, and they're set once at deploy time.

  // Helper: get-or-create the Stripe customer for a user, persisted in subscriptions table.
  async function ensureCustomer(userId: string, email: string): Promise<string> {
    const r = await app.db.query('select stripe_customer_id from subscriptions where user_id=$1', [userId]);
    if (r.rowCount && r.rows[0].stripe_customer_id) return r.rows[0].stripe_customer_id;

    const customer = await app.stripe.customers.create({ email, metadata: { user_id: userId } });
    await app.db.query(
      `insert into subscriptions (user_id, stripe_customer_id, status)
       values ($1, $2, 'incomplete')
       on conflict (user_id) do update set stripe_customer_id = excluded.stripe_customer_id`,
      [userId, customer.id],
    );
    return customer.id;
  }

  // POST /v1/billing/checkout — returns a Stripe Checkout Session URL for the user to subscribe.
  app.post('/v1/billing/checkout', { preHandler: app.requireUser }, async (req: any, reply) => {
    if (!app.stripe) return reply.code(503).send({ error: 'billing_disabled' });
    const priceId = await getSetting<string>(app.db, 'stripe.price_id_monthly');
    if (!priceId) return reply.code(500).send({ error: 'stripe.price_id_monthly not configured' });

    const customerId = await ensureCustomer(req.user.sub, req.user.email);
    const session = await app.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: process.env.BILLING_SUCCESS_URL ?? 'evolights://billing/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  process.env.BILLING_CANCEL_URL  ?? 'evolights://billing/cancel',
      allow_promotion_codes: true,
      client_reference_id: req.user.sub,
    });
    return reply.send({ url: session.url });
  });

  // POST /v1/billing/portal — Stripe Customer Portal for managing/cancelling subscription
  app.post('/v1/billing/portal', { preHandler: app.requireUser }, async (req: any, reply) => {
    if (!app.stripe) return reply.code(503).send({ error: 'billing_disabled' });
    const customerId = await ensureCustomer(req.user.sub, req.user.email);
    const session = await app.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.BILLING_PORTAL_RETURN_URL ?? 'evolights://billing/return',
    });
    return reply.send({ url: session.url });
  });

  // POST /v1/billing/webhook — Stripe -> us. Validates signature, updates subscription state.
  //
  // fastify-raw-body (registered globally in server.ts with global:false) attaches
  // req.rawBody when this route opts in via config.rawBody=true. Stripe signature
  // verification REQUIRES the original byte-exact request body: Stripe HMACs the
  // exact bytes Stripe sent us, so any reserialisation of the parsed JSON would
  // produce a different byte sequence (whitespace, key order, number formatting)
  // and fail signature verification -- or, worse with some libraries, validate
  // unpredictably.
  //
  // Therefore we fail closed if rawBody is missing rather than falling back to
  // req.body. The previous code did `req.rawBody ?? req.body` and also installed
  // a no-op preParsing hook; both removed.
  app.post('/v1/billing/webhook', {
    // rateLimit:false disables the global 100/min cap. Stripe is a trusted
    // source and month-end subscription event bursts must never be dropped --
    // a dropped event leaves our DB out of sync with Stripe's truth.
    config: { rawBody: true, rateLimit: false },
  }, async (req: any, reply) => {
    if (!app.stripe) return reply.code(503).send({ error: 'billing_disabled' });
    const signature = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!signature || !secret) return reply.code(400).send({ error: 'missing_signature_or_secret' });

    if (!req.rawBody) {
      // Hard fail: never feed parsed JSON to constructEvent. See comment above.
      app.log.error('stripe webhook received with no rawBody — refusing to verify against parsed body');
      return reply.code(400).send({ error: 'missing_raw_body' });
    }

    let event: Stripe.Event;
    try {
      event = app.stripe.webhooks.constructEvent(req.rawBody, signature, secret);
    } catch (e: any) {
      app.log.warn({ err: e.message }, 'stripe webhook signature failed');
      return reply.code(400).send({ error: 'bad_signature' });
    }

    const upsert = async (sub: Stripe.Subscription) => {
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      // Stripe SDK v17+ types: current_period_end lives on Subscription itself,
      // not on SubscriptionItem. Earlier code path silently null'd in newer SDKs
      // because items.data[0].current_period_end isn't a known property.
      const periodEnd = sub.current_period_end ?? null;
      await app.db.query(
        `update subscriptions
            set stripe_sub_id = $1,
                status = $2,
                current_period_end = to_timestamp($3),
                updated_at = now()
          where stripe_customer_id = $4`,
        [sub.id, sub.status, periodEnd, customerId],
      );
    };

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.trial_will_end':
        await upsert(event.data.object as Stripe.Subscription);
        break;
      case 'checkout.session.completed': {
        // Subscription is created in the same event family above; nothing extra here.
        break;
      }
    }
    return reply.send({ received: true });
  });
}
