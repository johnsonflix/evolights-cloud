import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';

const credSchema = z.object({
  email:    z.string().email().max(255),
  password: z.string().min(8).max(128),
});

export async function registerAuthRoutes(app: FastifyInstance) {
  // POST /v1/auth/register
  app.post('/v1/auth/register', async (req, reply) => {
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
  app.post('/v1/auth/login', async (req, reply) => {
    const parsed = credSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });
    const { email, password } = parsed.data;

    const r = await app.db.query('select id, email, password_hash from users where email = $1', [email]);
    if (!r.rowCount) return reply.code(401).send({ error: 'invalid_credentials' });
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
    await app.db.query('update users set password_hash=$1, updated_at=now() where id=$2', [hash, req.user.sub]);
    return reply.send({ ok: true });
  });
}
