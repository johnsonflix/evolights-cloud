import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';

const credSchema = z.object({
  email:    z.string().email().max(255),
  password: z.string().min(8).max(128),
});

// Computed once at module load — argon2.hash with default params takes ~100ms,
// so we MUST NOT do it per request. Used to equalise timing on the
// "user does not exist" branch of /v1/auth/login so an attacker can't enumerate
// registered emails by measuring response latency.
const DUMMY_HASH_PROMISE: Promise<string> = argon2.hash('dummy-for-timing-equalization', { type: argon2.argon2id });

export async function registerAuthRoutes(app: FastifyInstance) {
  const DUMMY_HASH = await DUMMY_HASH_PROMISE;

  // POST /v1/auth/register
  // Tight rate limit per-IP to slow account-creation abuse / address enumeration
  // via the 409 email_in_use signal.
  app.post('/v1/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const parsed = credSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten() });
    const { email, password } = parsed.data;

    const exists = await app.db.query('select 1 from users where email = $1', [email]);
    if (exists.rowCount) return reply.code(409).send({ error: 'email_in_use' });

    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const ins = await app.db.query(
      'insert into users (email, password_hash) values ($1, $2) returning id, email, created_at',
      [email, hash],
    );
    const user = ins.rows[0];
    const token = app.jwt.sign({ sub: user.id, email: user.email });
    return reply.code(201).send({ token, user });
  });

  // POST /v1/auth/login
  // Tight rate limit per-IP — primary defence against credential stuffing /
  // online password brute force. argon2 already makes each guess expensive
  // (~100ms CPU); this caps the number of guesses to a per-IP-per-window quota.
  app.post('/v1/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const parsed = credSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });
    const { email, password } = parsed.data;

    const r = await app.db.query('select id, email, password_hash from users where email = $1', [email]);
    if (!r.rowCount) {
      // Burn time on a constant-time-ish argon2 verify so attackers can't
      // enumerate registered emails by latency. Result is intentionally
      // discarded; we always fail this branch.
      await argon2.verify(DUMMY_HASH, password).catch(() => false);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const user = r.rows[0];
    const ok = await argon2.verify(user.password_hash, password);
    if (!ok) return reply.code(401).send({ error: 'invalid_credentials' });

    const token = app.jwt.sign({ sub: user.id, email: user.email });
    return reply.send({ token, user: { id: user.id, email: user.email } });
  });

  // GET /v1/me — returns the logged-in user + their subscription state
  app.get('/v1/me', { preHandler: app.requireUser }, async (req: any, reply) => {
    const r = await app.db.query(
      `select u.id, u.email, u.created_at,
              s.status as sub_status, s.current_period_end
         from users u
         left join subscriptions s on s.user_id = u.id
        where u.id = $1`,
      [req.user.sub],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    return r.rows[0];
  });

  // POST /v1/auth/change-password
  app.post('/v1/auth/change-password', { preHandler: app.requireUser }, async (req: any, reply) => {
    const schema = z.object({ current: z.string().min(8), next: z.string().min(8).max(128) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    const r = await app.db.query('select password_hash from users where id = $1', [req.user.sub]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    if (!(await argon2.verify(r.rows[0].password_hash, parsed.data.current))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const hash = await argon2.hash(parsed.data.next, { type: argon2.argon2id });
    // Bumping tokens_valid_after invalidates EVERY token issued before now,
    // including the one currently in this request. The client must log in
    // again with the new password to receive a fresh token.
    await app.db.query(
      'update users set password_hash=$1, tokens_valid_after=now(), updated_at=now() where id=$2',
      [hash, req.user.sub],
    );
    return reply.send({ ok: true });
  });

  // POST /v1/auth/logout-everywhere — invalidate every token for this user.
  // Useful after a suspected credential leak. Same revocation mechanism as
  // change-password (bumps users.tokens_valid_after to now()).
  app.post('/v1/auth/logout-everywhere', { preHandler: app.requireUser }, async (req: any, reply) => {
    await app.db.query(
      'update users set tokens_valid_after=now(), updated_at=now() where id=$1',
      [req.user.sub],
    );
    return reply.send({ ok: true });
  });
}
