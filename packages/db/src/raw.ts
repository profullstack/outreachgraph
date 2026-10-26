/**
 * A raw handle on the same database, for house packages that bring their own SQL.
 *
 * `@profullstack/redeem-credits` and `@profullstack/affiliates` ship stores for
 * a node-postgres pool and for a synchronous SQLite handle, and write their own
 * Postgres-native statements (`$1` placeholders, `FOR UPDATE`, advisory
 * locks). Sending those through the libsql-pg rewriter would be asking it to
 * translate SQL that is already Postgres, so they get a plain `pg.Pool` on
 * production's URL instead, and a `bun:sqlite` handle on the same file locally.
 *
 * It stays in this package so the rule holds that application code never opens
 * a driver itself (PRD §1.1).
 */

import { Database } from 'bun:sqlite';
import pg from 'pg';
import { resolveConfig, type DatabaseOptions } from './client';

/** Anything with node-postgres' `query`: what the house packages' `postgresStore` takes. */
export interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export type RawHandle =
  | { readonly kind: 'postgres'; readonly pool: PgQueryable; close(): Promise<void> }
  | { readonly kind: 'sqlite'; readonly db: Database; close(): Promise<void> };

/**
 * `sslmode=` read the way the main client (libsql-pg) reads it. node-postgres
 * treats `require` as verify-full, so the self-signed certificate production's
 * Postgres presents would be refused here while the main client connects fine.
 */
export function pgConnection(url: string): {
  connectionString: string;
  ssl?: pg.PoolConfig['ssl'];
} {
  const parsed = new URL(url);
  const mode = parsed.searchParams.get('sslmode');
  parsed.searchParams.delete('sslmode');
  const connectionString = parsed.toString();
  if (mode === 'require' || mode === 'prefer')
    return { connectionString, ssl: { rejectUnauthorized: false } };
  if (mode === 'verify-ca' || mode === 'verify-full') return { connectionString, ssl: true };
  return { connectionString };
}

/**
 * Opens a raw handle for `options.url` (or the environment's database).
 *
 * The pool is small on purpose: codes and invites are a few queries a day, and
 * every connection here is one the main client cannot have.
 */
export function openRawHandle(options: DatabaseOptions = {}): RawHandle {
  const config = resolveConfig(options);

  if (config.driver === 'postgres') {
    const pool = new pg.Pool({
      ...pgConnection(config.url),
      max: 3,
      idleTimeoutMillis: 30_000,
      application_name: 'outreachgraph-codes',
    });
    // An idle client dropped by the server must not take the process down.
    pool.on('error', () => {});
    return { kind: 'postgres', pool, close: () => pool.end() };
  }

  const db = new Database(config.url.slice('file:'.length));
  // The libsql client holds the same file; wait for its locks rather than fail.
  db.exec('PRAGMA busy_timeout = 5000');
  return {
    kind: 'sqlite',
    db,
    close: async () => db.close(),
  };
}
