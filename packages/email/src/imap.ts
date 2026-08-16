/**
 * Reading the mailbox, which SMTP cannot do.
 *
 * SMTP is the outbound pipe — its whole vocabulary is `MAIL FROM`, `RCPT TO`,
 * `DATA`. There is no verb for "what arrived", so a product that only speaks
 * SMTP cannot notice that anyone replied, which is how outreach ends up
 * mailing someone who already answered. Reading is IMAP, on a different port,
 * with the same credentials the mailbox was connected with.
 *
 * This module is deliberately only a reader. It does not decide what a reply
 * means, which prospect it belongs to, or whether anything should stop —
 * `packages/pipeline/src/receive-email.ts` owns all of that. Here the job is
 * to turn a mailbox into a list of messages, and to be honest about which of
 * them were written by a machine.
 */

import { ImapFlow } from 'imapflow';

export interface ImapCredentials {
  readonly host: string;
  readonly port: number;
  /** True for implicit TLS (993). Nearly always true; 143 is the exception. */
  readonly secure: boolean;
  readonly username: string;
  readonly password: string;
}

export interface IncomingMessage {
  readonly messageId?: string | undefined;
  readonly inReplyTo?: string | undefined;
  /** Lowercased, so it can be compared with a stored contact address. */
  readonly fromAddress: string;
  readonly fromName?: string | undefined;
  readonly subject?: string | undefined;
  readonly receivedAt: Date;
  /**
   * Why this message is not a human reply, when it is not one.
   *
   * A string rather than a boolean because the reason is worth logging: an
   * out-of-office and a hard bounce need opposite follow-ups, and "we ignored
   * something" is unactionable without knowing what.
   */
  readonly automated?: 'auto_reply' | 'bounce' | 'bulk' | undefined;
}

/** The seam tests replace, so no socket is opened. */
export interface MailReader {
  fetchSince(since: Date, limit: number): Promise<IncomingMessage[]>;
}

/**
 * Headers that mean "a machine sent this".
 *
 * This list is the difference between a working reply gate and one that
 * silently stops all outreach to a company because somebody set an
 * out-of-office. Treating an auto-reply as a real reply is not a cosmetic
 * error — it permanently removes a prospect from the queue on the strength of
 * a robot.
 */
const WANTED_HEADERS = [
  'auto-submitted',
  'precedence',
  'x-autoreply',
  'x-autorespond',
  'x-auto-response-suppress',
  'return-path',
  'content-type',
];

/** Local-parts that never belong to a person worth recording a reply from. */
const MACHINE_LOCAL_PARTS = new Set([
  'mailer-daemon',
  'postmaster',
  'no-reply',
  'noreply',
  'donotreply',
  'do-not-reply',
  'bounces',
  'bounce',
]);

export function classifyAutomated(
  fromAddress: string,
  headers: Readonly<Record<string, string>>,
): IncomingMessage['automated'] {
  const local = fromAddress.split('@')[0]?.toLowerCase() ?? '';

  // An empty return path is the null sender, which is how a bounce is
  // required to be addressed. It is the most reliable signal here.
  const returnPath = headers['return-path']?.trim();
  if (returnPath === '<>' || returnPath === '') return 'bounce';
  if (MACHINE_LOCAL_PARTS.has(local)) return 'bounce';

  const autoSubmitted = headers['auto-submitted']?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return 'auto_reply';

  if (headers['x-autoreply'] || headers['x-autorespond']) return 'auto_reply';
  if (headers['x-auto-response-suppress']) return 'auto_reply';

  const precedence = headers['precedence']?.trim().toLowerCase();
  if (precedence === 'bulk' || precedence === 'auto_reply' || precedence === 'junk') {
    return precedence === 'bulk' || precedence === 'junk' ? 'bulk' : 'auto_reply';
  }

  return undefined;
}

/** Parses the raw header block IMAP returns into a lowercased lookup. */
export function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  // Unfold first: a header value may continue on following indented lines,
  // and a split value matches none of the checks above.
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');

  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }

  return headers;
}

export class ImapReader implements MailReader {
  readonly #credentials: ImapCredentials;
  readonly #mailbox: string;

  constructor(credentials: ImapCredentials, mailbox = 'INBOX') {
    this.#credentials = credentials;
    this.#mailbox = mailbox;
  }

  /**
   * Everything that arrived since `since`, newest last, capped at `limit`.
   *
   * The connection is opened and closed per call rather than held. Polling
   * runs on a timer measured in minutes, and a long-lived IMAP connection is a
   * thing to keep alive, reconnect and monitor for no benefit at that cadence.
   */
  async fetchSince(since: Date, limit: number): Promise<IncomingMessage[]> {
    const client = new ImapFlow({
      host: this.#credentials.host,
      port: this.#credentials.port,
      secure: this.#credentials.secure,
      auth: { user: this.#credentials.username, pass: this.#credentials.password },
      // Its own logger writes a JSON line per IMAP command, which buries
      // everything else in the container log.
      logger: false,
    });

    await client.connect();
    const messages: IncomingMessage[] = [];

    try {
      const lock = await client.getMailboxLock(this.#mailbox);
      try {
        for await (const message of client.fetch(
          { since },
          { envelope: true, headers: WANTED_HEADERS },
        )) {
          const from = message.envelope?.from?.[0];
          const address = from?.address?.trim().toLowerCase();
          // A message with no parseable sender cannot be matched to anyone, so
          // recording it would only add a row nothing can ever use.
          if (!address) continue;

          const headers = parseHeaders(
            typeof message.headers === 'string'
              ? message.headers
              : (message.headers?.toString() ?? ''),
          );

          messages.push({
            fromAddress: address,
            ...(from?.name ? { fromName: from.name } : {}),
            ...(message.envelope?.subject ? { subject: message.envelope.subject } : {}),
            ...(message.envelope?.messageId ? { messageId: message.envelope.messageId } : {}),
            ...(message.envelope?.inReplyTo ? { inReplyTo: message.envelope.inReplyTo } : {}),
            receivedAt: message.envelope?.date ?? new Date(),
            ...(classifyAutomated(address, headers)
              ? { automated: classifyAutomated(address, headers) }
              : {}),
          });
        }
      } finally {
        lock.release();
      }
    } finally {
      // Never leave the socket open on a failure; the next poll would then be
      // competing with it for the same mailbox lock.
      await client.logout().catch(() => undefined);
    }

    return messages.slice(-limit);
  }
}
