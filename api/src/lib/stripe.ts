import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';

declare module 'fastify' {
  interface FastifyInstance {
    stripe: Stripe;
  }
}

export async function registerStripe(app: FastifyInstance) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    app.log.warn('STRIPE_SECRET_KEY not set — billing routes will return 503');
    app.decorate('stripe', null as unknown as Stripe);
    return;
  }
  const stripe = new Stripe(key, { apiVersion: '2025-09-30.clover' as Stripe.LatestApiVersion });
  app.decorate('stripe', stripe);
  app.log.info('stripe configured');
}

// Statuses that grant product access. We deliberately INCLUDE 'past_due':
// Stripe enters past_due during the 1-3 day card retry window after a
// renewal failure, and cutting service mid-window is a poor customer
// experience for what is usually an expired card -- the customer hasn't
// chosen to cancel. We cut access at:
//   - 'unpaid'              (Stripe gave up on retries)
//   - 'canceled'            (subscription ended)
//   - 'incomplete'          (initial payment never succeeded)
//   - 'incomplete_expired'  (initial payment window elapsed)
// Note: 'paused' (rare) is also denial; not in the active set.
export const SUB_STATUSES_ACTIVE = new Set(['active', 'trialing', 'past_due']);

export function hasActiveSub(status: string | null | undefined): boolean {
  return !!status && SUB_STATUSES_ACTIVE.has(status);
}
