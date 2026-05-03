import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { ClientSecretCredential } from '@azure/identity';
import { Client as GraphClient } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';
import type { Pool } from 'pg';
import { getSetting } from './settings.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Resolves to the active EmailService (or null if not configured).
     *
     * Why a function instead of a value: the email provider is now a
     * runtime-mutable setting, so a long-running process must be able to
     * pick up provider/credential changes without restart. Each call hits
     * the in-process settings cache (60s TTL); the resolver memoises the
     * built service per (provider, signature) tuple so we don't re-build
     * a transporter on every send.
     */
    email: () => Promise<EmailService | null>;
    /** Force-reload on next call (used by the admin PATCH endpoint). */
    invalidateEmail: () => void;
  }
}

/**
 * Transactional email abstraction.
 *
 * Two providers, picked by the `email.provider` setting (was EMAIL_PROVIDER):
 *   - smtp  : nodemailer over SMTP (works with SES/Mailgun/SendGrid/Gmail/own server)
 *   - graph : Microsoft Graph /users/{upn}/sendMail using OAuth client-credentials
 *             flow against an Azure AD app (Mail.Send application permission).
 *
 * The active provider is selected by the setting value and verified at
 * build time. registerEmailService() returns null transparently if no
 * provider is configured -- callers (e.g. /v1/auth/forgot-password) handle
 * the null case so degraded deploys don't crash.
 *
 * Settings reads are memoised inside a per-process resolver: the first
 * /v1/auth/forgot-password after boot builds and verifies the transporter,
 * subsequent calls reuse it. invalidateEmail() forces the next call to
 * rebuild -- the admin PATCH endpoint calls this whenever any email.*
 * setting changes, so credential rotation takes effect immediately.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailService {
  send(msg: EmailMessage): Promise<void>;
}

class SmtpEmailService implements EmailService {
  constructor(
    private readonly transporter: Transporter,
    private readonly from: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  async send(msg: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    this.log.info({ to: msg.to, subject: msg.subject, provider: 'smtp' }, 'email sent');
  }
}

class GraphEmailService implements EmailService {
  constructor(
    private readonly client: GraphClient,
    private readonly senderUpn: string,
    private readonly from: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  async send(msg: EmailMessage): Promise<void> {
    // Graph /users/{id}/sendMail. The "from" header on Graph sends is set
    // server-side to the mailbox we're calling; we accept email.from only
    // for logging/parity with the SMTP path.
    const body = {
      message: {
        subject: msg.subject,
        body: {
          contentType: msg.html ? 'HTML' : 'Text',
          content: msg.html ?? msg.text,
        },
        toRecipients: [{ emailAddress: { address: msg.to } }],
      },
      saveToSentItems: false,
    };
    await this.client.api(`/users/${encodeURIComponent(this.senderUpn)}/sendMail`).post(body);
    this.log.info({ to: msg.to, subject: msg.subject, provider: 'graph', from: this.from }, 'email sent');
  }
}

/**
 * Build an EmailService from the current settings, or return null if the
 * config isn't viable. Pure function -- no caching here; the resolver in
 * registerEmailService() handles memoisation.
 */
async function buildEmailService(
  db: Pool,
  log: FastifyBaseLogger,
): Promise<EmailService | null> {
  const provider = (await getSetting<string>(db, 'email.provider'))?.toLowerCase();
  const from = await getSetting<string>(db, 'email.from');

  if (!provider) {
    log.warn('email.provider not set — email features (password reset etc.) are disabled');
    return null;
  }
  if (!from) {
    log.warn({ provider }, 'email.from not set — email features are disabled');
    return null;
  }

  if (provider === 'smtp') {
    const host   = await getSetting<string>(db,  'email.smtp.host');
    const port   = (await getSetting<number>(db, 'email.smtp.port'))   ?? 587;
    const secure = (await getSetting<boolean>(db,'email.smtp.secure')) ?? false;
    const user   = await getSetting<string>(db,  'email.smtp.user');
    const pass   = await getSetting<string>(db,  'email.smtp.pass');

    if (!host) {
      log.warn('email.provider=smtp but email.smtp.host not set — email disabled');
      return null;
    }
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass: pass ?? '' } : undefined,
    });
    try {
      await transporter.verify();
      log.info({ host, port, secure }, 'smtp transporter verified');
    } catch (e) {
      // Don't crash the process — log loudly and disable email instead. A
      // misconfigured SMTP shouldn't take down the whole API.
      log.error(
        { err: (e as Error).message, host, port },
        'smtp verify failed — email disabled',
      );
      return null;
    }
    return new SmtpEmailService(transporter, from, log);
  }

  if (provider === 'graph') {
    const tenantId     = await getSetting<string>(db, 'email.graph.tenant_id');
    const clientId     = await getSetting<string>(db, 'email.graph.client_id');
    const clientSecret = await getSetting<string>(db, 'email.graph.client_secret');
    const senderUpn    = await getSetting<string>(db, 'email.graph.sender_upn');
    if (!tenantId || !clientId || !clientSecret || !senderUpn) {
      log.warn('email.provider=graph but email.graph.* not fully set — email disabled');
      return null;
    }
    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const client = GraphClient.initWithMiddleware({
      authProvider: {
        getAccessToken: async () => {
          const t = await credential.getToken('https://graph.microsoft.com/.default');
          if (!t) throw new Error('failed to acquire Graph token');
          return t.token;
        },
      },
    });
    log.info({ tenantId, senderUpn }, 'graph email client configured');
    return new GraphEmailService(client, senderUpn, from, log);
  }

  log.warn({ provider }, 'unknown email.provider — email disabled');
  return null;
}

/**
 * Decorate the Fastify instance with `app.email()` (a memoised resolver) and
 * `app.invalidateEmail()` (called by the admin PATCH endpoint when any
 * email.* setting changes).
 *
 * Memoisation strategy: a single in-flight Promise<EmailService|null>. Once
 * resolved we keep it forever -- until something calls invalidateEmail(),
 * which clears the cell so the next email() rebuilds. We deliberately do
 * NOT TTL this; SMTP transporters keep connection pools we don't want to
 * tear down on a timer.
 */
export async function registerEmailService(app: FastifyInstance): Promise<void> {
  let cached: Promise<EmailService | null> | null = null;

  const resolver = (): Promise<EmailService | null> => {
    if (cached) return cached;
    cached = buildEmailService(app.db, app.log).catch((e) => {
      app.log.error({ err: (e as Error).message }, 'email service build crashed');
      cached = null; // allow retry on next call
      return null;
    });
    return cached;
  };

  app.decorate('email', resolver);
  app.decorate('invalidateEmail', () => {
    cached = null;
  });
}
