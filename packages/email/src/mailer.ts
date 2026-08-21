/**
 * The sending boundary.
 *
 * Resend is reached over plain HTTP rather than through its SDK: the request
 * is one POST with a JSON body, and a dependency that only saves that is a
 * dependency that can break the build for nothing.
 */

export interface Message {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /**
   * Where a reply goes.
   *
   * Load-bearing for outreach rather than cosmetic: the product sends on the
   * customer's behalf from its own verified domain, and if a reply came back
   * here it would land in a mailbox nobody reads. The one thing the human is
   * meant to do is answer, so the answer has to reach them.
   */
  readonly replyTo?: string;
  /**
   * Extra headers on the wire.
   *
   * This exists for `List-Unsubscribe` and `List-Unsubscribe-Post`, which have
   * to travel as headers and not as body text: a mail client offers its own
   * one-click opt-out button from the header, and providers weigh its presence
   * when deciding whether commercial mail is worth delivering.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface SendResult {
  /** The provider's id for the message, when it gave one. */
  readonly id?: string;
}

export interface Mailer {
  send(message: Message): Promise<SendResult>;
}

export interface ResendOptions {
  readonly apiKey: string;
  /** Must be an address on a domain verified with Resend. */
  readonly from: string;
  readonly fetchImpl?: typeof fetch;
}

export class MailerError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`email send failed (${status}): ${detail}`);
    this.name = 'MailerError';
    this.status = status;
  }
}

export class ResendMailer implements Mailer {
  readonly #apiKey: string;
  readonly #from: string;
  readonly #fetch: typeof fetch;

  constructor(options: ResendOptions) {
    this.#apiKey = options.apiKey;
    this.#from = options.from;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async send(message: Message): Promise<SendResult> {
    const response = await this.#fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.#from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { reply_to: [message.replyTo] } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
      }),
    });

    if (!response.ok) {
      // The body carries Resend's reason (unverified domain, invalid key).
      // Losing it would make every failure look the same in the logs.
      throw new MailerError(response.status, (await response.text().catch(() => '')).slice(0, 500));
    }

    // Kept so a delivered outreach message can be traced back to the provider
    // from the action row. A body that does not parse is not a failed send.
    const body = (await response.json().catch(() => undefined)) as { id?: string } | undefined;
    return body?.id ? { id: body.id } : {};
  }
}

/**
 * Writes the message to stdout instead of sending it.
 *
 * This is what runs with no `RESEND_API_KEY`, so a fresh checkout and the
 * test suite both complete a signup end to end. The verification link is
 * logged deliberately: without it, local signup would be unfinishable.
 */
export class ConsoleMailer implements Mailer {
  readonly #log: (message: string) => void;

  constructor(log: (message: string) => void = console.log) {
    this.#log = log;
  }

  async send(message: Message): Promise<SendResult> {
    this.#log(`[email] to=${message.to} subject=${message.subject}\n${message.text}`);
    return {};
  }
}
