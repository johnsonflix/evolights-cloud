import type { FastifyInstance } from 'fastify';
import pg from 'pg';

declare module 'fastify' {
  interface FastifyInstance {
    db: pg.Pool;
  }
}

export async function connectDb(app: FastifyInstance) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const pool = new pg.Pool({ connectionString: url, max: 10 });
  await pool.query('select 1');
  app.decorate('db', pool);
  app.addHook('onClose', async () => {
    await pool.end();
  });
  app.log.info('postgres connected');
}
