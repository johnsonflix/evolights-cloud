import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import Stripe from 'stripe';

/**
 * Master admin endpoints. EVERY route here is gated by both requireUser
 * (valid JWT, account exists, token not revoked) AND requireAdmin (users.is_admin
 * is true). Bootstrap admin access via the CLI:
 *   npm run admin:promote -- you@example.com
 *
 * Stripe-management endpoints are convenience wrappers — operators can also
 * use the Stripe dashboard directly. Each Stripe call catches the SDK error
 * and returns Stripe's `code` + `message` rather than the full stack, since
 * Stripe error bodies can include API call IDs / request payload echoes we
 * don't want to leak through the API response.
 */

const uuidSchema = z.string().uuid();

function stripeError(reply: any, log: any, e: any, fallbackCode: number = 500) {
  // Stripe SDK errors expose .type, .code, .message, .raw, .statusCode.
  // We surface the user-facing pieces (code + message) and log the rest.
  if (e instanceof Stripe.errors.StripeError) {
    log.warn({ type: e.type, code: e.code, message: e.message }, 'stripe error');
    return reply.code(e.statusCode ?? fallbackCode).send({
      error: 'stripe_error',
      type: e.type,
      code: e.code ?? null,
      message: e.message,
    });
  }
  log.error({ err: e?.message ?? String(e) }, 'unexpected admin error');
  return reply.code(fallbackCode).send({ error: 'internal_error' });
}

export async function registerAdminRoutes(app: FastifyInstance) {
  const adminGuard = { preHandler: [app.requireUser, app.requireAdmin] };

  // ---------------- Stats ----------------
  // GET /v1/admin/stats
  app.get('/v1/admin/stats', adminGuard, async (_req, reply) => {
    // Run all queries in parallel — they're cheap and independent.
    const [users, devices, subs, mrr, signups, pairings] = await Promise.all([
      app.db.query<{ c: string }>(
        `select count(*)::text c from users where deleted_at is null`,
      ),
      app.db.query<{ c: string }>(`select count(*)::text c from devices`),
      app.db.query<{ c: string }>(
        `select count(*)::text c from subscriptions
          where status in ('active','trialing','past_due')`,
      ),
      app.db.query<{ c: string }>(
        // We don't store unit price per sub locally — best-effort MRR is the
        // count of active subs * STRIPE_PRICE_AMOUNT_CENTS env var (operator
        // sets to the configured monthly price). If unset, return null and
        // let the admin UI compute it from Stripe directly.
        `select count(*)::text c from subscriptions
          where status in ('active','trialing','past_due')`,
      ),
      app.db.query<{ c: string }>(
        `select count(*)::text c from users
          where created_at > now() - interval '24 hours' and deleted_at is null`,
      ),
      app.db.query<{ c: string }>(
        `select count(*)::text c from pairing_codes
          where used_at is not null and used_at > now() - interval '24 hours'`,
      ),
    ]);
    const priceCents = Number(process.env.STRIPE_PRICE_AMOUNT_CENTS ?? 0);
    const mrrCents = priceCents > 0 ? Number(mrr.rows[0].c) * priceCents : null;
    return reply.send({
      users_count:          Number(users.rows[0].c),
      devices_count:        Number(devices.rows[0].c),
      active_subscriptions: Number(subs.rows[0].c),
      mrr_cents:            mrrCents,
      last_24h_signups:     Number(signups.rows[0].c),
      last_24h_pairings:    Number(pairings.rows[0].c),
    });
  });

  // ---------------- Users list ----------------
  // GET /v1/admin/users?q=&limit=&offset=
  app.get('/v1/admin/users', adminGuard, async (req, reply) => {
    const schema = z.object({
      q:      z.string().max(255).optional(),
      limit:  z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    // Email substring search via ILIKE. Parameters bound — no injection risk.
    // We deliberately INCLUDE soft-deleted users in admin lists so admins can
    // see/restore them; deleted_at is exposed in the response.
    const params: any[] = [];
    let where = '';
    if (parsed.data.q) {
      params.push(`%${parsed.data.q}%`);
      where = `where u.email ilike $${params.length}`;
    }
    params.push(parsed.data.limit, parsed.data.offset);
    const rows = await app.db.query(
      `select u.id, u.email, u.is_admin, u.email_verified, u.created_at, u.deleted_at,
              s.status as sub_status, s.current_period_end
         from users u
         left join subscriptions s on s.user_id = u.id
        ${where}
        order by u.created_at desc
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    const total = await app.db.query<{ c: string }>(
      `select count(*)::text c from users u ${where}`,
      parsed.data.q ? [params[0]] : [],
    );
    return reply.send({
      users:  rows.rows,
      total:  Number(total.rows[0].c),
      limit:  parsed.data.limit,
      offset: parsed.data.offset,
    });
  });

  // ---------------- User detail ----------------
  // GET /v1/admin/users/:id
  app.get('/v1/admin/users/:id', adminGuard, async (req: any, reply) => {
    if (!uuidSchema.safeParse(req.params.id).success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const u = await app.db.query(
      `select id, email, is_admin, email_verified, apple_sub is not null as has_apple,
              google_sub is not null as has_google,
              password_hash is not null as has_password,
              created_at, updated_at, deleted_at, tokens_valid_after
         from users where id = $1`,
      [req.params.id],
    );
    if (!u.rowCount) return reply.code(404).send({ error: 'not_found' });

    const [devices, sub] = await Promise.all([
      app.db.query(
        `select id, name, hardware_id, firmware_version, last_seen_at, created_at
           from devices where user_id = $1 order by created_at desc`,
        [req.params.id],
      ),
      app.db.query(
        `select stripe_customer_id, stripe_sub_id, status, current_period_end, updated_at
           from subscriptions where user_id = $1`,
        [req.params.id],
      ),
    ]);
    return reply.send({
      user:         u.rows[0],
      devices:      devices.rows,
      subscription: sub.rows[0] ?? null,
    });
  });

  // ---------------- Promote / demote / lockout-everywhere / soft-delete ----------------
  app.post('/v1/admin/users/:id/promote', adminGuard, async (req: any, reply) => {
    if (!uuidSchema.safeParse(req.params.id).success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const r = await app.db.query(
      'update users set is_admin = true, updated_at = now() where id = $1 and deleted_at is null returning id',
      [req.params.id],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ ok: true });
  });

  app.post('/v1/admin/users/:id/demote', adminGuard, async (req: any, reply) => {
    if (!uuidSchema.safeParse(req.params.id).success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    // Refuse self-demote so an operator can't lock themselves out of admin
    // (especially fatal when they're the ONLY admin). They can promote
    // someone else first and then have that person demote them.
    if (req.params.id === req.user.sub) {
      return reply.code(409).send({ error: 'cannot_demote_self' });
    }
    const r = await app.db.query(
      'update users set is_admin = false, updated_at = now() where id = $1 and deleted_at is null returning id',
      [req.params.id],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ ok: true });
  });

  app.post('/v1/admin/users/:id/logout-everywhere', adminGuard, async (req: any, reply) => {
    if (!uuidSchema.safeParse(req.params.id).success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const r = await app.db.query(
      'update users set tokens_valid_after = now(), updated_at = now() where id = $1 and deleted_at is null returning id',
      [req.params.id],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ ok: true });
  });

  // DELETE /v1/admin/users/:id — soft delete. Adds deleted_at timestamp; the
  // unique email constraint stays in place (you can't re-register with the
  // same email until the deleted row is purged or the email is rotated).
  // We also bump tokens_valid_after to instantly revoke any active sessions.
  app.delete('/v1/admin/users/:id', adminGuard, async (req: any, reply) => {
    if (!uuidSchema.safeParse(req.params.id).success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    if (req.params.id === req.user.sub) {
      return reply.code(409).send({ error: 'cannot_delete_self' });
    }
    const r = await app.db.query(
      `update users
          set deleted_at = now(),
              tokens_valid_after = now(),
              updated_at = now()
        where id = $1 and deleted_at is null
        returning id`,
      [req.params.id],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ ok: true });
  });

  // =========================== Stripe management =========================
  // Each call wraps Stripe's error so we don't leak full stacks.

  function ensureStripe(reply: any): boolean {
    if (!app.stripe) {
      reply.code(503).send({ error: 'billing_disabled' });
      return false;
    }
    return true;
  }

  // -------- Products --------
  app.get('/v1/admin/stripe/products', adminGuard, async (_req, reply) => {
    if (!ensureStripe(reply)) return;
    try {
      const list = await app.stripe.products.list({ limit: 100 });
      return reply.send({ products: list.data, has_more: list.has_more });
    } catch (e: any) { return stripeError(reply, app.log, e); }
  });

  app.post('/v1/admin/stripe/products', adminGuard, async (req, reply) => {
    if (!ensureStripe(reply)) return;
    const schema = z.object({
      name:        z.string().min(1).max(255),
      description: z.string().max(2000).optional(),
      active:      z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });
    try {
      const product = await app.stripe.products.create({
        name:        parsed.data.name,
        description: parsed.data.description,
        active:      parsed.data.active,
      });
      return reply.send({ product });
    } catch (e: any) { return stripeError(reply, app.log, e); }
  });

  app.patch('/v1/admin/stripe/products/:id', adminGuard, async (req: any, reply) => {
    if (!ensureStripe(reply)) return;
    const schema = z.object({
      name:        z.string().min(1).max(255).optional(),
      description: z.string().max(2000).optional(),
      active:      z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });
    try {
      const product = await app.stripe.products.update(req.params.id, {
        ...(parsed.data.name        !== undefined ? { name:        parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.active      !== undefined ? { active:      parsed.data.active } : {}),
      });
      return reply.send({ product });
    } catch (e: any) { return stripeError(reply, app.log, e); }
  });

  // -------- Prices --------
  app.get('/v1/admin/stripe/prices', adminGuard, async (req, reply) => {
    if (!ensureStripe(reply)) return;
    const schema = z.object({ product_id: z.string().min(1).max(255).optional() });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });
    try {
      const list = await app.stripe.prices.list({
        limit: 100,
        ...(parsed.data.product_id ? { product: parsed.data.product_id } : {}),
      });
      return reply.send({ prices: list.data, has_more: list.has_more });
    } catch (e: any) { return stripeError(reply, app.log, e); }
  });

  app.post('/v1/admin/stripe/prices', adminGuard, async (req, reply) => {
    if (!ensureStripe(reply)) return;
    const schema = z.object({
      product_id:         z.string().min(1).max(255),
      currency:           z.string().length(3),
      unit_amount:        z.number().int().min(0),
      recurring_interval: z.enum(['day', 'week', 'month', 'year']),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });
    try {
      const price = await app.stripe.prices.create({
        product:     parsed.data.product_id,
        currency:    parsed.data.currency,
        unit_amount: parsed.data.unit_amount,
        recurring:   { interval: parsed.data.recurring_interval },
      });
      return reply.send({ price });
    } catch (e: any) { return stripeError(reply, app.log, e); }
  });

  // -------- Coupons --------
  app.get('/v1/admin/stripe/coupons', adminGuard, async (_req, reply) => {
    if (!ensureStripe(reply)) return;
    try {
      const list = await app.stripe.coupons.list({ limit: 100 });
      return reply.send({ coupons: list.data, has_more: list.has_more });
    } catch (e: any) { return stripeError(reply, app.log, e); }
  });

  app.post('/v1/admin/stripe/coupons', adminGuard, async (req, reply) => {
    if (!ensureStripe(reply)) return;
    const schema = z.object({
      name:               z.string().min(1).max(255),
      percent_off:        z.number().min(0).max(100).optional(),
      amount_off:         z.number().int().min(0).optional(),
      currency:           z.string().length(3).optional(),
      duration:           z.enum(['forever', 'once', 'repeating']),
      duration_in_months: z.number().int().min(1).max(120).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    // Stripe requires either percent_off or amount_off (with currency); the
    // SDK validates server-side too but we 400 early to give a clearer error.
    if ((parsed.data.percent_off === undefined) === (parsed.data.amount_off === undefined)) {
      return reply.code(400).send({ error: 'must_specify_exactly_one_of_percent_off_or_amount_off' });
    }
    if (parsed.data.amount_off !== undefined && !parsed.data.currency) {
      return reply.code(400).send({ error: 'currency_required_with_amount_off' });
    }
    if (parsed.data.duration === 'repeating' && !parsed.data.duration_in_months) {
      return reply.code(400).send({ error: 'duration_in_months_required_when_duration_is_repeating' });
    }

    try {
      const coupon = await app.stripe.coupons.create({
        name:     parsed.data.name,
        duration: parsed.data.duration,
        ...(parsed.data.percent_off        !== undefined ? { percent_off:        parsed.data.percent_off } : {}),
        ...(parsed.data.amount_off         !== undefined ? { amount_off:         parsed.data.amount_off } : {}),
        ...(parsed.data.currency           !== undefined ? { currency:           parsed.data.currency } : {}),
        ...(parsed.data.duration_in_months !== undefined ? { duration_in_months: parsed.data.duration_in_months } : {}),
      });
      return reply.send({ coupon });
    } catch (e: any) { return stripeError(reply, app.log, e); }
  });
}
