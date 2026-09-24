/**
 * The customer's own mailbox, connected (PRD §16.2, §34).
 *
 * `integration_accounts` has existed since the first migration and nothing
 * ever wrote a row to it. That single fact was the whole bug: the policy
 * engine asks `hasConnectedAccount` before it will let an outbound action
 * through, the answer was read from a table that could not be populated, and
 * so every email recommendation came back `manual_only` with "No connected
 * email account, so this must be done manually." The product drafted messages
 * it had already decided it could never send.
 *
 * This is the write side. A workspace connects one or more sending mailboxes
 * (a pool, see `sender-pool.ts`); each password is verified against the real
 * server before it is stored, encrypted with `SECRET_ENCRYPTION_KEY`, and
 * decrypted only to build a transport.
 *
 * Two rows, because the schema separates them and the separation is useful:
 *
 *   - `integrations` holds the configuration — host, port, addresses. Not
 *     secret, and safe to show back to the person who typed it.
 *   - `integration_accounts` holds the credential and the `status` the policy
 *     engine reads. Revoking is a status change on this row, which is what
 *     makes disconnecting take effect on the next policy check rather than at
 *     the next send.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import {
  SmtpMailer,
  type ImapCredentials,
  type Mailer,
  type SmtpCredentials,
} from '@outreachgraph/email';
import { decryptSecret, encryptSecret, SecretDecryptError } from '@outreachgraph/secrets';
import { chooseSender, describeDeferral, upsertPoolAccount } from './sender-pool';

/** The kind recorded on the `integrations` row. */
const KIND = 'smtp';
const NETWORK = 'email';

export interface EmailAccountInput {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string;
  readonly password: string;
  readonly fromEmail: string;
  readonly fromName?: string | undefined;
  /** Where replies go, when that is not the sending address. */
  readonly replyTo?: string | undefined;
  /**
   * Where the same mailbox is read from, when the workspace wants replies
   * noticed.
   *
   * Optional, and its absence is a real configuration rather than an
   * incomplete one: a workspace may legitimately want to send and handle
   * replies by hand. What it costs is that nothing can notice an answer, so
   * the `conversation_open` gate has no input and the queue keeps offering a
   * prospect who has already written back.
   *
   * There is no second password. IMAP and SMTP are two ports on one mailbox,
   * and asking for the credential twice would only create a way for them to
   * disagree.
   */
  readonly imapHost?: string | undefined;
  readonly imapPort?: number | undefined;
  readonly imapSecure?: boolean | undefined;
}

/** What the settings page may see. Never includes the password. */
export interface EmailAccountSummary {
  readonly connected: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly secure?: boolean;
  readonly username?: string;
  readonly fromEmail?: string;
  readonly fromName?: string;
  readonly replyTo?: string;
  readonly imapHost?: string;
  readonly imapPort?: number;
  readonly imapSecure?: boolean;
  readonly status?: string;
  readonly connectedAt?: string;
  /** The pool account this describes. */
  readonly accountId?: string;
  /** How many mailboxes the workspace has connected in all. */
  readonly accounts?: number;
}

export class EmailAccountError extends Error {
  readonly code: 'not_configured' | 'verification_failed' | 'unreadable';

  constructor(code: EmailAccountError['code'], message: string) {
    super(message);
    this.name = 'EmailAccountError';
    this.code = code;
  }
}

interface StoredConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string;
  readonly fromEmail: string;
  readonly fromName?: string;
  readonly replyTo?: string;
  readonly imapHost?: string;
  readonly imapPort?: number;
  readonly imapSecure?: boolean;
}

interface AccountRow {
  readonly integration_id: string;
  readonly account_id: string;
  readonly config_json: string;
  readonly access_token_enc: string | null;
  readonly status: string;
  readonly created_at: string;
}

/**
 * Verifies the credentials, then stores them.
 *
 * The order is the point. A password that cannot log in is not a connection,
 * and storing it first would leave a workspace that passes the policy gate and
 * fails on a real prospect — the one moment where a failure costs a lead
 * rather than a retry. `verify: false` exists for tests, which have no server
 * to talk to.
 */
export async function connectEmailAccount(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly account: EmailAccountInput;
    readonly encryptionKey: Buffer | undefined;
    readonly verify?: boolean;
    /** Injected by tests so no socket is opened. */
    readonly mailerFor?: (credentials: SmtpCredentials) => { verify(): Promise<void> };
  },
): Promise<EmailAccountSummary> {
  if (!input.encryptionKey) {
    throw new EmailAccountError(
      'not_configured',
      'SECRET_ENCRYPTION_KEY is not set, so a mailbox password cannot be stored safely.',
    );
  }

  const credentials: SmtpCredentials = {
    host: input.account.host,
    port: input.account.port,
    secure: input.account.secure,
    username: input.account.username,
    password: input.account.password,
    fromEmail: input.account.fromEmail,
    ...(input.account.fromName ? { fromName: input.account.fromName } : {}),
  };

  if (input.verify !== false) {
    const mailer = input.mailerFor?.(credentials) ?? new SmtpMailer(credentials);
    try {
      await mailer.verify();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new EmailAccountError('verification_failed', detail);
    } finally {
      if (mailer instanceof SmtpMailer) mailer.close();
    }
  }

  const config: StoredConfig = {
    host: input.account.host,
    port: input.account.port,
    secure: input.account.secure,
    username: input.account.username,
    fromEmail: input.account.fromEmail,
    ...(input.account.fromName ? { fromName: input.account.fromName } : {}),
    ...(input.account.replyTo ? { replyTo: input.account.replyTo } : {}),
    // Only stored as a pair. A host with no port is not a mailbox anyone can
    // read, and half-configured reading fails on a timer rather than here.
    ...(input.account.imapHost
      ? {
          imapHost: input.account.imapHost,
          imapPort: input.account.imapPort ?? 993,
          imapSecure: input.account.imapSecure ?? true,
        }
      : {}),
  };

  const stamp = now();
  const integration = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM integrations WHERE workspace_id = ? AND kind = ? AND network = ?`,
    [input.workspaceId, KIND, NETWORK],
  );
  const integrationId = integration?.id ?? newId('integration');

  // The integration row still carries the most recent configuration, for
  // anything that reads it; each mailbox's own lives on its account row.
  if (integration) {
    await db.execute({
      sql: `UPDATE integrations SET status = 'connected', config_json = ?, updated_at = ?
             WHERE id = ?`,
      args: [JSON.stringify(config), stamp, integrationId],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO integrations (id, workspace_id, kind, network, status, config_json,
            created_at, updated_at)
            VALUES (?, ?, ?, ?, 'connected', ?, ?, ?)`,
      args: [integrationId, input.workspaceId, KIND, NETWORK, JSON.stringify(config), stamp, stamp],
    });
  }

  // Added to the pool, or refreshed when this login is already in it. The
  // credential itself is always replaced: a reconnection is a new password,
  // and leaving the old ciphertext behind would keep a revoked one readable.
  const account = await upsertPoolAccount(db, {
    workspaceId: input.workspaceId,
    integrationId,
    network: NETWORK,
    identity: input.account.username,
    handle: input.account.fromEmail,
    accessTokenEnc: encryptSecret(input.account.password, input.encryptionKey),
    scopes: '["send"]',
    configJson: JSON.stringify(config),
  });

  return {
    connected: true,
    ...config,
    status: 'active',
    connectedAt: stamp,
    accountId: account.id,
  };
}

/** What the settings page shows. Safe to serialise straight to the client. */
export async function emailAccountSummary(
  db: Client,
  workspaceId: string,
): Promise<EmailAccountSummary> {
  const row = await loadRow(db, workspaceId);
  if (!row) return { connected: false };

  const config = parseConfig(row.config_json);
  if (!config) return { connected: false };

  const count = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM integration_accounts WHERE workspace_id = ? AND network = ?`,
    [workspaceId, NETWORK],
  );

  return {
    connected: row.status === 'active',
    ...config,
    status: row.status,
    connectedAt: row.created_at,
    accountId: row.account_id,
    accounts: Number(count?.n ?? 1),
  };
}

/**
 * The credentials, decrypted, or `undefined` when none are usable.
 *
 * A row that cannot be decrypted is treated as no account rather than as an
 * error: it means the encryption key changed, and the honest outcome is that
 * the workspace is disconnected until someone reconnects it. Throwing here
 * would take down every send in the workspace instead.
 */
export async function loadEmailCredentials(
  db: Client,
  workspaceId: string,
  encryptionKey: Buffer | undefined,
  /** One mailbox in the pool. Omitted, the workspace's first active one. */
  accountId?: string,
): Promise<(SmtpCredentials & { readonly replyTo?: string }) | undefined> {
  if (!encryptionKey) return undefined;

  const row = await loadRow(db, workspaceId, accountId);
  if (!row || row.status !== 'active' || !row.access_token_enc) return undefined;

  const config = parseConfig(row.config_json);
  if (!config) return undefined;

  let password: string;
  try {
    password = decryptSecret(row.access_token_enc, encryptionKey);
  } catch (error) {
    if (error instanceof SecretDecryptError) return undefined;
    throw error;
  }

  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    username: config.username,
    password,
    fromEmail: config.fromEmail,
    ...(config.fromName ? { fromName: config.fromName } : {}),
    ...(config.replyTo ? { replyTo: config.replyTo } : {}),
  };
}

/**
 * The credentials for *reading* this workspace's mailbox, or `undefined`.
 *
 * Undefined has three distinct causes and they are deliberately collapsed: no
 * mailbox connected, no IMAP host configured, or a password that no longer
 * decrypts. All three mean the same thing to the caller — this workspace's
 * replies cannot be read right now — and none of them is an error worth
 * failing a polling tick over.
 */
export async function loadImapCredentials(
  db: Client,
  workspaceId: string,
  encryptionKey: Buffer | undefined,
  /** One mailbox in the pool. Omitted, the workspace's first active one. */
  accountId?: string,
): Promise<ImapCredentials | undefined> {
  if (!encryptionKey) return undefined;

  const row = await loadRow(db, workspaceId, accountId);
  if (!row || row.status !== 'active' || !row.access_token_enc) return undefined;

  const config = parseConfig(row.config_json);
  if (!config?.imapHost) return undefined;

  let password: string;
  try {
    password = decryptSecret(row.access_token_enc, encryptionKey);
  } catch (error) {
    if (error instanceof SecretDecryptError) return undefined;
    throw error;
  }

  return {
    host: config.imapHost,
    port: config.imapPort ?? 993,
    secure: config.imapSecure ?? true,
    // The same mailbox, so the same login. Storing a second copy would only
    // create a way for the two to drift apart.
    username: config.username,
    password,
  };
}

/**
 * The mailer outreach for this workspace should go through.
 *
 * The customer's own mailbox when they have connected one, and the platform
 * sender otherwise. Both are real answers: a connected mailbox is what the
 * capability matrix means by `customer_managed`, and the platform sender is
 * what a workspace that has not connected anything falls back to so that
 * autopilot keeps working exactly as it did.
 */
export async function mailerForWorkspace(
  db: Client,
  workspaceId: string,
  options: {
    readonly encryptionKey: Buffer | undefined;
    readonly fallback?: Mailer | undefined;
  },
): Promise<{ mailer: Mailer; ownMailbox: boolean; replyTo?: string } | undefined> {
  const credentials = await loadEmailCredentials(db, workspaceId, options.encryptionKey);

  if (credentials) {
    return {
      mailer: new SmtpMailer(credentials),
      ownMailbox: true,
      ...(credentials.replyTo ? { replyTo: credentials.replyTo } : {}),
    };
  }

  if (options.fallback) return { mailer: options.fallback, ownMailbox: false };
  return undefined;
}

/** What `mailerForSend` hands back. */
export type SendingMailbox =
  | {
      readonly kind: 'ready';
      readonly mailer: Mailer;
      readonly ownMailbox: boolean;
      readonly replyTo?: string;
      /** The pool account chosen. Absent for the platform sender. */
      readonly accountId?: string;
    }
  /** Every mailbox that could send this is at today's cap. Try `retryAt`. */
  | {
      readonly kind: 'deferred';
      readonly reason: string;
      /** `all_capped` means no mailbox has room for anyone, not just this person. */
      readonly code: 'all_capped' | 'continuity_capped' | 'continuity_paused';
      readonly retryAt: string;
    }
  /** Nothing can send: no active mailbox and no platform sender. */
  | { readonly kind: 'none' };

/**
 * The mailbox one message to this person should leave from.
 *
 * `mailerForWorkspace` answered "the workspace's mailbox"; with a pool the
 * answer depends on who the message is for — the mailbox already talking to
 * them, else the one with the most room today — and can be "not today". The
 * fallbacks are the ones it always had: with no active mailbox at all, the
 * platform sender; with a mailbox whose password no longer decrypts, the same.
 * What is new is `deferred`, which never falls back: a full pool waits for
 * tomorrow rather than spilling onto a sender the caps were meant to protect.
 */
export async function mailerForSend(
  db: Client,
  workspaceId: string,
  options: {
    readonly encryptionKey: Buffer | undefined;
    readonly fallback?: Mailer | undefined;
    readonly personId?: string | undefined;
    readonly at?: Date;
    /** Injected by tests so no socket is opened. */
    readonly mailerFor?: (credentials: SmtpCredentials) => Mailer;
  },
): Promise<SendingMailbox> {
  const platform = (): SendingMailbox =>
    options.fallback
      ? { kind: 'ready', mailer: options.fallback, ownMailbox: false }
      : { kind: 'none' };

  // No key means no mailbox can be read, which is the same as having none.
  if (!options.encryptionKey) return platform();

  const selection = await chooseSender(db, {
    workspaceId,
    network: NETWORK,
    personId: options.personId,
    ...(options.at ? { at: options.at } : {}),
  });

  if (selection.choice.kind === 'deferred') {
    return {
      kind: 'deferred',
      reason: describeDeferral(selection.choice),
      code: selection.choice.reason,
      retryAt: selection.retryAt!,
    };
  }
  if (!selection.account) return platform();

  const credentials = await loadEmailCredentials(
    db,
    workspaceId,
    options.encryptionKey,
    selection.account.id,
  );
  if (!credentials) return platform();

  return {
    kind: 'ready',
    mailer: options.mailerFor?.(credentials) ?? new SmtpMailer(credentials),
    ownMailbox: true,
    accountId: selection.account.id,
    ...(credentials.replyTo ? { replyTo: credentials.replyTo } : {}),
  };
}

/**
 * Revokes the account.
 *
 * The rows are deleted rather than flagged: the credential is the thing being
 * revoked, and keeping its ciphertext around after the customer has asked us
 * to forget it serves nobody. The configuration goes with it so a later
 * reconnection starts from an empty form rather than a half-remembered one.
 */
export async function disconnectEmailAccount(db: Client, workspaceId: string): Promise<boolean> {
  const row = await loadRow(db, workspaceId);
  if (!row) return false;

  // Every mailbox in the pool: this is "disconnect email", not "remove one
  // sender", which `removeSender` does.

  await db.execute({
    sql: `DELETE FROM integration_accounts WHERE workspace_id = ? AND network = ?`,
    args: [workspaceId, NETWORK],
  });

  await db.execute({
    sql: 'DELETE FROM integrations WHERE id = ?',
    args: [row.integration_id],
  });

  return true;
}

/**
 * One mailbox's row: the one asked for, or the workspace's first active one.
 *
 * "First active, oldest first" is what makes a pool of one read exactly as the
 * single mailbox did, and what a caller that has not been taught about pools
 * yet — the settings summary — sensibly shows. The account's own configuration
 * wins over the integration's, which only ever described one mailbox.
 */
async function loadRow(
  db: Client,
  workspaceId: string,
  accountId?: string,
): Promise<AccountRow | undefined> {
  const row = await queryOne<AccountRow>(
    db,
    `SELECT i.id AS integration_id, ia.id AS account_id,
            COALESCE(ia.config_json, i.config_json) AS config_json,
            ia.access_token_enc, ia.status, ia.created_at
       FROM integrations i
       JOIN integration_accounts ia ON ia.integration_id = i.id
      WHERE i.workspace_id = ? AND i.kind = ? AND i.network = ?
        ${accountId ? 'AND ia.id = ?' : ''}
      ORDER BY (ia.status = 'active') DESC, ia.created_at ASC, ia.id ASC
      LIMIT 1`,
    accountId ? [workspaceId, KIND, NETWORK, accountId] : [workspaceId, KIND, NETWORK],
  );

  return row ?? undefined;
}

function parseConfig(raw: string): StoredConfig | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;

    const config = parsed as Partial<StoredConfig>;
    if (
      typeof config.host !== 'string' ||
      typeof config.port !== 'number' ||
      typeof config.username !== 'string' ||
      typeof config.fromEmail !== 'string'
    ) {
      return undefined;
    }

    return {
      host: config.host,
      port: config.port,
      secure: config.secure === true,
      username: config.username,
      fromEmail: config.fromEmail,
      ...(config.fromName ? { fromName: config.fromName } : {}),
      ...(config.replyTo ? { replyTo: config.replyTo } : {}),
      // Kept, not dropped: without these `loadImapCredentials` never found an
      // IMAP host on a stored mailbox, so replies (and now bounces) were
      // never read from any of them.
      ...(typeof config.imapHost === 'string' && config.imapHost
        ? {
            imapHost: config.imapHost,
            imapPort: typeof config.imapPort === 'number' ? config.imapPort : 993,
            imapSecure: config.imapSecure !== false,
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}
