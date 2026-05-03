import type { FastifyInstance } from 'fastify';
import jwtPlugin from '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user:    { sub: string; email: string; iat: number };
  }
}

export async function registerJwt(app: FastifyInstance) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET is required and must be >=32 chars');
  }
  await app.register(jwtPlugin, {
    secret,
    sign: { expiresIn: '7d' },
  });

  app.decorate('requireUser', async function (req: any, reply: any) {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // JWT revocation: a token issued before tokens_valid_after is rejected.
    // Bumped on password change and POST /v1/auth/logout-everywhere.
    // `iat` is in seconds (RFC 7519); compare against the column in ms.
    const iat = req.user?.iat;
    const sub = req.user?.sub;
    if (typeof iat !== 'number' || typeof sub !== 'string') {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const r = await app.db.query<{ tokens_valid_after: Date }>(
      'select tokens_valid_after from users where id = $1', [sub],
    );
    if (!r.rowCount) {
      // user deleted while their token was still valid
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (iat * 1000 < r.rows[0].tokens_valid_after.getTime()) {
      return reply.code(401).send({ error: 'token_revoked' });
    }
  });

  // Admin gate. Requires requireUser to have already populated req.user.
  // Bootstrap path: an operator manually flips users.is_admin = true on a
  // user row in the DB. We deliberately don't expose a self-promote endpoint.
  app.decorate('requireAdmin', async function (req: any, reply: any) {
    const sub = req.user?.sub;
    if (typeof sub !== 'string') {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const r = await app.db.query<{ is_admin: boolean }>(
      'select is_admin from users where id = $1', [sub],
    );
    if (!r.rowCount || !r.rows[0].is_admin) {
      return reply.code(403).send({ error: 'admin_required' });
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    requireUser: (req: any, reply: any) => Promise<void>;
    requireAdmin: (req: any, reply: any) => Promise<void>;
  }
}
