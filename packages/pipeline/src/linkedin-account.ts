/**
 * Connecting a workspace's LinkedIn session.
 *
 * Not OAuth, and deliberately so: LinkedIn offers no OAuth scope that can
 * comment on someone else's post (see `providers/src/linkedin/session.ts`),
 * so the credential is the member's own `li_at` cookie. It is verified
 * against LinkedIn before it is stored, encrypted like every other
 * credential, and lives in the same tables so the policy engine's "is there a
 * connected account for this network" question has one answer.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import {
  LinkedInSession,
  LinkedInSessionError,
  type LinkedInSessionOptions,
} from '@outreachgraph/providers';
import { decryptSecret, encryptSecret } from '@outreachgraph/secrets';

const KIND = 'social';
const NETWORK = 'linkedin';

export class LinkedInAccountError extends Error {
  readonly code: 'verification_failed' | 'no_key';
  constructor(code: LinkedInAccountError['code'], message: string) {
    super(message);
    this.name = 'LinkedInAccountError';
    this.code = code;
  }
}

export interface LinkedInAccountSummary {
  readonly connected: boolean;
  readonly publicIdentifier?: string;
  readonly name?: string;
  readonly connectedAt?: string;
}

export async function connectLinkedInSession(
  db: Client,
  input: {
    workspaceId: string;
    liAt: string;
    encryptionKey: Buffer;
    verify?: boolean;
    sessionOptions?: LinkedInSessionOptions;
  },
): Promise<LinkedInAccountSummary> {
  const liAt = input.liAt.trim().replace(/^li_at=/, '');
  let publicIdentifier = '';
  let entityUrn = '';
  let name = '';

  if (input.verify !== false) {
    try {
      const me = await new LinkedInSession(liAt, input.sessionOptions).me();
      publicIdentifier = me.publicIdentifier;
      entityUrn = me.entityUrn;
      name = me.name;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new LinkedInAccountError('verification_failed', detail);
    }
  }

  const stamp = now();
  const config = { publicIdentifier, name, optedInToSessionAutomation: stamp };

  const existing = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM integrations WHERE workspace_id = ? AND kind = ? AND network = ?`,
    [input.workspaceId, KIND, NETWORK],
  );
  const integrationId = existing?.id ?? newId('integration');

  if (existing) {
    await db.execute({
      sql: `UPDATE integrations SET status = 'connected', config_json = ?, updated_at = ? WHERE id = ?`,
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

  await db.execute({
    sql: `DELETE FROM integration_accounts WHERE workspace_id = ? AND network = ?`,
    args: [input.workspaceId, NETWORK],
  });

  await db.execute({
    sql: `INSERT INTO integration_accounts (id, integration_id, workspace_id, network,
          external_account_id, handle, access_token_enc, scopes, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '["comment"]', 'active', ?, ?)`,
    args: [
      newId('integrationAccount'),
      integrationId,
      input.workspaceId,
      NETWORK,
      entityUrn || publicIdentifier,
      publicIdentifier,
      encryptSecret(liAt, input.encryptionKey),
      stamp,
      stamp,
    ],
  });

  return { connected: true, publicIdentifier, name, connectedAt: stamp };
}

/**
 * The session for this workspace, or undefined. A cookie LinkedIn has signed
 * out is marked revoked so its cards go back to being hand-offs.
 */
export async function linkedInSessionForWorkspace(
  db: Client,
  workspaceId: string,
  encryptionKey: Buffer | undefined,
  options: LinkedInSessionOptions = {},
): Promise<LinkedInSession | undefined> {
  if (!encryptionKey) return undefined;

  const row = await queryOne<{ id: string; access_token_enc: string | null; status: string }>(
    db,
    `SELECT id, access_token_enc, status FROM integration_accounts
      WHERE workspace_id = ? AND network = ?`,
    [workspaceId, NETWORK],
  );
  if (!row || row.status !== 'active' || !row.access_token_enc) return undefined;

  try {
    return new LinkedInSession(decryptSecret(row.access_token_enc, encryptionKey), options);
  } catch {
    return undefined;
  }
}

export async function markLinkedInSessionRevoked(db: Client, workspaceId: string): Promise<void> {
  await db.execute({
    sql: `UPDATE integration_accounts SET status = 'revoked', updated_at = ?
           WHERE workspace_id = ? AND network = ?`,
    args: [now(), workspaceId, NETWORK],
  });
}

export async function linkedInAccountSummary(
  db: Client,
  workspaceId: string,
): Promise<LinkedInAccountSummary> {
  const row = await queryOne<{ handle: string | null; status: string; created_at: string }>(
    db,
    `SELECT handle, status, created_at FROM integration_accounts
      WHERE workspace_id = ? AND network = ?`,
    [workspaceId, NETWORK],
  );
  if (!row) return { connected: false };
  return {
    connected: row.status === 'active',
    ...(row.handle ? { publicIdentifier: row.handle } : {}),
    connectedAt: row.created_at,
  };
}

export async function disconnectLinkedInSession(db: Client, workspaceId: string): Promise<boolean> {
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

export { LinkedInSessionError };
