/**
 * Pushing the people who matter into the customer's CRM (PRD §28).
 *
 * Stored like every other credential: an `integrations` row with kind `crm`
 * holds what is safe to show (which CRM, when it last synced, the last error),
 * and an `integration_accounts` row holds the token, encrypted with
 * `SECRET_ENCRYPTION_KEY`. Disconnecting deletes the token rather than
 * flagging it — see `email-account.ts` for why a revoked credential must not
 * stay readable.
 *
 * Triggered only through `emitWebhookEvent`, on the two events in
 * `CRM_TRIGGER_EVENTS`. There is no second path into a CRM, so there is no
 * second place to forget a suppression or leak a person from another
 * workspace.
 */

import { newId, type CrmProvider, type OutboundEvent, CRM_PROVIDERS } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  crmClientFor,
  CrmError,
  type CrmClient,
  type CrmClientOptions,
  type FetchLike,
} from '@outreachgraph/providers';
import { decryptSecret, encryptSecret, SecretDecryptError } from '@outreachgraph/secrets';
import type { QueuedJob } from './queue';
import { eventPerson } from './webhooks';

const KIND = 'crm';

export class CrmAccountError extends Error {
  readonly code: 'not_configured' | 'verification_failed';
  constructor(code: CrmAccountError['code'], message: string) {
    super(message);
    this.name = 'CrmAccountError';
    this.code = code;
  }
}

/** What a settings page may see. Never the token. */
export interface CrmConnectionSummary {
  readonly provider: CrmProvider;
  readonly connected: boolean;
  readonly status?: string;
  readonly connectedAt?: string;
  readonly lastSyncAt?: string;
  readonly lastError?: string;
}

/** Injected by tests, so no request leaves the process. */
export type CrmClientFactory = (provider: CrmProvider, options: CrmClientOptions) => CrmClient;

function parseConfig(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Verifies the token against the CRM, then stores it.
 *
 * Verify first for the reason `connectEmailAccount` does: a token that cannot
 * read contacts is not a connection, and finding that out on the first reply
 * means the one event worth syncing is the one that fails.
 */
export async function connectCrm(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly provider: CrmProvider;
    readonly token: string;
    readonly encryptionKey: Buffer | undefined;
    readonly verify?: boolean;
    readonly fetchImpl?: FetchLike;
    readonly clientFor?: CrmClientFactory;
  },
): Promise<CrmConnectionSummary> {
  if (!input.encryptionKey) {
    throw new CrmAccountError(
      'not_configured',
      'SECRET_ENCRYPTION_KEY is not set, so a CRM token cannot be stored safely.',
    );
  }

  const token = input.token.trim();

  if (input.verify !== false) {
    const client = (input.clientFor ?? crmClientFor)(input.provider, {
      token,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    try {
      await client.verify();
    } catch (error) {
      throw new CrmAccountError(
        'verification_failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const stamp = now();
  const existing = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM integrations WHERE workspace_id = ? AND kind = ? AND network = ?',
    [input.workspaceId, KIND, input.provider],
  );
  const integrationId = existing?.id ?? newId('integration');

  if (existing) {
    await db.execute({
      sql: `UPDATE integrations SET status = 'connected', config_json = '{}', updated_at = ?
             WHERE id = ?`,
      args: [stamp, integrationId],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO integrations (id, workspace_id, kind, network, status, config_json,
            created_at, updated_at)
            VALUES (?, ?, ?, ?, 'connected', '{}', ?, ?)`,
      args: [integrationId, input.workspaceId, KIND, input.provider, stamp, stamp],
    });
  }

  await db.execute({
    sql: 'DELETE FROM integration_accounts WHERE workspace_id = ? AND network = ?',
    args: [input.workspaceId, input.provider],
  });

  await db.execute({
    sql: `INSERT INTO integration_accounts (id, integration_id, workspace_id, network,
          access_token_enc, scopes, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, '["contacts","notes"]', 'active', ?, ?)`,
    args: [
      newId('integrationAccount'),
      integrationId,
      input.workspaceId,
      input.provider,
      encryptSecret(token, input.encryptionKey),
      stamp,
      stamp,
    ],
  });

  return { provider: input.provider, connected: true, status: 'active', connectedAt: stamp };
}

export async function disconnectCrm(
  db: Client,
  workspaceId: string,
  provider: CrmProvider,
): Promise<boolean> {
  const removed = await db.execute({
    sql: 'DELETE FROM integration_accounts WHERE workspace_id = ? AND network = ?',
    args: [workspaceId, provider],
  });
  await db.execute({
    sql: `UPDATE integrations SET status = 'disconnected', updated_at = ?
           WHERE workspace_id = ? AND kind = ? AND network = ?`,
    args: [now(), workspaceId, KIND, provider],
  });
  return Number(removed.rowsAffected ?? 0) > 0;
}

/** Every supported CRM, connected or not, so the page can offer the rest. */
export async function crmStatus(db: Client, workspaceId: string): Promise<CrmConnectionSummary[]> {
  const rows = await queryAll<{
    network: string;
    config_json: string;
    account_status: string | null;
    account_created: string | null;
  }>(
    db,
    `SELECT i.network, i.config_json, ia.status AS account_status, ia.created_at AS account_created
       FROM integrations i
       LEFT JOIN integration_accounts ia ON ia.integration_id = i.id
      WHERE i.workspace_id = ? AND i.kind = ?`,
    [workspaceId, KIND],
  );

  return CRM_PROVIDERS.map((provider) => {
    const row = rows.find((r) => r.network === provider);
    if (!row?.account_status) return { provider, connected: false };
    const config = parseConfig(row.config_json);
    return {
      provider,
      connected: row.account_status === 'active',
      status: row.account_status,
      ...(row.account_created ? { connectedAt: row.account_created } : {}),
      ...(typeof config.lastSyncAt === 'string' ? { lastSyncAt: config.lastSyncAt } : {}),
      ...(typeof config.lastError === 'string' ? { lastError: config.lastError } : {}),
    };
  });
}

async function loadToken(
  db: Client,
  workspaceId: string,
  provider: CrmProvider,
  key: Buffer,
): Promise<string | undefined> {
  const row = await queryOne<{ access_token_enc: string | null; status: string }>(
    db,
    `SELECT ia.access_token_enc, ia.status FROM integration_accounts ia
       JOIN integrations i ON i.id = ia.integration_id
      WHERE ia.workspace_id = ? AND ia.network = ? AND i.kind = ?`,
    [workspaceId, provider, KIND],
  );
  if (!row || row.status !== 'active' || !row.access_token_enc) return undefined;
  try {
    return decryptSecret(row.access_token_enc, key);
  } catch (error) {
    if (error instanceof SecretDecryptError) return undefined;
    throw error;
  }
}

async function noteOutcome(
  db: Client,
  workspaceId: string,
  provider: CrmProvider,
  error: string | undefined,
): Promise<void> {
  const stamp = now();
  await db.execute({
    sql: `UPDATE integrations
             SET config_json = json_set(COALESCE(config_json, '{}'),
                   '$.lastSyncAt', ?, '$.lastError', ?),
                 updated_at = ?
           WHERE workspace_id = ? AND kind = ? AND network = ?`,
    args: [stamp, error ?? null, stamp, workspaceId, KIND, provider],
  });
}

/** The note written against the contact. Plain text: both CRMs render it as-is. */
export function crmNoteFor(event: OutboundEvent): string {
  const data = event.data as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof data[key] === 'string' && (data[key] as string).trim()
      ? (data[key] as string).trim()
      : undefined;
  const person = event.data.person;
  const role = person ? [person.title, person.company].filter(Boolean).join(', ') : '';

  const lines: string[] = [];
  if (event.type === 'reply.received') {
    lines.push(`Replied by ${text('network') ?? 'email'} (via OutreachGraph).`);
    const subject = text('subject');
    if (subject) lines.push(`Subject: ${subject}`);
    const body = text('body');
    if (body) lines.push('', body.slice(0, 2000));
  } else if (event.type === 'recommendation.approved') {
    const action = (text('action') ?? 'outreach').replace(/_/g, ' ');
    lines.push(
      `Outreach approved in OutreachGraph: ${action} on ${text('network') ?? 'a channel'}.`,
    );
  } else {
    lines.push(`OutreachGraph: ${event.type}.`);
  }
  if (role) lines.push('', role);
  return lines.join('\n');
}

export interface CrmSyncDeps {
  readonly db: Client;
  readonly encryptionKey?: Buffer | undefined;
  readonly fetchImpl?: FetchLike;
  readonly clientFor?: CrmClientFactory;
}

export interface CrmSyncResult {
  readonly outcome: 'synced' | 'skipped' | 'no_email' | 'not_connected' | 'failed';
  readonly contactId?: string;
  readonly created?: boolean;
  readonly error?: string;
}

/**
 * Runs one `sync_crm` job: make sure the person exists, then write a note.
 *
 * A person with no personal address is skipped rather than failed. That is
 * the majority case for a crawl-found prospect, and "no email" is not
 * something a retry can fix.
 */
export async function runCrmSync(
  deps: CrmSyncDeps,
  job: Pick<QueuedJob, 'payload' | 'workspaceId' | 'attempts' | 'maxAttempts'>,
): Promise<CrmSyncResult> {
  const { db } = deps;
  const provider = job.payload.provider as CrmProvider;
  const event = job.payload.event as OutboundEvent | undefined;

  if (!(CRM_PROVIDERS as readonly string[]).includes(provider) || !event) {
    return { outcome: 'failed', error: 'malformed sync job' };
  }
  if (!deps.encryptionKey) return { outcome: 'not_connected', error: 'no encryption key' };

  // Approving research is not a conversation starting. The CRM hears about
  // approvals that put words in front of a person, and nothing else.
  if (event.type === 'recommendation.approved' && event.data.outbound === false) {
    return { outcome: 'skipped' };
  }

  const token = await loadToken(db, job.workspaceId, provider, deps.encryptionKey);
  if (!token) return { outcome: 'not_connected' };

  const personId =
    event.data.person?.id ??
    (typeof event.data.personId === 'string' ? event.data.personId : undefined);
  // Re-read rather than trusting the envelope: an address confirmed between
  // the event and this job is one we should use.
  const person = personId ? await eventPerson(db, personId) : undefined;
  if (!person?.email) return { outcome: 'no_email' };

  const client = (deps.clientFor ?? crmClientFor)(provider, {
    token,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  try {
    const contact = await client.ensureContact({
      email: person.email,
      name: person.name,
      ...(person.firstName ? { firstName: person.firstName } : {}),
      ...(person.lastName ? { lastName: person.lastName } : {}),
      ...(person.title ? { title: person.title } : {}),
      ...(person.company ? { company: person.company } : {}),
      ...(person.companyDomain ? { website: `https://${person.companyDomain}` } : {}),
    });
    await client.addNote(contact.id, crmNoteFor(event), new Date(event.createdAt));
    await noteOutcome(db, job.workspaceId, provider, undefined);
    return { outcome: 'synced', contactId: contact.id, created: contact.created };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await noteOutcome(db, job.workspaceId, provider, message.slice(0, 500));

    if (error instanceof CrmError && !error.retryable) {
      // A refused token stops future syncs until someone reconnects, rather
      // than failing every reply from now on.
      if (error.status === 401 || error.status === 403) {
        await db.execute({
          sql: `UPDATE integration_accounts SET status = 'revoked', updated_at = ?
                 WHERE workspace_id = ? AND network = ?`,
          args: [now(), job.workspaceId, provider],
        });
      }
      return { outcome: 'failed', error: message };
    }

    // Worth another try: the queue backs off and comes back.
    throw error;
  }
}
