/**
 * Sending through the customer's own mailbox.
 *
 * The capability matrix has always called email `customer_managed` — "sent
 * through the customer's own mailbox or sending domain". Until now the only
 * sender was the platform's Resend account, which made that description a
 * half-truth: mail went out from our verified domain with a reply-to pointing
 * back at the customer. That works, but it is not the same thing, and it is
 * not what a prospect's mail client sees.
 *
 * SMTP is the connection that makes the description true. It is also the only
 * one that works everywhere — Google Workspace, Fastmail, Forward Email,
 * Microsoft 365 and a self-hosted box all speak it, with no OAuth app review
 * and no per-provider integration. The cost is that the customer hands over a
 * password, which is why it is stored encrypted and verified before it is
 * stored at all.
 *
 * Two ports matter and they behave differently:
 *
 *   - **465** is implicit TLS: the socket is encrypted before the SMTP
 *     conversation starts. `secure: true`.
 *   - **587** is submission with STARTTLS: the conversation begins in the
 *     clear and upgrades. `secure: false`, and `requireTLS` makes the upgrade
 *     mandatory rather than opportunistic — without it a downgrade leaves the
 *     password on the wire in plaintext.
 *
 * Since 0.2.0 of @profullstack/email-queue nothing here talks to the server
 * on a send: `SmtpMailer.send()` enqueues through `./queue` and a long-lived
 * worker delivers. Only `verify()` connects directly, and it sends nothing.
 */

import { containsPostalAddress, type SmtpTransportOptions } from '@profullstack/email-queue';
import type { Mailer, Message, SendResult } from './mailer';
import { MailerError } from './mailer';
import {
  outreachEmailQueue,
  outreachTransport,
  queueFailure,
  type OutreachEmailQueue,
} from './queue';

export interface SmtpCredentials {
  readonly host: string;
  readonly port: number;
  /** True for implicit TLS (465). False for STARTTLS submission (587). */
  readonly secure: boolean;
  readonly username: string;
  readonly password: string;
  /** The address mail is sent from. Must be the same mailbox as `username`. */
  readonly fromEmail: string;
  /** Display name shown to the recipient. Optional. */
  readonly fromName?: string | undefined;
}

export interface SmtpMailerOptions {
  /**
   * The queue to send through. Defaults to the process-wide one installed at
   * startup (`configureOutreachEmailQueue`). Null, or none installed, and
   * every send is refused: SMTP never goes out directly.
   */
  readonly queue?: OutreachEmailQueue | null;
  /** Tests inject a nodemailer stand-in for `verify()`; production loads nodemailer. */
  readonly createTransport?: SmtpTransportOptions['createTransport'];
}

/**
 * The postal address in both bodies (CAN-SPAM), appended when a template did
 * not already include it. The queue refuses marketing mail without it.
 */
export function withPostalAddress(
  body: { readonly text: string; readonly html?: string | undefined },
  address: string,
): { text: string; html?: string } {
  const text = containsPostalAddress(body.text, address) ? body.text : `${body.text}\n${address}`;
  if (!body.html) return { text };
  if (containsPostalAddress(body.html, address, true)) return { text, html: body.html };
  const line = `<p style="color:#666;font-size:12px">${address
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</p>`;
  const html = /<\/body>/i.test(body.html)
    ? body.html.replace(/<\/body>/i, `${line}\n</body>`)
    : `${body.html}\n${line}`;
  return { text, html };
}

/**
 * One outreach mailbox, sending through @profullstack/email-queue.
 *
 * The transport is the package's (`createSmtpTransport`): From and the
 * envelope sender are pinned to the login, and header injection is stripped.
 * A mailbox whose From is not its login is not refused here — the constructor
 * never throws, so a bad row cannot take a whole autopilot run down — but
 * every `verify()` and `send()` is.
 */
export class SmtpMailer implements Mailer {
  readonly #credentials: SmtpCredentials;
  readonly #options: SmtpMailerOptions;
  readonly #transport?: ReturnType<typeof outreachTransport>;
  readonly #refused?: MailerError;

  constructor(credentials: SmtpCredentials, options: SmtpMailerOptions = {}) {
    this.#credentials = credentials;
    this.#options = options;
    try {
      this.#transport = outreachTransport(credentials, options.createTransport);
    } catch (error) {
      this.#refused = queueFailure(error);
    }
  }

  /** The mailbox this sends as. */
  get fromEmail(): string {
    return this.#credentials.fromEmail.trim().toLowerCase();
  }

  async send(message: Message): Promise<SendResult> {
    if (this.#refused) throw this.#refused;

    const queue =
      this.#options.queue === null ? undefined : (this.#options.queue ?? outreachEmailQueue());
    if (!queue) {
      throw new MailerError(
        503,
        'the outreach email queue is not configured (EMAIL_QUEUE_REDIS_URL, EMAIL_QUEUE_ENCRYPTION_KEY, PostgreSQL); refusing to send directly',
        'CONFIG_INVALID',
      );
    }
    const idempotencyKey = message.idempotencyKey?.trim();
    if (!idempotencyKey) {
      throw new MailerError(
        400,
        'a stable idempotency key is required',
        'IDEMPOTENCY_KEY_REQUIRED',
      );
    }
    const tenantId = message.tenantId?.trim();
    if (!tenantId) {
      throw new MailerError(
        400,
        'the workspace (tenant) of the send is required',
        'CONFIG_INVALID',
      );
    }
    const kind = message.kind ?? 'marketing';

    // Marketing mail carries the postal address in both bodies. Without one
    // configured the body is left alone and the queue refuses the message
    // (BULK_POSTAL_ADDRESS_NOT_CONFIGURED): fail closed, never send without it.
    const address = queue.postalAddress;
    const bodies =
      kind === 'marketing' && address
        ? withPostalAddress({ text: message.text, html: message.html }, address)
        : { text: message.text, ...(message.html ? { html: message.html } : {}) };

    return queue.deliver(
      this.#credentials,
      {
        to: message.to,
        subject: message.subject,
        ...bodies,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.headers ? { headers: { ...message.headers } } : {}),
      },
      { kind, idempotencyKey, tenantId },
    );
  }

  /**
   * Proves the credentials before anything is stored.
   *
   * Connecting and authenticating here is the difference between "saved" and
   * "working". Storing an unverified password produces a workspace that looks
   * connected, passes the policy gate, and fails on the first real prospect —
   * which is the worst possible moment to discover a typo.
   */
  async verify(): Promise<void> {
    if (this.#refused) throw this.#refused;
    try {
      await this.#transport!.verify();
    } catch (error) {
      // The provider's own text is kept: "535 Username and Password not
      // accepted" tells the customer to check their app password.
      const detail = error instanceof Error ? error.message : String(error);
      const status = Number(/SMTP (\d{3})/.exec(detail)?.[1] ?? 0);
      throw new MailerError(status, detail.slice(0, 500));
    }
  }

  close(): void {
    this.#transport?.close();
  }
}

/**
 * The common presets, so the connect form can be two fields instead of five.
 *
 * Gmail and Microsoft both refuse a plain account password here: Gmail needs
 * an app password (and 2FA enabled to create one), Microsoft 365 needs SMTP
 * AUTH switched on for the mailbox. Saying so at the point of connection is
 * the difference between a working mailbox and a support ticket.
 */
export interface SmtpPreset {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly note?: string;
  /**
   * Where the same mailbox is read from.
   *
   * One picker fills in both halves because they are one mailbox and one
   * credential — asking someone to know that Forward Email sends on
   * `smtp.forwardemail.net` and is read on `imap.forwardemail.net` is asking
   * them to look up something we already know. Absent on the generic entry,
   * where the whole point is that the host is typed in.
   */
  readonly imapHost?: string;
  readonly imapPort?: number;
  readonly imapSecure?: boolean;
}

export const SMTP_PRESETS: readonly SmtpPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecure: true,
    note: 'Use a 16-character app password, not your account password. Requires 2-step verification. The same app password reads the mailbox.',
  },
  {
    id: 'microsoft',
    label: 'Microsoft 365 / Outlook',
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapSecure: true,
    note: 'SMTP AUTH must be enabled for the mailbox in the Microsoft 365 admin centre.',
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    host: 'smtp.fastmail.com',
    port: 465,
    secure: true,
    imapHost: 'imap.fastmail.com',
    imapPort: 993,
    imapSecure: true,
    note: 'Create an app password scoped to both SMTP and IMAP.',
  },
  {
    id: 'forwardemail',
    label: 'Forward Email',
    host: 'smtp.forwardemail.net',
    port: 465,
    secure: true,
    imapHost: 'imap.forwardemail.net',
    imapPort: 993,
    imapSecure: true,
    note: 'The same generated password sends and reads.',
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    imapSecure: true,
  },
  {
    id: 'custom',
    label: 'Other (enter host and port)',
    host: '',
    port: 587,
    secure: false,
    imapHost: '',
    imapPort: 993,
    imapSecure: true,
  },
];
