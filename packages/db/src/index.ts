/**
 * `@outreachgraph/db` — the only module that talks to the database.
 *
 * Everything else in the repository depends on these helpers rather than on
 * a driver, so the transport can change without touching callers — which is
 * how the move from Turso to Postgres changed one file
 * (PRD §1.1 "Database access MUST live behind the shared packages/db layer").
 */

export {
  closeDatabase,
  createDatabase,
  getDatabase,
  isPostgres,
  now,
  queryAll,
  queryOne,
  resolveConfig,
  withTransaction,
  type Client,
  type DatabaseOptions,
  type Driver,
  type InValue,
  type ResolvedConfig,
  type Row,
} from './client';

export {
  appliedMigrations,
  ensureLedger,
  loadMigrations,
  migrate,
  migrationsDir,
  migrationStatus,
  type Migration,
  type MigrateResult,
  type MigrationStatus,
} from './migrate';

export {
  createTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
  type TestDatabaseOptions,
} from './testing';
