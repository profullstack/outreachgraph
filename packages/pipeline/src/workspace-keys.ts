/**
 * Workspace key seals (seal v2) and the one-shot migration off the old
 * server-held SECRET_ENCRYPTION_KEY.
 *
 * A workspace's credentials (mailbox passwords, Bluesky app passwords,
 * LinkedIn/X sessions and tokens, CRM tokens) are sealed to that workspace's
 * public key. The seal record stored here is ciphertext + salt + KDF params +
 * key check + public key: nothing in this table opens anything.
 *
 * Migration runs only inside the workspace owner's own setup/unlock request:
 * each v1 value is opened with the old key, re-sealed to the workspace key and
 * written back in the same UPDATE. Unreadable rows are left as they were.
 * LEGACY_KEY_MIGRATION=off is the cutoff switch.
 */

import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  isSealRecordV2,
  isSealedValue,
  sealToPublicKeySync,
  type SealRecord,
  type SecretVault,
} from '@outreachgraph/secrets';

export async function loadWorkspaceSeal(
  db: Client,
  workspaceId: string,
): Promise<SealRecord | null> {
  const row = await queryOne<{ seal_json: string | null }>(
    db,
    'SELECT seal_json FROM workspace_key_seals WHERE workspace_id = ?',
    [workspaceId],
  );
  if (!row?.seal_json) return null;
  try {
    const parsed = JSON.parse(row.seal_json) as unknown;
    return isSealRecordV2(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveWorkspaceSeal(
  db: Client,
  workspaceId: string,
  seal: SealRecord,
  createdBy: string,
): Promise<void> {
  const stamp = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO workspace_key_seals (workspace_id, seal_json, seal_version, created_by, created_at, updated_at)
          VALUES (?, ?, 2, ?, ?, ?)
          ON CONFLICT (workspace_id) DO UPDATE SET seal_json = excluded.seal_json,
            created_by = excluded.created_by, updated_at = excluded.updated_at`,
    args: [workspaceId, JSON.stringify(seal), createdBy, stamp, stamp],
  });
}

export interface MigrationReport {
  migrated: number;
  failed: number;
  skipped: number;
}

const COLUMNS = ['access_token_enc', 'refresh_token_enc'] as const;

/** Pure core, unit-tested: the patch that re-seals one row, or null. */
export function resealRow(
  row: Record<string, string | null>,
  workspaceId: string,
  publicKey: string,
  open: ((legacy: string) => string) | null,
): { patch: Record<string, string> | null; failed: number } {
  const patch: Record<string, string> = {};
  let failed = 0;
  for (const col of COLUMNS) {
    const v = row[col];
    if (!v || isSealedValue(v) || !open) continue;
    try {
      patch[col] = sealToPublicKeySync(publicKey, open(v), workspaceId, col);
    } catch {
      failed++;
    }
  }
  return { patch: Object.keys(patch).length ? patch : null, failed };
}

export async function migrateWorkspaceSecrets(
  db: Client,
  vault: SecretVault,
  workspaceId: string,
  publicKey: string,
): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: 0, failed: 0, skipped: 0 };
  const rows = await queryAll<{
    id: string;
    access_token_enc: string | null;
    refresh_token_enc: string | null;
  }>(
    db,
    'SELECT id, access_token_enc, refresh_token_enc FROM integration_accounts WHERE workspace_id = ?',
    [workspaceId],
  );
  const open = vault.legacyMigrationEnabled ? (v: string) => vault.legacyOpen(v) : null;
  for (const row of rows) {
    const { patch, failed } = resealRow(row, workspaceId, publicKey, open);
    report.failed += failed;
    if (!patch) {
      report.skipped++;
      continue;
    }
    const cols = Object.keys(patch);
    await db.execute({
      sql: `UPDATE integration_accounts SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      args: [...cols.map((c) => patch[c]!), new Date().toISOString(), row.id],
    });
    report.migrated++;
  }
  return report;
}

/** Rows still holding a v1 (server-key) value, for the cutoff decision. */
export async function unmigratedCredentialCount(db: Client): Promise<number> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM integration_accounts
      WHERE (access_token_enc IS NOT NULL AND access_token_enc NOT LIKE 'v2:%')
         OR (refresh_token_enc IS NOT NULL AND refresh_token_enc NOT LIKE 'v2:%')`,
    [],
  );
  return Number(row?.n ?? 0);
}

/** True when the workspace holds credentials it cannot open right now. */
export async function workspaceLocked(
  db: Client,
  vault: SecretVault | undefined,
  workspaceId: string,
): Promise<boolean> {
  if (!vault || vault.canOpen(workspaceId)) return false;
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM integration_accounts
      WHERE workspace_id = ? AND status = 'active' AND access_token_enc IS NOT NULL`,
    [workspaceId],
  );
  return Number(row?.n ?? 0) > 0;
}
