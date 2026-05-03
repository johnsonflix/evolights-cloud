import type { FastifyBaseLogger } from 'fastify';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { ClientSecretCredential } from '@azure/identity';
import { Client as GraphClient } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';

declare module 'fastify' {
  interface FastifyInstance {
    /** May be null if no email provider is configured. Routes must guard. */
    email: EmailService | null;
  }
}

/**
 * Transactional email abstraction.
 *
 * Two providers, picked at boot via EMAIL_PROVIDER:
 *   - smtp  : nodemailer over SMTP (works with SES/Mailgun/SendGrid/Gmail/own server)
 *   - graph : Microsoft Graph /users/{upn}/sendMail using OAuth client-credentials
 *             flow against an Azure AD app (Mail.Send application permission).
 *
 * Both can be configured at the same time but only one is active per process;
 * the active provider is selected by EMAIL_PROVIDER and verified at boot.
 *
 * loadEmailService() returns null if no provider is configured. Callers MUST
 * handle the null case (e.g. /v1/auth/forgot-password 503s) so the service
 * degrades gracefully on partially-configured deploys rather than crashing
 * at boot.
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
    // server-side to the mailbox we're calling; we accept EMAIL_FROM only for
    // logging/parity with the SMTP path.
    const body: any = {
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

export async function loadEmailService(log: FastifyBaseLogger): Promise<EmailService | null> {
  const provider = process.env.EMAIL_PROVIDER?.toLowerCase();
  const from = process.env.EMAIL_FROM;

  if (!provider) {
    log.warn('EMAIL_PROVIDER not set — email features (password reset etc.) will be disabled');
    return null;
  }
  if (!from) {
    log.warn({ provider }, 'EMAIL_FROM not set — email features will be disabled');
    return null;
  }

  if (provider === 'smtp') {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT ?? 587);
    const secure = (process.env.SMTP_SECURE ?? 'false').toLowerCase() === 'true';
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host) {
      log.warn('EMAIL_PROVIDER=smtp but SMTP_HOST not set — email disabled');
      return null;
    }
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,            // true for 465, false for 587 STARTTLS
      auth: user ? { user, pass } : undefined,
    });
    try {
      await transporter.verify();
      log.info({ host, port, secure }, 'smtp transporter verified');
    } catch (e: any) {
      // Don't crash the process — log loudly and disable email instead. A
      // misconfigured SMTP shouldn't take down the whole API.
      log.error({ err: e.message, host, port }, 'smtp verify failed — email disabled');
      return null;
    }
    return new SmtpEmailService(transporter, from, log);
  }

  if (provider === 'graph') {
    const tenantId = process.env.GRAPH_TENANT_ID;
    const clientId = process.env.GRAPH_CLIENT_ID;
    const clientSecret = process.env.GRAPH_CLIENT_SECRET;
    const senderUpn = process.env.GRAPH_SENDER_UPN;
    if (!tenantId || !clientId || !clientSecret || !senderUpn) {
      log.warn('EMAIL_PROVIDER=graph but GRAPH_* env not fully set — email disabled');
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

  log.warn({ provider }, 'unknown EMAIL_PROVIDER — email disabled');
  return null;
}
