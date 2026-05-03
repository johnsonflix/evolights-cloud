import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';

import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes }   from './routes/auth.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerRelayRoutes }  from './routes/relay.js';
import { registerOtaRoutes }    from './routes/ota.js';

import { connectDb }     from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { connectMqtt }   from './mqtt/client.js';
import { registerJwt }   from './lib/jwt.js';
import { registerStripe } from './lib/stripe.js';

const port = Number(process.env.PORT ?? 8080);

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
  trustProxy: true,
});

// Stripe webhook needs the raw request body to verify signatures.
// fastify-raw-body attaches `req.rawBody` only to routes opting in via config.
await app.register(fastifyRawBody, {
  field: 'rawBody',
  global: false,
  encoding: false,
  runFirst: true,
});

await connectDb(app);
// Apply pending SQL migrations BEFORE we accept any traffic. The legacy
// schema.sql bootstrap (mounted into postgres-entrypoint-initdb.d) only ever
// fires on a brand-new postgres data volume; subsequent schema changes must
// flow through src/db/migrations/.
await runMigrations(app.db, app.log);
await connectMqtt(app);
await registerJwt(app);
await registerStripe(app);

await registerHealthRoutes(app);
await registerAuthRoutes(app);
await registerBillingRoutes(app);
await registerDeviceRoutes(app);
await registerRelayRoutes(app);
await registerOtaRoutes(app);

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
process.on('SIGINT',  () => shutdown('SIGINT'));
