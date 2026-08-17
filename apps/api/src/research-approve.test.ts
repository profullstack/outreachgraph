/**
 * Approving research has to actually cause research.
 *
 * `refresh_research` had no executor anywhere. The job runner knows four kinds
 * and this was not one of them, so approving one of these cards wrote an
 * approval row, an action row and an audit row and then stopped. Nothing
 * re-read the site. The card existed *because* there was nothing to say, and
 * approving it produced nothing to say, so the next tick proposed the same
 * card again. Production held 73 of them.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function harness(label: string): Promise<{ app: Hono<AppEnv>; db: Client }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  return { app: createApp({ db: seeded.db, authenticate: async () => ACTOR }), db: seeded.db };
}

/** A pending research card for the seeded person. */
async function addResearchCard(db: Client, id = 'rec_research'): Promise<string> {
  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
          network, priority, reason, policy_status, policy_version, expected_goal,
          status, created_at)
          VALUES (?, ?, ?, ?, 'refresh_research', 'website', 40, 'Nothing to say yet.',
          'allow_with_approval', '2026-08-11', 'gather_context', 'pending', ?)`,
    args: [id, SEED.workspaceId, SEED.campaignId, SEED.personId, now()],
  });
  return id;
}

async function post(app: Hono<AppEnv>, path: string): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

describe('approving a research card queues the re-crawl', () => {
  test('a crawl job appears for the company site', async () => {
    const { app, db } = await harness('research-approve');
    const id = await addResearchCard(db);

    await db.execute({
      sql: `UPDATE companies SET domain = ? WHERE id = ?`,
      args: ['acme.test', SEED.companyId],
    });

    const response = await post(app, `/recommendations/${id}/approve`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { research?: { queued: boolean; url?: string } };
    expect(body.research?.queued).toBe(true);
    expect(body.research?.url).toBe('https://acme.test');

    // The job is real, and carries the campaign so the crawl files people
    // under the campaign that asked rather than the workspace's oldest.
    const jobs = await queryAll<{ kind: string; payload_json: string }>(
      db,
      `SELECT kind, payload_json FROM jobs WHERE kind = 'crawl_site'`,
    );
    expect(jobs).toHaveLength(1);

    const payload = JSON.parse(jobs[0]!.payload_json) as { url: string; campaignId?: string };
    expect(payload.url).toBe('https://acme.test');
    expect(payload.campaignId).toBe(SEED.campaignId);
  });

  test('a person with no company on file says so instead of queueing nothing', async () => {
    const { app, db } = await harness('research-approve-no-domain');
    const id = await addResearchCard(db);

    await db.execute({
      sql: `UPDATE people SET current_company_id = NULL WHERE id = ?`,
      args: [SEED.personId],
    });

    const response = await post(app, `/recommendations/${id}/approve`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { research?: { queued: boolean; reason?: string } };
    expect(body.research?.queued).toBe(false);
    expect(body.research?.reason).toContain('domain');

    const jobs = await queryAll(db, `SELECT id FROM jobs WHERE kind = 'crawl_site'`);
    expect(jobs).toHaveLength(0);
  });

  test('approving an outbound card queues no crawl', async () => {
    const { app, db } = await harness('research-approve-outbound');

    // The seeded card is a `reply`, not research.
    const response = await post(app, `/recommendations/${SEED.recommendationId}/approve`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { research?: unknown };
    expect(body.research).toBeUndefined();

    const jobs = await queryAll(db, `SELECT id FROM jobs WHERE kind = 'crawl_site'`);
    expect(jobs).toHaveLength(0);
  });

  test('the card is still marked approved, whatever the crawl did', async () => {
    const { app, db } = await harness('research-approve-state');
    const id = await addResearchCard(db);

    await post(app, `/recommendations/${id}/approve`);

    const rec = await queryOne<{ status: string }>(
      db,
      'SELECT status FROM recommendations WHERE id = ?',
      [id],
    );
    expect(rec?.status).toBe('approved');
  });
});
