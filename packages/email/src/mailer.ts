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
}

export interface Mailer {
  send(message: Message): Promise<void>;
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

  async send(message: Message): Promise<void> {
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
      }),
    });

    if (!response.ok) {
      // The body carries Resend's reason (unverified domain, invalid key).
      // Losing it would make every failure look the same in the logs.
      throw new MailerError(response.status, (await response.text().catch(() => '')).slice(0, 500));
    }
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

  async send(message: Message): Promise<void> {
    this.#log(`[email] to=${message.to} subject=${message.subject}\n${message.text}`);
  }
}
