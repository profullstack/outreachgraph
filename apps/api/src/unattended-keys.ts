/**
 * Workspace keys that unlock themselves (see migration 0090).
 *
 * Seal v2 keeps a workspace's credentials openable only while its owner has
 * unlocked them, in memory, for at most 7 days; every deploy re-locks. An
 * owner who opts in ("keep unlocked across restarts") trades that for
 * unattended operation: the data key they unlocked with is kept wrapped under
 * the server key `OG_UNATTENDED_KEY`, and the worker re-unlocks whenever the
 * vault has dropped it. Lock, or turning the option off, deletes the row.
 *
 * This is weaker than unlock-on-use by design: anyone with the database and
 * the server key can open the credentials. It is the owner's explicit choice.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import { UNLOCK_MAX_TTL_SECONDS, type SecretVault } from '@outreachgraph/secrets';

const PREFIX = 'u1:';

function serverKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('OG_UNATTENDED_KEY must be 32 bytes, base64');
  return key;
}

/** Wraps a base64 data key for one workspace. */
export function wrapDataKey(keyB64: string, workspaceId: string, dekB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', serverKey(keyB64), iv);
  cipher.setAAD(Buffer.from(`og-unattended:${workspaceId}`));
  const body = Buffer.concat([cipher.update(Buffer.from(dekB64, 'base64')), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** The base64 data key back, or a thrown error if the key or workspace is wrong. */
export function unwrapDataKey(keyB64: string, workspaceId: string, wrapped: string): string {
  if (!wrapped.startsWith(PREFIX)) throw new Error('unknown wrapped key format');
  const raw = Buffer.from(wrapped.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', serverKey(keyB64), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(`og-unattended:${workspaceId}`));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('base64');
}

export async function saveUnattendedKey(
  db: Client,
  workspaceId: string,
  wrapped: string,
  userId: string,
): Promise<void> {
  const stamp = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO workspace_unattended_keys (workspace_id, wrapped_dek, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id) DO UPDATE SET wrapped_dek = excluded.wrapped_dek,
            created_by = excluded.created_by, updated_at = excluded.updated_at`,
    args: [workspaceId, wrapped, userId, stamp, stamp],
  });
}

export async function deleteUnattendedKey(db: Client, workspaceId: string): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM workspace_unattended_keys WHERE workspace_id = ?',
    args: [workspaceId],
  });
}

export async function hasUnattendedKey(db: Client, workspaceId: string): Promise<boolean> {
  const row = await queryOne<{ workspace_id: string }>(
    db,
    'SELECT workspace_id FROM workspace_unattended_keys WHERE workspace_id = ?',
    [workspaceId],
  );
  return Boolean(row);
}

/**
 * Unlocks every opted-in workspace the vault has dropped (boot, deploy, TTL
 * expiry). Returns the workspaces unlocked. A row that no longer opens (the
 * server key changed, or the seal was reset) is reported and left for the
 * owner's next unlock to replace.
 */
export async function rearmUnattendedKeys(
  db: Client,
  vault: SecretVault | undefined,
  keyB64: string | undefined,
): Promise<{ unlocked: string[]; failed: string[] }> {
  const unlocked: string[] = [];
  const failed: string[] = [];
  if (!vault || !keyB64) return { unlocked, failed };
  const rows = await queryAll<{ workspace_id: string; wrapped_dek: string }>(
    db,
    'SELECT workspace_id, wrapped_dek FROM workspace_unattended_keys',
  );
  for (const row of rows) {
    if (vault.canOpen(row.workspace_id)) continue;
    try {
      const dek = unwrapDataKey(keyB64, row.workspace_id, row.wrapped_dek);
      await vault.unlock(row.workspace_id, dek, UNLOCK_MAX_TTL_SECONDS);
      unlocked.push(row.workspace_id);
    } catch (error) {
      console.warn(`unattended unlock failed for ${row.workspace_id}: ${String(error)}`);
      failed.push(row.workspace_id);
    }
  }
  return { unlocked, failed };
}
