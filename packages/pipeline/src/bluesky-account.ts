/**
 * Connecting a workspace's Bluesky account.
 *
 * Mirrors `email-account.ts` deliberately, down to the table layout: the
 * policy engine asks one question — "does this workspace have a usable
 * connected account for this network" — and it must get the same answer
 * whichever network is being asked about. A second shape for social
 * credentials would be a second place for that answer to drift.
 *
 * The credential is an **app password**, never the account password. Bluesky
 * issues them individually and revokes them individually, so disconnecting us
 * never means a customer changing the password they log in with.
 *
 * As with SMTP, the password is authenticated against the real service before
 * anything is stored, so a saved account is by construction a working one.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import { BlueskyAgent, BlueskyAuthError } from '@outreachgraph/providers';
import { decryptSecret, encryptSecret } from '@outreachgraph/secrets';

const KIND = 'social';
const NETWORK = 'bluesky';

export class BlueskyAccountError extends Error {
  readonly code: 'verification_failed' | 'not_connected' | 'no_key';
  constructor(code: BlueskyAccountError['code'], message: string) {
    super(message);
    this.name = 'BlueskyAccountError';
    this.code = code;
  }
}

export interface ConnectBlueskyInput {
  readonly workspaceId: string;
  /** Handle or email the account signs in with. */
  readonly identifier: string;
  readonly appPassword: string;
  readonly encryptionKey: Buffer;
  /** Skips the live check. Only for tests that have no network. */
  readonly verify?: boolean;
  readonly agent?: BlueskyAgent;
}

export interface BlueskyAccountSummary {
  readonly connected: boolean;
  readonly handle?: string;
  readonly did?: string;
  readonly connectedAt?: string;
}

export async function connectBlueskyAccount(
  db: Client,
  input: ConnectBlueskyInput,
): Promise<BlueskyAccountSummary> {
  const agent = input.agent ?? new BlueskyAgent();

  let did = '';
  let handle = input.identifier.replace(/^@/, '');

  if (input.verify !== false) {
    try {
      const session = await agent.login(input.identifier, input.appPassword);
      did = session.did;
      handle = session.handle;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BlueskyAccountError('verification_failed', detail);
    }
  }

  const stamp = now();
  const config = { handle, did };

  const existing = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM integrations WHERE workspace_id = ? AND kind = ? AND network = ?`,
    [input.workspaceId, KIND, NETWORK],
  );

  const integrationId = existing?.id ?? newId('integration');

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
          VALUES (?, ?, ?, ?, ?, ?, ?, '["post","follow","like"]', 'active', ?, ?)`,
    args: [
      newId('integrationAccount'),
      integrationId,
      input.workspaceId,
      NETWORK,
      did || handle,
      handle,
      encryptSecret(input.appPassword, input.encryptionKey),
      stamp,
      stamp,
    ],
  });

  return { connected: true, handle, did, connectedAt: stamp };
}

export async function disconnectBlueskyAccount(db: Client, workspaceId: string): Promise<boolean> {
  const result = await db.execute({
    sql: `DELETE FROM integration_accounts WHERE workspace_id = ? AND network = ?`,
    args: [workspaceId, NETWORK],
  });

  await db.execute({
    sql: `UPDATE integrations SET status = 'disconnected', updated_at = ?
           WHERE workspace_id = ? AND kind = ? AND network = ?`,
    args: [now(), workspaceId, KIND, NETWORK],
  });

  return (result.rowsAffected ?? 0) > 0;
}

export async function blueskyAccountSummary(
  db: Client,
  workspaceId: string,
): Promise<BlueskyAccountSummary> {
  const row = await queryOne<{
    handle: string | null;
    external_account_id: string | null;
    status: string;
    created_at: string;
  }>(
    db,
    `SELECT ia.handle, ia.external_account_id, ia.status, ia.created_at
       FROM integration_accounts ia
      WHERE ia.workspace_id = ? AND ia.network = ?`,
    [workspaceId, NETWORK],
  );

  if (!row) return { connected: false };

  return {
    connected: row.status === 'active',
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.external_account_id ? { did: row.external_account_id } : {}),
    connectedAt: row.created_at,
  };
}

export interface BlueskyCredentials {
  readonly identifier: string;
  readonly appPassword: string;
  readonly did: string;
}

/**
 * The stored credential, decrypted.
 *
 * Returns `undefined` rather than throwing for "no account connected", which
 * is an ordinary state for most workspaces and not an error anywhere.
 */
export async function loadBlueskyCredentials(
  db: Client,
  workspaceId: string,
  encryptionKey: Buffer | undefined,
): Promise<BlueskyCredentials | undefined> {
  if (!encryptionKey) return undefined;

  const row = await queryOne<{
    handle: string | null;
    external_account_id: string | null;
    access_token_enc: string | null;
    status: string;
  }>(
    db,
    `SELECT handle, external_account_id, access_token_enc, status
       FROM integration_accounts WHERE workspace_id = ? AND network = ?`,
    [workspaceId, NETWORK],
  );

  if (!row || row.status !== 'active' || !row.access_token_enc || !row.handle) return undefined;

  try {
    return {
      identifier: row.handle,
      appPassword: decryptSecret(row.access_token_enc, encryptionKey),
      did: row.external_account_id ?? '',
    };
  } catch {
    // A credential we cannot decrypt is a credential we do not have. Throwing
    // here would take down every send in the tick over one bad row.
    return undefined;
  }
}

/** A logged-in agent for this workspace, or nothing if it has no account. */
export async function agentForWorkspace(
  db: Client,
  workspaceId: string,
  encryptionKey: Buffer | undefined,
  factory: () => BlueskyAgent = () => new BlueskyAgent(),
): Promise<BlueskyAgent | undefined> {
  const credentials = await loadBlueskyCredentials(db, workspaceId, encryptionKey);
  if (!credentials) return undefined;

  const agent = factory();
  try {
    await agent.login(credentials.identifier, credentials.appPassword);
  } catch (error) {
    if (error instanceof BlueskyAuthError) return undefined;
    throw error;
  }

  return agent;
}
