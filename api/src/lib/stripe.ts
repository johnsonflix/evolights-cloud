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

export const SUB_STATUSES_ACTIVE = new Set(['active', 'trialing']);

export function hasActiveSub(status: string | null | undefined): boolean {
  return !!status && SUB_STATUSES_ACTIVE.has(status);
}
