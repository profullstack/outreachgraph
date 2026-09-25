/**
 * Databases for tests.
 *
 * By default each test gets its own SQLite file next to the test, migrated
 * from `/migrations`. With `TEST_DATABASE_URL=postgres://...` each test gets
 * its own Postgres database instead — cloned from a template that holds the
 * migrated `/migrations-pg` schema, so the ~50 migrations run once per suite
 * and every test still starts from an identical, empty schema. That is the
 * mode CI runs, because Postgres is what production speaks.
 *
 * Cleanup is fire-and-forget on purpose: 80-odd test files call it from a
 * synchronous `afterAll`. A dropped database that races the process exit is
 * left behind on the scratch server, which is harmless.
 */

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase, type Client } from './client';
import { loadMigrations, migrate, migrationsDir } from './migrate';

export interface TestDatabase {
  readonly client: Client;
  readonly url: string;
  readonly cleanup: () => void;
}

export interface TestDatabaseOptions {
  /** Apply the migrations (default). `false` gives an empty database. */
  readonly migrated?: boolean;
  /** Directory the SQLite file is created in (default: this package). */
  readonly dir?: string;
}

/** The Postgres server tests run against, when `TEST_DATABASE_URL` is set. */
export function testDatabaseUrl(): string | undefined {
  const url = process.env.TEST_DATABASE_URL;
  return url && /^postgres(ql)?:/i.test(url) ? url : undefined;
}

let counter = 0;
let template: Promise<string> | undefined;

export async function createTestDatabase(
  label: string,
  options: TestDatabaseOptions = {},
): Promise<TestDatabase> {
  const migrated = options.migrated ?? true;
  const base = testDatabaseUrl();

  if (!base) {
    const path = join(options.dir ?? import.meta.dir, `../.test-${label}-${process.pid}.db`);
    const url = `file:${path}`;
    const client = createDatabase({ url });
    if (migrated) await migrate(client, migrationsDir(client));
    return {
      client,
      url,
      cleanup: () => {
        client.close();
        for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
      },
    };
  }

  const name = `og_test_${process.pid}_${++counter}_${slug(label)}`;
  const admin = createDatabase({ url: base });
  try {
    if (migrated) {
      template ??= buildTemplate(base);
      await admin.execute(`CREATE DATABASE "${name}" TEMPLATE "${await template}"`);
    } else {
      await admin.execute(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await admin.close();
  }

  const url = withDatabase(base, name);
  const client = createDatabase({ url });
  return {
    client,
    url,
    cleanup: () => {
      void drop(base, name, client);
    },
  };
}

/**
 * A database holding the migrated schema, named after a hash of the migration
 * files so a schema change makes a new template rather than reusing a stale
 * one. Built once per process; reused across processes on the same server.
 */
async function buildTemplate(base: string): Promise<string> {
  const probe = createDatabase({ url: base });
  const files = await loadMigrations(migrationsDir(probe));
  const digest = createHash('sha256');
  for (const file of files) digest.update(file.name).update('\0').update(file.sql).update('\0');
  const name = `og_tpl_${digest.digest('hex').slice(0, 12)}`;

  const exists = await probe.execute({
    sql: 'SELECT 1 AS n FROM pg_database WHERE datname = ?',
    args: [name],
  });
  if (exists.rows.length === 0) {
    // A build that died halfway would leave a half-migrated template behind;
    // build under a temporary name and rename once the schema is complete.
    const building = `${name}_building_${process.pid}`;
    await probe.execute(`CREATE DATABASE "${building}"`);
    const client = createDatabase({ url: withDatabase(base, building) });
    try {
      await migrate(client, migrationsDir(client));
    } finally {
      await client.close();
    }
    await probe.execute(`ALTER DATABASE "${building}" RENAME TO "${name}"`).catch(async (error) => {
      // Another process finished the same template first; use theirs.
      await probe.execute(`DROP DATABASE "${building}"`);
      const again = await probe.execute({
        sql: 'SELECT 1 AS n FROM pg_database WHERE datname = ?',
        args: [name],
      });
      if (again.rows.length === 0) throw error;
    });
  }
  await probe.close();
  return name;
}

async function drop(base: string, name: string, client: Client): Promise<void> {
  try {
    await client.close();
    const admin = createDatabase({ url: base });
    try {
      await admin.execute(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin.close();
    }
  } catch {
    // Best effort: a leftover scratch database is not a test failure.
  }
}

function withDatabase(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 24);
}
