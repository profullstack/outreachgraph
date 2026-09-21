/**
 * Keys a workspace hands to its agents.
 *
 * The service token was the only machine credential, and it is the wrong
 * shape for a customer: one secret for the whole deployment, plus two headers
 * naming the workspace it should act on. A key here belongs to one workspace,
 * carries one person's authority, is shown once, and dies with a click.
 *
 * Stored as a SHA-256 digest, the same way sessions are. The prefix kept
 * beside it is for the list view — "og_live_8f3a…" tells you which key you
 * are about to revoke without telling anyone what the key is.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { hashToken, membershipForWorkspace } from './auth';
import type { RequestActor } from './context';

export const API_KEY_PREFIX = 'og_live_';
/** How many characters of the secret the list shows. */
const VISIBLE = API_KEY_PREFIX.length + 6;

export interface ApiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface MintedApiKey extends ApiKeySummary {
  /** The secret. Returned from mint and never again. */
  readonly key: string;
}

export class ApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

export function mintSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${API_KEY_PREFIX}${hex}`;
}

export function looksLikeApiKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(API_KEY_PREFIX) && value.length > VISIBLE;
}

export async function mintApiKey(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly organizationId: string;
    readonly userId: string;
    readonly name: string;
  },
): Promise<MintedApiKey> {
  const name = input.name.trim().slice(0, 100);
  if (!name) throw new ApiKeyError('a key needs a name');

  const key = mintSecret();
  const id = newId('apiKey');
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO api_keys (id, workspace_id, organization_id, user_id, name, key_hash,
          key_prefix, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.workspaceId,
      input.organizationId,
      input.userId,
      name,
      await hashToken(key),
      key.slice(0, VISIBLE),
      stamp,
    ],
  });

  return { id, name, prefix: key.slice(0, VISIBLE), createdAt: stamp, lastUsedAt: null, key };
}

export async function listApiKeys(db: Client, workspaceId: string): Promise<ApiKeySummary[]> {
  const rows = await queryAll<{
    id: string;
    name: string;
    key_prefix: string;
    created_at: string;
    last_used_at: string | null;
  }>(
    db,
    `SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys
      WHERE workspace_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [workspaceId],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/** Revokes rather than deletes, so an audit trail can still name the key. */
export async function revokeApiKey(
  db: Client,
  workspaceId: string,
  keyId: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`,
    args: [now(), keyId, workspaceId],
  });
  return result.rowsAffected > 0;
}

/**
 * The actor a presented key stands for, or undefined.
 *
 * Role comes from the owner's current membership, not from the key: a person
 * demoted to viewer takes their keys down with them, and a person removed
 * from the organization leaves keys that authenticate nobody.
 */
export async function actorFromApiKey(
  db: Client,
  presented: string,
): Promise<RequestActor | undefined> {
  if (!looksLikeApiKey(presented)) return undefined;

  const row = await queryOne<{ id: string; workspace_id: string; user_id: string }>(
    db,
    `SELECT id, workspace_id, user_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
    [await hashToken(presented)],
  );
  if (!row) return undefined;

  const membership = await membershipForWorkspace(db, row.user_id, row.workspace_id);
  if (!membership) return undefined;

  await db.execute({
    sql: 'UPDATE api_keys SET last_used_at = ? WHERE id = ?',
    args: [now(), row.id],
  });

  return {
    userId: row.user_id,
    workspaceId: membership.workspaceId,
    organizationId: membership.organizationId,
    role: membership.role,
    credential: 'api_key',
  };
}

/** The key a request carries, from either header it may use. */
export function presentedApiKey(request: Request): string | undefined {
  const direct = request.headers.get('x-api-key');
  if (looksLikeApiKey(direct)) return direct;

  const bearer = request.headers.get('authorization');
  if (bearer?.startsWith('Bearer ')) {
    const token = bearer.slice('Bearer '.length).trim();
    if (looksLikeApiKey(token)) return token;
  }

  return undefined;
}
