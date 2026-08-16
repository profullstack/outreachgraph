import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';
import { createCampaignFromIntake, IntakeError, setCampaignAutopilot } from './campaigns';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const ACTOR = { workspaceId: SEED.workspaceId, userId: SEED.userId };

describe('createCampaignFromIntake', () => {
  test('a website is crawled directly', async () => {
    seeded = await seedDatabase('intake-url');
    const { db } = seeded;

    const result = await createCampaignFromIntake(db, ACTOR, 'https://www.brightsmile.com/about');

    expect(result.kind).toBe('url');
    expect(result.seed).toBe('brightsmile.com');
    expect(result.queued).toBe(1);

    const jobs = await queryAll<{ kind: string; payload_json: string }>(
      db,
      `SELECT kind, payload_json FROM jobs WHERE workspace_id = ?`,
      [SEED.workspaceId],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe('crawl_site');

    // The crawl must know which campaign it belongs to, or it files its people
    // under whichever campaign happens to be oldest.
    const payload = JSON.parse(jobs[0]?.payload_json ?? '{}');
    expect(payload.campaignId).toBe(result.campaignId);
    expect(payload.url).toBe('https://brightsmile.com');
  });

  test('a description queues discovery instead', async () => {
    seeded = await seedDatabase('intake-keyword');
    const { db } = seeded;

    const result = await createCampaignFromIntake(db, ACTOR, 'dental practices in Austin');

    expect(result.kind).toBe('keyword');
    expect(result.queued).toBe(0);

    const job = await queryOne<{ kind: string; payload_json: string }>(
      db,
      `SELECT kind, payload_json FROM jobs WHERE workspace_id = ?`,
      [SEED.workspaceId],
    );
    expect(job?.kind).toBe('discover_domains');
    expect(JSON.parse(job?.payload_json ?? '{}').keyword).toBe('dental practices in Austin');
  });

  test('autopilot is opt-in and sets the approval mode the policy engine reads', async () => {
    seeded = await seedDatabase('intake-autopilot');
    const { db } = seeded;

    const off = await createCampaignFromIntake(db, ACTOR, 'acme.com');
    const on = await createCampaignFromIntake(db, ACTOR, 'other.com', { autopilot: true });

    const modes = await queryAll<{ id: string; approval_mode: string }>(
      db,
      `SELECT id, approval_mode FROM campaigns WHERE id IN (?, ?)`,
      [off.campaignId, on.campaignId],
    );

    const byId = new Map(modes.map((row) => [row.id, row.approval_mode]));
    expect(byId.get(off.campaignId)).toBe('draft_and_approve');
    expect(byId.get(on.campaignId)).toBe('trusted_automation');
  });

  test('a workspace with no offering still gets a campaign, and is told', async () => {
    seeded = await seedDatabase('intake-no-offering');
    const { db } = seeded;

    // `campaigns.offering_id` is NOT NULL, so without a placeholder the very
    // first thing a new account does would fail on a foreign key.
    await db.execute({ sql: `DELETE FROM campaigns`, args: [] });
    await db.execute({ sql: `DELETE FROM offerings`, args: [] });

    const result = await createCampaignFromIntake(db, ACTOR, 'acme.com');

    expect(result.needsProfile).toBe(true);
    expect(result.campaignId).toBeTruthy();
  });

  test('an existing offering is reused rather than duplicated', async () => {
    seeded = await seedDatabase('intake-reuse-offering');
    const { db } = seeded;

    await createCampaignFromIntake(db, ACTOR, 'acme.com');

    const offerings = await queryAll<{ id: string }>(
      db,
      `SELECT id FROM offerings WHERE workspace_id = ?`,
      [SEED.workspaceId],
    );
    expect(offerings).toHaveLength(1);
  });

  test('unusable input is rejected with something worth reading', async () => {
    seeded = await seedDatabase('intake-empty');
    const { db } = seeded;

    await expect(createCampaignFromIntake(db, ACTOR, '   ')).rejects.toBeInstanceOf(IntakeError);
  });

  test('the seed is recorded so a campaign traces back to what was typed', async () => {
    seeded = await seedDatabase('intake-seed');
    const { db } = seeded;

    const result = await createCampaignFromIntake(db, ACTOR, 'bike shops in Portland');

    const campaign = await queryOne<{ seed_kind: string; seed_value: string }>(
      db,
      `SELECT seed_kind, seed_value FROM campaigns WHERE id = ?`,
      [result.campaignId],
    );
    expect(campaign?.seed_kind).toBe('keyword');
    expect(campaign?.seed_value).toBe('bike shops in Portland');
  });
});

describe('setCampaignAutopilot', () => {
  test('switches the mode both ways', async () => {
    seeded = await seedDatabase('autopilot-toggle');
    const { db } = seeded;

    expect(await setCampaignAutopilot(db, SEED.workspaceId, SEED.campaignId, true)).toBe(true);
    expect(
      (
        await queryOne<{ approval_mode: string }>(
          db,
          `SELECT approval_mode FROM campaigns WHERE id = ?`,
          [SEED.campaignId],
        )
      )?.approval_mode,
    ).toBe('trusted_automation');

    await setCampaignAutopilot(db, SEED.workspaceId, SEED.campaignId, false);
    expect(
      (
        await queryOne<{ approval_mode: string }>(
          db,
          `SELECT approval_mode FROM campaigns WHERE id = ?`,
          [SEED.campaignId],
        )
      )?.approval_mode,
    ).toBe('draft_and_approve');
  });

  test('a campaign in another workspace is not reachable', async () => {
    seeded = await seedDatabase('autopilot-scope');
    const { db } = seeded;

    expect(await setCampaignAutopilot(db, 'wsp_other', SEED.campaignId, true)).toBe(false);
  });
});
