/**
 * Turso / libSQL access (PRD §1.1 "Turso Data Architecture").
 *
 * Application code never imports `@libsql/client` directly — it goes through
 * this module so transport details stay in one place and local development can
 * run against a plain SQLite file without any code changes.
 */

import { createClient, type Client, type Config, type InValue } from '@libsql/client';

export type { Client, InValue };

/** A single row as returned by libSQL, with columns keyed by name. */
export type Row = Record<string, unknown>;

let cached: Client | undefined;

export interface DatabaseOptions {
  readonly url?: string;
  readonly authToken?: string;
}

/**
 * Resolves connection settings from the environment.
 *
 * Falls back to a local file so `bun test` and a fresh checkout work with no
 * credentials. Production always supplies TURSO_DATABASE_URL.
 */
export function resolveConfig(options: DatabaseOptions = {}): Config {
  const url = options.url ?? process.env.TURSO_DATABASE_URL ?? 'file:./local.db';
  const authToken = options.authToken ?? process.env.TURSO_AUTH_TOKEN;

  // A remote Turso URL without a token fails deep inside a query with an
  // opaque error; catching it here names the actual problem.
  if (/^libsql:|^https:/.test(url) && !authToken) {
    throw new Error(
      'TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL points at a remote database',
    );
  }

  return authToken ? { url, authToken } : { url };
}

/**
 * Returns the process-wide client, creating it on first use.
 *
 * Memoized because libSQL manages its own connection pooling and a second
 * client would double the connection count for no benefit.
 */
export function getDatabase(options: DatabaseOptions = {}): Client {
  cached ??= createClient(resolveConfig(options));
  return cached;
}

/** Creates an isolated client. Tests use this to avoid sharing state. */
export function createDatabase(options: DatabaseOptions = {}): Client {
  return createClient(resolveConfig(options));
}

/**
 * Drops the memoized client. Call between test files that point at different
 * databases; production never needs it.
 */
export async function closeDatabase(): Promise<void> {
  if (!cached) return;
  const client = cached;
  cached = undefined;
  client.close();
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
