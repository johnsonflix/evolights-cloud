import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import fastifyHelmet from '@fastify/helmet';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';

import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes }   from './routes/auth.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerRelayRoutes }  from './routes/relay.js';
import { registerOtaRoutes }    from './routes/ota.js';
import { registerAdminRoutes }  from './routes/admin.js';

import { connectDb }     from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { connectMqtt }   from './mqtt/client.js';
import { registerJwt }   from './lib/jwt.js';
import { registerStripe } from './lib/stripe.js';
import { registerEmailService } from './lib/email.js';
import { getSetting } from './lib/settings.js';

const port = Number(process.env.PORT ?? 8080);

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    // Pino redaction. We deliberately log request bodies and response
    // bodies at debug level for diagnostics, which means EVERY secret the
    // API touches (login passwords, MQTT creds we mint and return on
    // pairing, Stripe signatures, bearer tokens) was previously a grep
    // away for anyone with log access. Censor them at the logger level so
    // we cannot accidentally leak via a stray app.log.debug({ req }) call.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["stripe-signature"]',
        'req.body.password',
        'req.body.current',
        'req.body.next',
        'mqtt_pass',
        'res.body.mqtt_pass',
        'res.body.token',
        'token',
        'signature',
      ],
      censor: '[redacted]',
    },
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

// Standard hardening response headers (CSP, X-Frame-Options, etc.). The default
// helmet config is appropriate for a JSON API that is not serving a browser UI.
await app.register(fastifyHelmet);

// DB has to come up BEFORE CORS so the CORS plugin can read its allowlist
// from the runtime settings table (which was previously a CORS_ORIGIN env
// var). Migrations run inside connectDb's wake so app_settings exists by
// the time we read from it below.
await connectDb(app);
await runMigrations(app.db, app.log);

// CORS: deny by default. Allowlist source-of-truth is the runtime
// `security.cors_origins` setting (DB override beats env). The webhook
// and relay endpoints intentionally do not require CORS since they are
// called by Stripe (server-side) and native mobile clients (no Origin
// header) respectively, and a missing-Origin request is already accepted
// by @fastify/cors when origin is a function returning false for
// unspecified origins.
//
// Restart-required caveat: @fastify/cors binds the origin policy at
// register-time, so changes to security.cors_origins won't take effect
// until the next boot. The admin UI surfaces this with a needs_restart
// banner; see app_settings.needs_restart in routes/admin.ts.
const dbCorsOrigins = await getSetting<string[]>(app.db, 'security.cors_origins');
const corsOrigins = dbCorsOrigins && dbCorsOrigins.length > 0 ? dbCorsOrigins : false;
await app.register(fastifyCors, {
  // origin === false denies cross-origin browser requests; same-origin and
  // requests with no Origin header (Stripe webhook callers, native mobile
  // app HTTP clients that don't set Origin) are unaffected by CORS.
  origin: corsOrigins,
  credentials: !!corsOrigins,
});

// Rate limiting. Global default applied to every route; per-route overrides
// are set in routes/auth.ts and routes/devices.ts (login/register/redeem are
// brute-forceable; webhook is trusted-source and skips entirely).
await app.register(fastifyRateLimit, {
  global: true,
  max: 100,
  timeWindow: '1 minute',
  // Per-route configs override this; the webhook route turns rate-limiting OFF
  // explicitly via { config: { rateLimit: false } } in routes/billing.ts. Stripe
  // is a trusted source and a month-end burst of subscription events must not
  // be dropped, or our DB falls out of sync with Stripe.
});

await connectMqtt(app);
await registerJwt(app);
await registerStripe(app);

// Email service: optional and now runtime-mutable. registerEmailService
// decorates app with a resolver function (`app.email()`) that lazily builds
// + memoises a transporter from current settings. The admin PATCH endpoint
// calls app.invalidateEmail() when any email.* setting changes so credential
// rotation takes effect on the next /v1/auth/forgot-password without a
// process restart. Routes still receive null when no provider is configured.
await registerEmailService(app);

await registerHealthRoutes(app);
await registerAuthRoutes(app);
await registerBillingRoutes(app);
await registerDeviceRoutes(app);
await registerRelayRoutes(app);
await registerOtaRoutes(app);
await registerAdminRoutes(app);

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
