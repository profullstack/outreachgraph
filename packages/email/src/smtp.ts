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
 */

import nodemailer, { type Transporter } from 'nodemailer';
import type { Mailer, Message, SendResult } from './mailer';
import { MailerError } from './mailer';

export interface SmtpCredentials {
  readonly host: string;
  readonly port: number;
  /** True for implicit TLS (465). False for STARTTLS submission (587). */
  readonly secure: boolean;
  readonly username: string;
  readonly password: string;
  /** The address mail is sent from. Usually the same as `username`. */
  readonly fromEmail: string;
  /** Display name shown to the recipient. Optional. */
  readonly fromName?: string | undefined;
}

/** How long a connection or send may take before it is treated as failed. */
const TIMEOUT_MS = 20_000;

/**
 * Formats the From header.
 *
 * The display name is quoted and its own quotes stripped, because a name
 * containing a `"` would otherwise terminate the header field early and let
 * the rest be read as address parts — a header injection with a friendly face.
 */
export function formatFrom(fromEmail: string, fromName?: string): string {
  const name = fromName?.trim();
  if (!name) return fromEmail;
  return `"${name.replace(/["\\\r\n]/g, '')}" <${fromEmail}>`;
}

export class SmtpMailer implements Mailer {
  readonly #credentials: SmtpCredentials;
  readonly #transport: Transporter;

  constructor(credentials: SmtpCredentials, transport?: Transporter) {
    this.#credentials = credentials;
    this.#transport = transport ?? createTransport(credentials);
  }

  async send(message: Message): Promise<SendResult> {
    try {
      const info = await this.#transport.sendMail({
        from: formatFrom(this.#credentials.fromEmail, this.#credentials.fromName),
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
      });

      // Nodemailer always synthesises a Message-ID, so this is never empty —
      // but it is the server's id only when the server returned one.
      return { id: typeof info.messageId === 'string' ? info.messageId : undefined };
    } catch (error) {
      throw asMailerError(error);
    }
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
    try {
      await this.#transport.verify();
    } catch (error) {
      throw asMailerError(error);
    }
  }

  close(): void {
    this.#transport.close();
  }
}

function createTransport(credentials: SmtpCredentials): Transporter {
  return nodemailer.createTransport({
    host: credentials.host,
    port: credentials.port,
    secure: credentials.secure,
    // Only meaningful on the STARTTLS path, where it turns an optional upgrade
    // into a required one.
    ...(credentials.secure ? {} : { requireTLS: true }),
    auth: { user: credentials.username, pass: credentials.password },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
}

/**
 * Turns a transport failure into the error the rest of the product handles.
 *
 * The provider's own text is kept: "535 Username and Password not accepted"
 * tells the customer to check their app password, and flattening it to
 * "send failed" tells them nothing they can act on.
 */
function asMailerError(error: unknown): MailerError {
  if (error instanceof MailerError) return error;

  const detail = error instanceof Error ? error.message : String(error);
  const code = (error as { responseCode?: unknown })?.responseCode;
  const status = typeof code === 'number' ? code : 0;

  return new MailerError(status, detail.slice(0, 500));
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
