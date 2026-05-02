import Fastify from 'fastify';
import { registerHealthRoutes } from './routes/health.js';
import { connectDb } from './db/client.js';
import { connectMqtt } from './mqtt/client.js';

const port = Number(process.env.PORT ?? 8080);

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
});

await connectDb(app);
await connectMqtt(app);

await registerHealthRoutes(app);

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
