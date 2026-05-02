import type { FastifyInstance } from 'fastify';
import jwtPlugin from '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user:    { sub: string; email: string };
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
      reply.code(401).send({ error: 'unauthorized' });
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    requireUser: (req: any, reply: any) => Promise<void>;
  }
}
