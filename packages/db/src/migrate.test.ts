import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase } from './client';
import { loadMigrations, migrate, migrationStatus } from './migrate';

const MIGRATIONS_DIR = join(import.meta.dir, '../../../migrations');

/** Each test gets its own file so they cannot observe each other's schema. */
let dbPaths: string[] = [];

function freshDatabase(label: string) {
  const path = join(import.meta.dir, `../.test-${label}-${process.pid}.db`);
  dbPaths.push(path);
  return { client: createDatabase({ url: `file:${path}` }), path };
}

afterEach(() => {
  for (const path of dbPaths) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
  dbPaths = [];
});

describe('migrations', () => {
  test('apply cleanly to an empty database', async () => {
    const { client } = freshDatabase('apply');
    try {
      const result = await migrate(client, MIGRATIONS_DIR);

      expect(result.applied.length).toBeGreaterThanOrEqual(5);
      expect(result.skipped).toHaveLength(0);
      expect(result.applied).toEqual([...result.applied].sort());
    } finally {
      client.close();
    }
  });

  test('are idempotent — a second run applies nothing', async () => {
    const { client } = freshDatabase('idempotent');
    try {
      const first = await migrate(client, MIGRATIONS_DIR);
      const second = await migrate(client, MIGRATIONS_DIR);

      expect(second.applied).toHaveLength(0);
      expect(second.skipped).toEqual(first.applied);
    } finally {
      client.close();
    }
  });

  test('create every table the PRD §21 model requires', async () => {
    const { client } = freshDatabase('tables');
    try {
      await migrate(client, MIGRATIONS_DIR);
      const result = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      );
      const tables = new Set(result.rows.map((r) => String(r.name)));

      for (const required of [
        'users',
        'organizations',
        'organization_members',
        'workspaces',
        'integrations',
        'integration_accounts',
        'offerings',
        'voice_profiles',
        'campaigns',
        'campaign_filters',
        'campaign_signal_rules',
        'companies',
        'people',
        'person_employment',
        'social_identities',
        'identity_evidence',
        'identity_candidates',
        'provider_records',
        'field_provenance',
        'source_documents',
        'signals',
        'campaign_people',
        'scores',
        'recommendations',
        'drafts',
        'approvals',
        'actions',
        'interactions',
        'suppression_entries',
        'privacy_requests',
        'deletion_jobs',
        'policy_rules',
        'policy_versions',
        'usage_events',
        'billing_accounts',
        'audit_events',
      ]) {
        expect(tables).toContain(required);
      }
    } finally {
      client.close();
    }
  });

  test('reject a migration edited after it was applied', async () => {
    const { client } = freshDatabase('checksum');
    try {
      await migrate(client, MIGRATIONS_DIR);

      // Simulate someone editing an already-applied file.
      await client.execute({
        sql: 'UPDATE _migrations SET checksum = ? WHERE name = ?',
        args: ['deadbeef', '0000_init.sql'],
      });

      await expect(migrate(client, MIGRATIONS_DIR)).rejects.toThrow(/was modified after/);
    } finally {
      client.close();
    }
  });

  /**
   * Two files sharing a number is not a naming quibble — it makes apply order
   * depend on which environment you are in.
   *
   * The ledger is keyed by filename, so a database that already holds one of
   * the pair applies only the other, in whatever order the deploy happened to
   * land them. A database built from scratch applies both, in filename order.
   * Production and a fresh clone therefore run the same two migrations in
   * different orders, and nothing anywhere notices.
   *
   * It happened twice — `0007` and `0029` — both times because two branches
   * numbered their migration the same day and both merged. Both pairs have
   * since been renumbered, which was only possible because the halves that
   * moved were re-appliable: one was already `CREATE INDEX IF NOT EXISTS`
   * throughout and the other was rewritten to match.
   *
   * That is the part worth remembering, and the reason this test has no
   * exemption list. A rename is not generally available as a repair. The
   * ledger key is the filename, so to a database that already ran the file the
   * new name is an unrecorded migration and gets applied again — and a second
   * `CREATE TABLE` fails, which stops the container booting. Renumbering these
   * two cost an `IF NOT EXISTS` rewrite and a ledger-cleanup migration; the
   * next collision might land on a migration that cannot be made idempotent at
   * all, and then it is permanent.
   *
   * So the number has to be unique *before* it ships, and this is the only
   * moment that is still cheap.
   */
  test('never reuse a number — apply order must not depend on the environment', async () => {
    const names = (await loadMigrations(MIGRATIONS_DIR)).map((m) => m.name);

    const byPrefix = new Map<string, string[]>();
    for (const name of names) {
      const prefix = name.slice(0, name.indexOf('_'));
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
    }

    const collisions = [...byPrefix.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([, files]) => files);

    expect(collisions).toEqual([]);
  });

  test('report status for applied and pending migrations', async () => {
    const { client } = freshDatabase('status');
    try {
      const before = await migrationStatus(client, MIGRATIONS_DIR);
      expect(before.every((s) => !s.applied)).toBe(true);

      await migrate(client, MIGRATIONS_DIR);

      const after = await migrationStatus(client, MIGRATIONS_DIR);
      expect(after.every((s) => s.applied)).toBe(true);
      expect(after[0]?.appliedAt).toBeDefined();
    } finally {
      client.close();
    }
  });

  test('enforce one canonical person per platform account', async () => {
    const { client } = freshDatabase('unique');
    try {
      await migrate(client, MIGRATIONS_DIR);
      const stamp = new Date().toISOString();

      await client.execute({
        sql: `INSERT INTO people (id, display_name, identity_confidence, status, outreach_eligible,
              believed_minor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ['per_a', 'Jane Smith', 0.9, 'active', 1, 0, stamp, stamp],
      });
      await client.execute({
        sql: `INSERT INTO people (id, display_name, identity_confidence, status, outreach_eligible,
              believed_minor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ['per_b', 'Jane Smyth', 0.9, 'active', 1, 0, stamp, stamp],
      });

      const insertIdentity = (id: string, personId: string) =>
        client.execute({
          sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
                confidence, source_type, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [id, personId, 'github', 'janesmith', '12345', 0.98, 'official_api', stamp],
        });

      await insertIdentity('sid_a', 'per_a');
      // Two canonical people cannot both claim the same real GitHub account.
      await expect(insertIdentity('sid_b', 'per_b')).rejects.toThrow();
    } finally {
      client.close();
    }
  });
});
