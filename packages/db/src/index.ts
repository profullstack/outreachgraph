/**
 * `@outreachgraph/db` — the only module that talks to Turso.
 *
 * Everything else in the repository depends on these helpers rather than on
 * `@libsql/client`, so the transport can change without touching callers
 * (PRD §1.1 "Database access MUST live behind the shared packages/db layer").
 */

export {
  closeDatabase,
  createDatabase,
  getDatabase,
  now,
  queryAll,
  queryOne,
  resolveConfig,
  withTransaction,
  type Client,
  type DatabaseOptions,
  type InValue,
  type Row,
} from './client';

export {
  appliedMigrations,
  ensureLedger,
  loadMigrations,
  migrate,
  migrationStatus,
  type Migration,
  type MigrateResult,
  type MigrationStatus,
} from './migrate';
