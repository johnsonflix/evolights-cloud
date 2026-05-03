import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import appleSignin, { type AppleIdTokenType } from 'apple-signin-auth';

const credSchema = z.object({
  email:    z.string().email().max(255),
  password: z.string().min(8).max(128),
});

// Computed once at module load — argon2.hash with default params takes ~100ms,
// so we MUST NOT do it per request. Used to equalise timing on the
// "user does not exist" branch of /v1/auth/login so an attacker can't enumerate
// registered emails by measuring response latency.
const DUMMY_HASH_PROMISE: Promise<string> = argon2.hash('dummy-for-timing-equalization', { type: argon2.argon2id });

/** Build the per-process Google verifier configured for ALL allowed audiences. */
function loadGoogleAudiences(): string[] {
  return [
    process.env.GOOGLE_CLIENT_ID_IOS,
    process.env.GOOGLE_CLIENT_ID_ANDROID,
    process.env.GOOGLE_CLIENT_ID_WEB,
  ].filter((s): s is string => !!s && s.length > 0);
}

export async function registerAuthRoutes(app: FastifyInstance) {
  const DUMMY_HASH = await DUMMY_HASH_PROMISE;

  const googleAudiences = loadGoogleAudiences();
  const googleClient = googleAudiences.length ? new OAuth2Client() : null;
  if (!googleAudiences.length) {
    app.log.warn('no GOOGLE_CLIENT_ID_* configured — POST /v1/auth/google will 503');
  }
  const appleClientId = process.env.APPLE_CLIENT_ID;
  if (!appleClientId) {
    app.log.warn('APPLE_CLIENT_ID not set — POST /v1/auth/apple will 503');
  }

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

    const r = await app.db.query(
      'select id, email, password_hash from users where email = $1',
      [email],
    );
    if (!r.rowCount || !r.rows[0].password_hash) {
      // Burn time on a constant-time-ish argon2 verify so attackers can't
      // enumerate registered emails by latency. Result is intentionally
      // discarded; we always fail this branch.
      // The `!password_hash` branch hits OAuth-only users (signed up via
      // Apple/Google, no local password set yet) and gives them the same
      // response so we don't reveal which providers are linked.
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
      `select u.id, u.email, u.created_at, u.email_verified,
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
    if (!r.rows[0].password_hash) {
      // OAuth-only user trying to change a non-existent password. They should
      // use a future "set password" flow instead.
      return reply.code(409).send({ error: 'no_local_password' });
    }
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

  // ----------------- Password reset flow ---------------------------------
  // Two-step:
  //   POST /v1/auth/forgot-password  body {email}    -> 202 always
  //   POST /v1/auth/reset-password   body {token,password} -> 200 / 410
  // Always-202 on forgot-password prevents account enumeration. The body
  // validation errors still 400 because they don't leak account existence.

  const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL ?? 'https://app.evolights.io';
  const RESET_TTL_MIN = 30;

  app.post('/v1/auth/forgot-password', {
    // Tight per-IP cap: forgot-password is a free email-bomb amplifier
    // (attacker submits a victim's address; we send them a reset email).
    // 5/hr per IP keeps abuse low while letting a real user retry on typos.
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const schema = z.object({ email: z.string().email().max(255) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    // Look up the account but always return 202 so we don't leak existence.
    const r = await app.db.query<{ id: string; email: string }>(
      'select id, email from users where email = $1',
      [parsed.data.email],
    );

    if (r.rowCount && app.email) {
      const userId = r.rows[0].id;
      const token = crypto.randomBytes(16).toString('hex'); // 32 hex chars
      try {
        await app.db.query(
          `insert into password_reset_tokens (token, user_id, expires_at)
           values ($1, $2, now() + ($3 || ' minutes')::interval)`,
          [token, userId, RESET_TTL_MIN],
        );
        const resetUrl = `${PUBLIC_WEB_URL.replace(/\/+$/, '')}/reset?token=${token}`;
        await app.email.send({
          to: r.rows[0].email,
          subject: 'Reset your EvoLights password',
          text:
            `Someone (hopefully you) requested a password reset for your EvoLights account.\n\n` +
            `Open this link to set a new password (valid for ${RESET_TTL_MIN} minutes):\n${resetUrl}\n\n` +
            `If you didn't request this, you can ignore this email — your password will not change.`,
          html:
            `<p>Someone (hopefully you) requested a password reset for your EvoLights account.</p>` +
            `<p><a href="${resetUrl}">Click here to set a new password</a> (valid for ${RESET_TTL_MIN} minutes).</p>` +
            `<p>If you didn't request this, you can ignore this email — your password will not change.</p>`,
        });
      } catch (e: any) {
        // Don't leak send failures to the client; the always-202 contract
        // hides whether email even fired. Log it loudly so an operator
        // notices smtp/Graph drift.
        app.log.error({ err: e.message, userId }, 'forgot-password send failed');
      }
    } else if (r.rowCount && !app.email) {
      // Account exists but we have no email service — log so the operator
      // sees that resets are silently dead. Still 202 to user.
      app.log.warn({ email: parsed.data.email }, 'forgot-password requested but no email service configured');
    }

    return reply.code(202).send({ ok: true });
  });

  app.post('/v1/auth/reset-password', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const schema = z.object({
      token:    z.string().regex(/^[0-9a-f]{32}$/),
      password: z.string().min(8).max(128),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    // Atomic claim: the conditional UPDATE either wins (returning user_id) or
    // returns no rows (already used / expired / unknown). No SELECT-then-UPDATE
    // race window. Same pattern as pairing-code redemption in devices.ts.
    const claim = await app.db.query<{ user_id: string }>(
      `update password_reset_tokens
          set used_at = now()
        where token = $1
          and used_at is null
          and expires_at > now()
        returning user_id`,
      [parsed.data.token],
    );
    if (!claim.rowCount) return reply.code(410).send({ error: 'token_invalid_or_expired' });

    const newHash = await argon2.hash(parsed.data.password, { type: argon2.argon2id });
    // Bump tokens_valid_after so any sessions established before the reset
    // are revoked — if an attacker had a stolen token, it stops working now.
    await app.db.query(
      `update users
          set password_hash = $1,
              tokens_valid_after = now(),
              updated_at = now()
        where id = $2`,
      [newHash, claim.rows[0].user_id],
    );

    return reply.send({ ok: true });
  });

  // ----------------- Sign in with Apple --------------------------------
  // POST /v1/auth/apple body { id_token, nonce? }
  //
  // Native flow: the iOS app uses ASAuthorizationAppleIDProvider to obtain an
  // ID token signed by Apple, then POSTs that token here. We verify against
  // Apple's JWKS (https://appleid.apple.com/auth/keys), confirm aud == our
  // services ID, then look up / link / create the user.
  //
  // apple-signin-auth handles JWKS rotation correctly (Apple has rotated keys
  // multiple times); rolling JWKS verification ourselves would be brittle.
  app.post('/v1/auth/apple', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    if (!appleClientId) return reply.code(503).send({ error: 'apple_not_configured' });
    const schema = z.object({
      id_token: z.string().min(10).max(8192),
      nonce:    z.string().min(1).max(128).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    let claims: AppleIdTokenType;
    try {
      claims = await appleSignin.verifyIdToken(parsed.data.id_token, {
        audience: appleClientId,
        nonce:    parsed.data.nonce,
        // ignoreExpiration is intentionally NOT set (default false) — token
        // exp is enforced.
      });
    } catch (e: any) {
      app.log.warn({ err: e.message }, 'apple id_token verification failed');
      return reply.code(401).send({ error: 'invalid_id_token' });
    }

    const sub = claims.sub;
    const email = claims.email?.toLowerCase();
    // Apple's email_verified is delivered as a string ("true") or boolean
    // depending on flow; coerce.
    const verified = String(claims.email_verified ?? 'false') === 'true';

    const user = await findOrLinkOrCreateUser(app, {
      provider: 'apple',
      sub,
      email,
      emailVerified: verified,
    });
    if (!user) return reply.code(409).send({ error: 'account_link_conflict' });

    const token = app.jwt.sign({ sub: user.id, email: user.email });
    return reply.send({ token, user: { id: user.id, email: user.email } });
  });

  // ----------------- Sign in with Google -------------------------------
  // POST /v1/auth/google body { id_token }
  //
  // Native flow: iOS / Android / web app uses Google's SDK to obtain an ID
  // token; we verify it against Google's JWKS via google-auth-library and
  // accept tokens issued for any of our configured client IDs (different per
  // platform).
  app.post('/v1/auth/google', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    if (!googleClient || googleAudiences.length === 0) {
      return reply.code(503).send({ error: 'google_not_configured' });
    }
    const schema = z.object({
      id_token: z.string().min(10).max(8192),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: parsed.data.id_token,
        // Passing an array makes verifyIdToken accept tokens whose aud claim
        // matches any of our configured client IDs (iOS / Android / web).
        audience: googleAudiences,
      });
      payload = ticket.getPayload();
    } catch (e: any) {
      app.log.warn({ err: e.message }, 'google id_token verification failed');
      return reply.code(401).send({ error: 'invalid_id_token' });
    }
    if (!payload || !payload.sub) return reply.code(401).send({ error: 'invalid_id_token' });

    const sub = payload.sub;
    const email = payload.email?.toLowerCase();
    const verified = !!payload.email_verified;

    const user = await findOrLinkOrCreateUser(app, {
      provider: 'google',
      sub,
      email,
      emailVerified: verified,
    });
    if (!user) return reply.code(409).send({ error: 'account_link_conflict' });

    const token = app.jwt.sign({ sub: user.id, email: user.email });
    return reply.send({ token, user: { id: user.id, email: user.email } });
  });
}

/**
 * Look up / link / create a user given an OAuth-provider sub + optional email.
 *
 * Order of precedence:
 *   1. Match by provider sub (apple_sub / google_sub) → existing user
 *   2. Match by email → link this provider sub to that account, mark verified
 *      if provider asserts it
 *   3. Create new user, no password_hash, set provider sub
 *
 * Returns null on the rare case where the email is bound to an account that
 * already has a DIFFERENT provider sub (extremely unlikely; signals an
 * account mishap an admin needs to resolve manually).
 */
async function findOrLinkOrCreateUser(
  app: FastifyInstance,
  args: {
    provider: 'apple' | 'google';
    sub: string;
    email: string | undefined;
    emailVerified: boolean;
  },
): Promise<{ id: string; email: string } | null> {
  const subCol = args.provider === 'apple' ? 'apple_sub' : 'google_sub';

  // 1. Lookup by sub.
  const bySub = await app.db.query<{ id: string; email: string }>(
    `select id, email from users where ${subCol} = $1`,
    [args.sub],
  );
  if (bySub.rowCount) return bySub.rows[0];

  // 2. Lookup by email — link if found.
  if (args.email) {
    const byEmail = await app.db.query<{ id: string; email: string; existing_sub: string | null }>(
      `select id, email, ${subCol} as existing_sub
         from users where email = $1`,
      [args.email],
    );
    if (byEmail.rowCount) {
      const row = byEmail.rows[0];
      if (row.existing_sub && row.existing_sub !== args.sub) {
        // Email is bound to a different provider sub — refuse rather than
        // silently re-link. An admin (or a future "merge accounts" flow)
        // needs to resolve this.
        return null;
      }
      await app.db.query(
        `update users
            set ${subCol} = $1,
                email_verified = email_verified or $2,
                updated_at = now()
          where id = $3`,
        [args.sub, args.emailVerified, row.id],
      );
      return { id: row.id, email: row.email };
    }
  }

  // 3. Create. Apple may not give us an email at all (private relay drops
  // after first login); store a synthetic placeholder so the unique
  // constraint on email is satisfied. Operators can later prompt the user
  // to add a real email through a profile-update endpoint.
  const email = args.email ?? `${args.sub}@${args.provider}.users.noreply.evolights.io`;
  const ins = await app.db.query<{ id: string; email: string }>(
    `insert into users (email, password_hash, ${subCol}, email_verified)
     values ($1, null, $2, $3)
     returning id, email`,
    [email, args.sub, args.emailVerified],
  );
  return ins.rows[0];
}
