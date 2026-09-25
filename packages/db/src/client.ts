/**
 * Database access.
 *
 * Production runs on Postgres through `@profullstack/libsql-pg`, which keeps
 * the `@libsql/client` surface this code was written against (`execute`,
 * `batch`, `transaction`, `rows`, `rowsAffected`) and rewrites the SQLite
 * idioms in each statement, so the query code did not change when the data
 * moved off Turso (2026-09-25). Tests and local development may still use a
 * SQLite file through `@libsql/client`; a remote libSQL URL is refused.
 *
 * Application code never imports either driver directly — it goes through
 * this module so transport details stay in one place (PRD §1.1).
 */

import { createClient as createSqliteClient, type Client, type InValue } from '@libsql/client';
import { createClient as createPostgresClient } from '@profullstack/libsql-pg';

export type { Client, InValue };

/** A single row as returned by the driver, with columns keyed by name. */
export type Row = Record<string, unknown>;

export type Driver = 'postgres' | 'sqlite';

let cached: Client | undefined;

export interface DatabaseOptions {
  readonly url?: string;
}

export interface ResolvedConfig {
  readonly url: string;
  readonly driver: Driver;
}

const PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Resolves connection settings from the environment.
 *
 * `DATABASE_URL` is the setting; `TURSO_DATABASE_URL` is still read so a
 * deployment that re-pointed the old name at Postgres keeps working. Outside
 * production a missing URL falls back to a local SQLite file so `bun test`
 * and a fresh checkout work with no credentials. Production must be Postgres:
 * a file database, a leftover `libsql://` URL or no URL at all is a deploy
 * error, and the process says so instead of limping along.
 */
export function resolveConfig(options: DatabaseOptions = {}): ResolvedConfig {
  const url =
    options.url ??
    process.env.DATABASE_URL ??
    process.env.TURSO_DATABASE_URL ??
    (PRODUCTION ? undefined : 'file:./local.db');

  if (!url) {
    throw new Error(
      'DATABASE_URL is required: a postgres:// URL (OutreachGraph runs on Postgres; ' +
        'outside production a file:./local.db fallback is used when it is unset)',
    );
  }
  if (/^postgres(ql)?:/i.test(url)) return { url, driver: 'postgres' };
  if (url.startsWith('file:')) {
    if (PRODUCTION) {
      throw new Error(
        `refusing to run production against a SQLite file (${url}); ` +
          'set DATABASE_URL to a postgres:// URL',
      );
    }
    return { url, driver: 'sqlite' };
  }
  if (/^(libsql|https?|wss?):/i.test(url)) {
    throw new Error(
      `Turso/libSQL is retired: ${redact(url)}. The data lives in Postgres now; ` +
        'set DATABASE_URL to a postgres:// URL (move any remaining rows first with ' +
        '`npx libsql-pg copy --from <that url> --token ... --to $DATABASE_URL --verify`)',
    );
  }
  throw new Error(`unsupported database URL scheme: ${redact(url)}`);
}

/** The URL with any password blanked, for error messages and logs. */
function redact(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
}

function open(config: ResolvedConfig): Client {
  if (config.driver === 'postgres') {
    // `dialect: 'sqlite'` turns on the per-statement rewriter (INSERT OR
    // IGNORE, datetime('now'), json_extract, scalar max/min, ...). The
    // package's own Client type is structurally the libsql one.
    return createPostgresClient({ url: config.url, dialect: 'sqlite' }) as unknown as Client;
  }
  return createSqliteClient({ url: config.url });
}

/** Whether a client talks to Postgres (as opposed to a SQLite file). */
export function isPostgres(client: Client): boolean {
  return client.protocol === 'postgres';
}

/**
 * Returns the process-wide client, creating it on first use.
 *
 * Memoized because the driver manages its own connection pool and a second
 * client would double the connection count for no benefit.
 */
export function getDatabase(options: DatabaseOptions = {}): Client {
  cached ??= open(resolveConfig(options));
  return cached;
}

/** Creates an isolated client. Tests use this to avoid sharing state. */
export function createDatabase(options: DatabaseOptions = {}): Client {
  return open(resolveConfig(options));
}

/**
 * Drops the memoized client. Call between test files that point at different
 * databases; production never needs it.
 */
export async function closeDatabase(): Promise<void> {
  if (!cached) return;
  const client = cached;
  cached = undefined;
  await client.close();
}

/** Runs `fn` inside a transaction, rolling back if it throws. */
export async function withTransaction<T>(
  client: Client,
  fn: (tx: Awaited<ReturnType<Client['transaction']>>) => Promise<T>,
): Promise<T> {
  const tx = await client.transaction('write');
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

/**
 * Returns the first row, or undefined. Saves a `.rows[0]` at every call site.
 *
 * `T` is unconstrained so callers can pass a plain row interface without
 * having to add an index signature to it.
 */
export async function queryOne<T = Row>(
  client: Client,
  sql: string,
  args: InValue[] = [],
): Promise<T | undefined> {
  const result = await client.execute({ sql, args });
  return result.rows[0] as T | undefined;
}

export async function queryAll<T = Row>(
  client: Client,
  sql: string,
  args: InValue[] = [],
): Promise<T[]> {
  const result = await client.execute({ sql, args });
  return result.rows as unknown as T[];
}

/** ISO-8601 UTC, the timestamp format every table stores. */
export function now(): string {
  return new Date().toISOString();
}
