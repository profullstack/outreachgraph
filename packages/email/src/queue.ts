/**
 * Outreach email through @profullstack/email-queue.
 *
 * Every SMTP send in the product goes through here: BullMQ on Redis for the
 * scheduling, PostgreSQL for the audit, and the package's gates in front of
 * the provider. What that buys, and why each part is not optional:
 *
 *   - **Only the two outreach mailboxes.** `authorizedSenders` is
 *     `cha0spunk@profullstack.com` and `knox@profullstack.com`; a transport for
 *     any other mailbox cannot even be constructed.
 *   - **Stop, never reroute.** A provider block (auth failure, 5.7.x policy
 *     refusal, persistent throttling) pauses that mailbox's queue and every
 *     later submission is refused with `SENDER_PAUSED`. Nothing here, and
 *     nothing in the sender pool, moves the message to the other mailbox.
 *   - **One key, one send.** Each message carries a stable key
 *     (`outreach:<workspace>:<prospect>:<step>`). A replay returns the earlier
 *     receipt; a send whose outcome is uncertain is never retried.
 *   - **Fail closed.** No Redis, no encryption key or no Postgres audit store
 *     means no queue, and with no queue the SMTP mailer refuses to send rather
 *     than talking to the server directly.
 *
 * The rest of the product keeps its synchronous `Mailer.send()`: `deliver()`
 * enqueues and then waits for the long-lived worker in this process to record
 * the outcome, so the bookkeeping after a send still happens only for a send
 * that happened.
 */

import { createHash } from 'node:crypto';
import {
  EmailQueueError,
  PostgresEmailAuditStore,
  createSmtpTransport,
  emailQueueConfigProblems,
  getProviderHealth,
  handleUnsubscribe,
  mailJobId,
  queueEmail,
  queueIdentity,
  startEmailWorker,
  suppress,
  type DeliveryResult,
  type DeliveryTransport,
  type EmailAuditStore,
  type EmailJobStatus,
  type EmailKind,
  type EmailQueueOptions,
  type EmailSqlExecutor,
  type QueuedMessage,
  type SmtpTransportOptions,
} from '@profullstack/email-queue';
import { MailerError, type SendResult } from './mailer';

/** The only mailboxes OutreachGraph may send as. Never Resend, never another account. */
export const OUTREACH_MAILBOXES = ['cha0spunk@profullstack.com', 'knox@profullstack.com'] as const;

export const EMAIL_QUEUE_APPLICATION_ID = 'outreachgraph';

/** Cold outreach to one recipient domain, per mailbox, per 24 hours. */
export const DEFAULT_RECIPIENT_DOMAIN_CAP = 3;

/** How long `deliver()` waits for the worker before reporting the send as pending. */
const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_POLL_MS = 200;

/**
 * Attempts per stable key. A later attempt is made only when the audit proves
 * the earlier one never reached the provider or was definitely refused by it.
 */
const MAX_ATTEMPTS = 3;

/** States in which the provider has (or may have) the message: never send again. */
const ACCEPTED = new Set(['PROVIDER_ACCEPTED', 'SENT', 'DELIVERED', 'DELIVERY_DELAYED']);
/** Still on its way: wait for it rather than submitting another. */
const IN_FLIGHT = new Set(['CREATED', 'VALIDATED', 'QUEUED', 'DEFERRED', 'PROCESSING']);
/** The recipient said no, or does not exist: stop, whatever the key. */
const RECIPIENT_FINAL = new Set(['BOUNCED', 'COMPLAINED']);

/** The SMTP credential shape the queue needs (same as `SmtpCredentials`). */
export interface QueueMailbox {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string;
  readonly password: string;
  readonly fromEmail: string;
  readonly fromName?: string | undefined;
}

export interface OutreachEmailQueueConfig {
  readonly redisUrl: string;
  readonly encryptionKey: string;
  readonly auditStore: EmailAuditStore;
  /** Profullstack, Inc.'s postal address. Unset, every marketing send is refused. */
  readonly postalAddress?: string | undefined;
  readonly maxRecipientDomainPer24Hours?: number;
  /** Extra From addresses that may never send (EMAIL_QUEUE_BLOCKED_SENDERS is also read). */
  readonly blockedSenders?: readonly string[];
  readonly waitTimeoutMs?: number;
  readonly pollMs?: number;
  /** Tests inject a nodemailer stand-in; production loads nodemailer. */
  readonly createTransport?: SmtpTransportOptions['createTransport'];
}

export interface DeliverOptions {
  readonly kind: EmailKind;
  readonly idempotencyKey: string;
  readonly tenantId: string;
}

/** The stable, non-secret id of one mailbox credential. */
export function mailboxTransportId(mailbox: Pick<QueueMailbox, 'username'>): string {
  return `og-smtp:${mailbox.username.trim().toLowerCase()}`;
}

/**
 * The package's SMTP transport for one mailbox.
 *
 * Throws for a mailbox outside `OUTREACH_MAILBOXES`, and for one whose From
 * is not the authenticated login: the transport pins From to the login, so a
 * different `fromEmail` would silently send as somebody else.
 */
export function outreachTransport(
  mailbox: QueueMailbox,
  createTransport?: SmtpTransportOptions['createTransport'],
): DeliveryTransport & { verify(): Promise<void>; close(): void } {
  const user = mailbox.username.trim().toLowerCase();
  if (mailbox.fromEmail.trim().toLowerCase() !== user) {
    throw new MailerError(
      403,
      `the From address (${mailbox.fromEmail}) must be the authenticated mailbox (${mailbox.username})`,
      'SENDER_UNAUTHORIZED',
    );
  }
  try {
    return createSmtpTransport({
      id: mailboxTransportId(mailbox),
      host: mailbox.host,
      port: mailbox.port,
      secure: mailbox.secure,
      user: mailbox.username,
      pass: mailbox.password,
      ...(mailbox.fromName?.trim() ? { fromName: mailbox.fromName.trim() } : {}),
      authorizedSenders: [...OUTREACH_MAILBOXES],
      ...(createTransport ? { createTransport } : {}),
    });
  } catch (error) {
    throw new MailerError(
      403,
      `${error instanceof Error ? error.message : String(error)} OutreachGraph sends only as ${OUTREACH_MAILBOXES.join(' or ')}.`,
      'SENDER_UNAUTHORIZED',
    );
  }
}

/** HTTP-ish status for a queue refusal, chosen so the old text matchers never misread it. */
function statusForCode(code: string): number {
  switch (code) {
    case 'SENDER_PAUSED':
      return 423;
    case 'RECIPIENT_SUPPRESSED':
      return 409;
    case 'QUOTA_EXHAUSTED':
      return 429;
    case 'CONFIG_INVALID':
      return 503;
    case 'IDEMPOTENCY_KEY_REQUIRED':
      return 400;
    case 'SENDER_UNAUTHORIZED':
    case 'SENDER_BLOCKED':
      return 403;
    default:
      return code.startsWith('BULK_') ? 422 : 500;
  }
}

/** A queue refusal or a queue fault, as the error the rest of the product handles. */
export function queueFailure(error: unknown): MailerError {
  if (error instanceof MailerError) return error;
  if (error instanceof EmailQueueError) {
    return new MailerError(statusForCode(error.code), error.message, error.code);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new MailerError(
    503,
    `email queue unavailable: ${detail.slice(0, 300)}`,
    'QUEUE_UNAVAILABLE',
  );
}

function smtpStatusOf(text: string | undefined): number {
  const match = /SMTP (\d{3})/.exec(text ?? '');
  return match ? Number(match[1]) : 0;
}

interface WorkerEntry {
  readonly fingerprint: string;
  readonly transport: DeliveryTransport & { close(): void };
  readonly handle: Promise<{ close(): Promise<void> }>;
}

export class OutreachEmailQueue {
  readonly #config: OutreachEmailQueueConfig;
  readonly #workers = new Map<string, WorkerEntry>();
  #closed = false;

  constructor(config: OutreachEmailQueueConfig) {
    this.#config = config;
  }

  get postalAddress(): string | undefined {
    return this.#config.postalAddress?.trim() || undefined;
  }

  get auditStore(): EmailAuditStore {
    return this.#config.auditStore;
  }

  /** The options every call into the package shares, for one tenant. */
  options(tenantId?: string): EmailQueueOptions {
    const blocked = this.#config.blockedSenders ?? [];
    return {
      redisUrl: this.#config.redisUrl,
      encryptionKey: this.#config.encryptionKey,
      requireEncryption: true,
      applicationId: EMAIL_QUEUE_APPLICATION_ID,
      ...(tenantId ? { tenantId } : {}),
      auditStore: this.#config.auditStore,
      authorizedSenders: [...OUTREACH_MAILBOXES],
      ...(blocked.length ? { blockedSenders: [...blocked] } : {}),
      ...(this.postalAddress ? { postalAddress: this.postalAddress } : {}),
      maxRecipientDomainPer24Hours:
        this.#config.maxRecipientDomainPer24Hours ?? DEFAULT_RECIPIENT_DOMAIN_CAP,
    };
  }

  /**
   * The long-lived worker for this mailbox, started on first use.
   *
   * Mailbox passwords are sealed per workspace and only readable once its
   * owner unlocks, so a worker cannot be started at boot; it starts the first
   * time this process is asked to send from the mailbox and lives until
   * `close()` (SIGTERM). A changed password replaces the worker.
   */
  async worker(mailbox: QueueMailbox): Promise<DeliveryTransport> {
    if (this.#closed)
      throw new MailerError(503, 'the email queue is shutting down', 'CONFIG_INVALID');
    const id = mailboxTransportId(mailbox);
    const fingerprint = createHash('sha256')
      .update(
        [
          mailbox.host,
          mailbox.port,
          mailbox.secure,
          mailbox.username,
          mailbox.password,
          mailbox.fromName ?? '',
        ].join('\u0000'),
      )
      .digest('hex');

    const existing = this.#workers.get(id);
    if (existing?.fingerprint === fingerprint) {
      await existing.handle;
      return existing.transport;
    }
    if (existing) {
      this.#workers.delete(id);
      await (await existing.handle.catch(() => undefined))?.close().catch(() => undefined);
      existing.transport.close();
    }

    const transport = outreachTransport(mailbox, this.#config.createTransport);
    const handle = startEmailWorker(transport, this.options());
    const entry: WorkerEntry = { fingerprint, transport, handle };
    this.#workers.set(id, entry);
    try {
      await handle;
    } catch (error) {
      this.#workers.delete(id);
      transport.close();
      throw queueFailure(error);
    }
    return transport;
  }

  /**
   * Enqueues one message and waits for its outcome.
   *
   * Resolves with the provider's message id once the provider accepted it, or
   * with the earlier receipt when this key already went out. Rejects with a
   * `MailerError` carrying the queue's code otherwise.
   */
  async deliver(
    mailbox: QueueMailbox,
    message: QueuedMessage,
    options: DeliverOptions,
  ): Promise<SendResult> {
    const base = options.idempotencyKey.trim();
    if (!base) {
      throw new MailerError(
        400,
        'a stable idempotency key is required',
        'IDEMPOTENCY_KEY_REQUIRED',
      );
    }
    const transport = await this.worker(mailbox);
    const identity = queueIdentity(transport);
    const audit = this.#config.auditStore;

    // Find the attempt to make. The audit row for each attempt says whether
    // the provider has it (receipt), might have it (stop), never got it or
    // refused it (next attempt), or is still working on it (wait).
    let key = base;
    for (let attempt = 0; ; attempt += 1) {
      key = attempt === 0 ? base : `${base}:attempt-${attempt + 1}`;
      const id = mailJobId(identity, { ...message, idempotencyKey: key }, options.kind);
      const prior = await audit.get(id).catch((error: unknown) => {
        throw queueFailure(error);
      });
      const status = prior ? String(prior.status) : undefined;
      if (!status || IN_FLIGHT.has(status)) break;
      if (ACCEPTED.has(status)) {
        const providerId = prior?.provider_message_id;
        return typeof providerId === 'string' ? { id: providerId } : {};
      }
      if (status === 'UNKNOWN') {
        throw new MailerError(
          0,
          'an earlier attempt of this message may have reached the provider; it is not sent again. Check the mailbox before retrying by hand.',
          'DELIVERY_UNCERTAIN',
        );
      }
      if (RECIPIENT_FINAL.has(status)) {
        throw new MailerError(
          409,
          `the recipient ${status.toLowerCase()} an earlier attempt`,
          'RECIPIENT_SUPPRESSED',
        );
      }
      if (attempt + 1 >= MAX_ATTEMPTS) {
        const error = typeof prior?.error === 'string' ? prior.error : status;
        throw new MailerError(
          smtpStatusOf(error) || 500,
          `${MAX_ATTEMPTS} attempts of this message failed; not trying again (last: ${error})`,
          'ATTEMPTS_EXHAUSTED',
        );
      }
    }

    let job: EmailJobStatus;
    try {
      job = await queueEmail(transport, message, options.kind, {
        ...this.options(options.tenantId),
        auditStore: audit,
        applicationId: EMAIL_QUEUE_APPLICATION_ID,
        tenantId: options.tenantId,
        idempotencyKey: key,
      });
    } catch (error) {
      throw queueFailure(error);
    }

    const result = job.result ?? (await this.#waitFor(job.id));
    if (result.ok) return result.providerMessageId ? { id: result.providerMessageId } : {};
    throw await this.#refusal(transport, options.tenantId, result);
  }

  /** Polls the audit row until the worker records a final state. */
  async #waitFor(id: string): Promise<DeliveryResult> {
    const deadline = Date.now() + (this.#config.waitTimeoutMs ?? DEFAULT_WAIT_MS);
    const poll = this.#config.pollMs ?? DEFAULT_POLL_MS;
    for (;;) {
      const row = await this.#config.auditStore.get(id).catch(() => undefined);
      const state = row ? String(row.status) : 'CREATED';
      if (!IN_FLIGHT.has(state)) {
        const error = typeof row?.error === 'string' ? row.error : undefined;
        const providerMessageId =
          typeof row?.provider_message_id === 'string' ? row.provider_message_id : undefined;
        return {
          ok: ACCEPTED.has(state),
          state: state as DeliveryResult['state'],
          ...(providerMessageId ? { providerMessageId } : {}),
          ...(error ? { error } : {}),
          status: ACCEPTED.has(state) ? 250 : state === 'UNKNOWN' ? 0 : smtpStatusOf(error),
          ...(state === 'SUPPRESSED' && /suppressed/i.test(error ?? '')
            ? { code: 'RECIPIENT_SUPPRESSED' }
            : {}),
        };
      }
      if (Date.now() >= deadline) {
        throw new MailerError(
          202,
          'queued; the outcome was not recorded in time. The same key will return the receipt on the next attempt.',
          'PENDING',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
  }

  /** A failed result as a MailerError, with SENDER_PAUSED when the mailbox is now stopped. */
  async #refusal(
    transport: DeliveryTransport,
    tenantId: string,
    result: DeliveryResult,
  ): Promise<MailerError> {
    const detail = result.error ?? `the message ended ${result.state ?? 'FAILED'}`;
    const health = await getProviderHealth(transport, this.options(tenantId)).catch(
      () => undefined,
    );
    if (health && !health.available) {
      return new MailerError(
        423,
        `the provider stopped this mailbox (${health.pausedReason ?? 'paused'}): ${detail}`,
        'SENDER_PAUSED',
      );
    }
    if (result.state === 'UNKNOWN') {
      return new MailerError(0, detail, 'DELIVERY_UNCERTAIN');
    }
    const code = typeof result.code === 'string' ? result.code : undefined;
    return new MailerError(
      code ? statusForCode(code) : result.status || smtpStatusOf(detail) || 500,
      detail,
      code,
    );
  }

  /** Suppresses an address for every mailbox and kind (Redis and Postgres). */
  async suppress(address: string, reason: string, source: string): Promise<void> {
    await suppress(address, reason, source, {
      redisUrl: this.#config.redisUrl,
      auditStore: this.#config.auditStore,
    });
  }

  /** RFC 8058 one-click: the POSTed body must be `List-Unsubscribe=One-Click`. */
  async unsubscribeOneClick(
    token: string,
    body: string,
    resolveToken: (token: string) => Promise<string | undefined>,
  ): Promise<{ ok: boolean; code?: string }> {
    const result = await handleUnsubscribe(
      { type: 'one-click', token, body },
      { redisUrl: this.#config.redisUrl, auditStore: this.#config.auditStore, resolveToken },
    );
    return { ok: result.ok, ...(result.code ? { code: result.code } : {}) };
  }

  /** An unsubscribe request that arrived as mail (read over IMAP). */
  async unsubscribeMailto(from: string, subject?: string): Promise<{ ok: boolean }> {
    const result = await handleUnsubscribe(
      { type: 'mailto', from, ...(subject ? { subject } : {}) },
      { redisUrl: this.#config.redisUrl, auditStore: this.#config.auditStore },
    );
    return { ok: result.ok };
  }

  /** Stops every worker. Waiting jobs stay in Redis for the next process. */
  async close(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#workers.values()];
    this.#workers.clear();
    await Promise.all(
      entries.map(async (entry) => {
        await (await entry.handle.catch(() => undefined))?.close().catch(() => undefined);
        entry.transport.close();
      }),
    );
  }
}

// ------------------------------------------------------------ process-wide

let current: OutreachEmailQueue | undefined;

/** Installs (or, with undefined, removes) the queue every SMTP mailer sends through. */
export function configureOutreachEmailQueue(queue: OutreachEmailQueue | undefined): void {
  current = queue;
}

/** The configured queue, or undefined when outreach email is off. */
export function outreachEmailQueue(): OutreachEmailQueue | undefined {
  return current;
}

/**
 * Builds the queue from the environment, or explains why it cannot.
 *
 * Called once at startup. Every problem is returned (and logged by the
 * caller) so a missing variable shows up in the boot log, not as a refusal on
 * the first prospect. With problems the queue is not installed and every SMTP
 * send is refused: there is no direct-SMTP fallback for outreach.
 */
export async function startOutreachEmailQueue(input: {
  readonly env: Record<string, string | undefined>;
  /** A node-postgres pool on the app database; absent (SQLite) disables the queue. */
  readonly sql?: EmailSqlExecutor | undefined;
  readonly log?: (line: string) => void;
}): Promise<{ queue?: OutreachEmailQueue; problems: string[]; warnings: string[] }> {
  const { env } = input;
  const log = input.log ?? ((line: string) => console.log(line));
  const problems = emailQueueConfigProblems({}, env);
  if (!input.sql) {
    problems.push(
      'no PostgreSQL database: the email audit store (PostgresEmailAuditStore) needs one.',
    );
  }

  const warnings: string[] = [];
  const postalAddress = env.OUTREACH_POSTAL_ADDRESS?.trim() || undefined;
  if (!postalAddress) {
    warnings.push(
      'OUTREACH_POSTAL_ADDRESS is not set: every outreach (marketing) email is refused until it is.',
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) log(`email-queue: ${problem}`);
    log('email-queue: outreach email is OFF; SMTP sends are refused, never sent directly.');
    configureOutreachEmailQueue(undefined);
    return { problems, warnings };
  }

  const auditStore = new PostgresEmailAuditStore(input.sql!);
  try {
    await auditStore.migrate();
  } catch (error) {
    const problem = `audit store migration failed: ${error instanceof Error ? error.message : String(error)}`;
    log(`email-queue: ${problem}`);
    log('email-queue: outreach email is OFF; SMTP sends are refused, never sent directly.');
    configureOutreachEmailQueue(undefined);
    return { problems: [problem], warnings };
  }

  const cap = Number(env.OUTREACH_MAX_PER_RECIPIENT_DOMAIN_PER_DAY);
  const queue = new OutreachEmailQueue({
    redisUrl: env.EMAIL_QUEUE_REDIS_URL!.trim(),
    encryptionKey: env.EMAIL_QUEUE_ENCRYPTION_KEY!,
    auditStore,
    ...(postalAddress ? { postalAddress } : {}),
    maxRecipientDomainPer24Hours:
      Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_RECIPIENT_DOMAIN_CAP,
  });
  for (const warning of warnings) log(`email-queue: ${warning}`);
  log(
    `email-queue: on (mailboxes ${OUTREACH_MAILBOXES.join(', ')}; ` +
      `${queue.options().maxRecipientDomainPer24Hours}/recipient domain/day)`,
  );
  configureOutreachEmailQueue(queue);
  return { queue, problems: [], warnings };
}
