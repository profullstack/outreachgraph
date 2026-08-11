import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase } from './client';
import { migrate, migrationStatus } from './migrate';

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
