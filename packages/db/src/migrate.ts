/**
 * Forward-only migration runner.
 *
 * Migrations are plain `.sql` files in `/migrations`, applied in filename
 * order and recorded in `_migrations`. There is no `down` step by design: a
 * mistaken migration is corrected by writing the next one, so production and
 * every developer database converge on the same history.
 *
 * Migrations run as an explicit release step, never concurrently from every
 * replica. There is no distributed lock here: the `_migrations` primary key
 * makes a concurrent double-apply fail rather than corrupt, but the deploy
 * pipeline is still responsible for running this once per release.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from './client';

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

export interface MigrationStatus {
  readonly name: string;
  readonly applied: boolean;
  readonly appliedAt?: string;
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS _migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL,
    checksum    TEXT NOT NULL
  )
`;

export async function ensureLedger(client: Client): Promise<void> {
  await client.execute(LEDGER);
}

/** Reads and sorts migration files. Sorting by name is why they are numbered. */
export async function loadMigrations(dir: string): Promise<Migration[]> {
  const entries = await readdir(dir);
  const names = entries.filter((n) => n.endsWith('.sql')).sort();

  const migrations: Migration[] = [];
  for (const name of names) {
    migrations.push({ name, sql: await readFile(join(dir, name), 'utf8') });
  }
  return migrations;
}

export async function appliedMigrations(client: Client): Promise<Map<string, string>> {
  await ensureLedger(client);
  const result = await client.execute('SELECT name, applied_at, checksum FROM _migrations');
  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(String(row.name), String(row.checksum));
  }
  return map;
}

/**
 * Applies every migration not yet recorded.
 *
 * Each file runs inside its own transaction, so a failure halfway through the
 * run leaves earlier migrations applied and the failing one fully rolled back.
 */
export async function migrate(client: Client, dir: string): Promise<MigrateResult> {
  const migrations = await loadMigrations(dir);
  const already = await appliedMigrations(client);

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    const checksum = await hash(migration.sql);
    const recorded = already.get(migration.name);

    if (recorded !== undefined) {
      // An edited migration means two databases silently disagree about their
      // schema. Loud failure beats a mystery bug three deploys later.
      if (recorded !== checksum) {
        throw new Error(
          `migration ${migration.name} was modified after it was applied ` +
            `(recorded ${recorded.slice(0, 12)}, found ${checksum.slice(0, 12)}). ` +
            'Write a new migration instead of editing an applied one.',
        );
      }
      skipped.push(migration.name);
      continue;
    }

    await client.executeMultiple(`BEGIN;\n${migration.sql}\nCOMMIT;`).catch(async (error) => {
      await client.executeMultiple('ROLLBACK;').catch(() => {
        // Rollback fails when the transaction already aborted; the original
        // error is the one worth surfacing.
      });
      throw new Error(`migration ${migration.name} failed: ${describe(error)}`, { cause: error });
    });

    await client.execute({
      sql: 'INSERT INTO _migrations (name, applied_at, checksum) VALUES (?, ?, ?)',
      args: [migration.name, new Date().toISOString(), checksum],
    });

    applied.push(migration.name);
  }

  return { applied, skipped };
}

export async function migrationStatus(client: Client, dir: string): Promise<MigrationStatus[]> {
  const migrations = await loadMigrations(dir);
  await ensureLedger(client);
  const result = await client.execute('SELECT name, applied_at FROM _migrations');

  const times = new Map<string, string>();
  for (const row of result.rows) {
    times.set(String(row.name), String(row.applied_at));
  }

  return migrations.map((m) => {
    const appliedAt = times.get(m.name);
    return appliedAt === undefined
      ? { name: m.name, applied: false }
      : { name: m.name, applied: true, appliedAt };
  });
}

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
