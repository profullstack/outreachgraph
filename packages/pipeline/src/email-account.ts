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
 * This is the write side. A workspace connects one sending mailbox; the
 * password is verified against the real server before it is stored, encrypted
 * with `SECRET_ENCRYPTION_KEY`, and decrypted only to build a transport.
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
import { SmtpMailer, type Mailer, type SmtpCredentials } from '@outreachgraph/email';
import { decryptSecret, encryptSecret, SecretDecryptError } from '@outreachgraph/secrets';

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
  readonly status?: string;
  readonly connectedAt?: string;
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
  };

  const stamp = now();
  const existing = await loadRow(db, input.workspaceId);
  const integrationId = existing?.integration_id ?? newId('integration');

  if (existing) {
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

  // Replaced rather than updated: a reconnection is a new credential, and
  // leaving the old ciphertext behind would keep a revoked password readable.
  await db.execute({
    sql: `DELETE FROM integration_accounts WHERE workspace_id = ? AND network = ?`,
    args: [input.workspaceId, NETWORK],
  });

  await db.execute({
    sql: `INSERT INTO integration_accounts (id, integration_id, workspace_id, network,
          external_account_id, handle, access_token_enc, scopes, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '["send"]', 'active', ?, ?)`,
    args: [
      newId('integrationAccount'),
      integrationId,
      input.workspaceId,
      NETWORK,
      input.account.username,
      input.account.fromEmail,
      encryptSecret(input.account.password, input.encryptionKey),
      stamp,
      stamp,
    ],
  });

  return {
    connected: true,
    ...config,
    status: 'active',
    connectedAt: stamp,
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

  return {
    connected: row.status === 'active',
    ...config,
    status: row.status,
    connectedAt: row.created_at,
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
): Promise<(SmtpCredentials & { readonly replyTo?: string }) | undefined> {
  if (!encryptionKey) return undefined;

  const row = await loadRow(db, workspaceId);
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

async function loadRow(db: Client, workspaceId: string): Promise<AccountRow | undefined> {
  const row = await queryOne<AccountRow>(
    db,
    `SELECT i.id AS integration_id, ia.id AS account_id, i.config_json,
            ia.access_token_enc, ia.status, ia.created_at
       FROM integrations i
       JOIN integration_accounts ia ON ia.integration_id = i.id
      WHERE i.workspace_id = ? AND i.kind = ? AND i.network = ?
      LIMIT 1`,
    [workspaceId, KIND, NETWORK],
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
    };
  } catch {
    return undefined;
  }
}
