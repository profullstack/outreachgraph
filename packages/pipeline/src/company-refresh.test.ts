import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { enqueue } from './queue';
import { refreshStaleCompanies } from './company-refresh';

setDefaultTimeout(30_000);

let seeded: SeededDatabase | undefined;
afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const AT = new Date('2026-10-17T12:00:00.000Z');
const daysAgo = (n: number) => new Date(AT.getTime() - n * 86_400_000).toISOString();

async function setup(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  // The seeded Acme was last read 40 days ago.
  await seeded.db.execute({
    sql: 'UPDATE companies SET updated_at = ? WHERE id = ?',
    args: [daysAgo(40), SEED.companyId],
  });
  return seeded.db;
}

/** A company with one person in the seeded campaign, last read `age` days ago. */
async function companyWithPerson(db: Client, id: string, domain: string, age: number) {
  await db.batch([
    {
      sql: `INSERT INTO companies (id, name, domain, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      args: [id, id, domain, daysAgo(age), daysAgo(age)],
    },
    {
      sql: `INSERT INTO people (id, display_name, current_company_id, identity_confidence, status,
              outreach_eligible, believed_minor, created_at, updated_at)
            VALUES (?, ?, ?, 0.9, 'active', 1, 0, ?, ?)`,
      args: [`per_${id}`, id, id, daysAgo(age), daysAgo(age)],
    },
    {
      sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status,
              interaction_state, discovered_at, updated_at)
            VALUES (?, ?, ?, 'discovered', 'never_contacted', ?, ?)`,
      args: [SEED.campaignId, `per_${id}`, SEED.workspaceId, daysAgo(age), daysAgo(age)],
    },
  ]);
}

describe('refreshStaleCompanies', () => {
  test('re-crawls the stalest companies first, under their campaign, and stamps them', async () => {
    const db = await setup('refresh-order');
    await companyWithPerson(db, 'co_older', 'older.test', 90);
    await companyWithPerson(db, 'co_fresh', 'fresh.test', 3);
    // A company nobody in a campaign works at is not ours to re-read.
    await db.execute({
      sql: `INSERT INTO companies (id, name, domain, created_at, updated_at) VALUES ('co_orphan', 'o', 'orphan.test', ?, ?)`,
      args: [daysAgo(200), daysAgo(200)],
    });

    const result = await refreshStaleCompanies(db, { limit: 5, now: AT });
    expect(result.queued).toBe(2);
    const jobs = await queryAll<{ payload_json: string; dedupe_key: string }>(
      db,
      `SELECT payload_json, dedupe_key FROM jobs WHERE kind = 'crawl_site' ORDER BY created_at, dedupe_key`,
    );
    expect(jobs.map((j) => j.dedupe_key).sort()).toEqual(['crawl:acme.com', 'crawl:older.test']);
    const older = jobs.find((j) => j.dedupe_key === 'crawl:older.test')!;
    expect(JSON.parse(older.payload_json)).toEqual({
      url: 'https://older.test/',
      campaignId: SEED.campaignId,
      refresh: true,
    });
    const stamped = await queryOne<{ refreshed_at: string | null }>(
      db,
      `SELECT refreshed_at FROM companies WHERE id = 'co_older'`,
    );
    expect(stamped?.refreshed_at).toBeTruthy();

    // Stamped, so the next run does not pick them again.
    expect((await refreshStaleCompanies(db, { limit: 5, now: AT })).considered).toBe(0);
  });

  test('respects the limit, oldest first', async () => {
    const db = await setup('refresh-limit');
    await companyWithPerson(db, 'co_older', 'older.test', 90);
    const result = await refreshStaleCompanies(db, { limit: 1, now: AT });
    expect(result.queued).toBe(1);
    const job = await queryOne<{ dedupe_key: string }>(
      db,
      `SELECT dedupe_key FROM jobs WHERE kind = 'crawl_site'`,
    );
    expect(job?.dedupe_key).toBe('crawl:older.test');
  });

  test('leaves a busy workspace alone so its own crawls come first', async () => {
    const db = await setup('refresh-busy');
    for (let i = 0; i < 3; i += 1) {
      await enqueue(db, {
        workspaceId: SEED.workspaceId,
        kind: 'crawl_site',
        payload: { url: `https://busy${i}.test/` },
      });
    }
    const result = await refreshStaleCompanies(db, { limit: 5, maxPending: 3, now: AT });
    expect(result).toMatchObject({ queued: 0, busyWorkspaces: 1 });
  });
});
