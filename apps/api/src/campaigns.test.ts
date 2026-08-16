import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';
import {
  archiveCampaign,
  createCampaignFromIntake,
  IntakeError,
  listCampaigns,
  renameCampaign,
  setCampaignAutopilot,
  setCampaignStatus,
} from './campaigns';

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

describe('running more than one campaign', () => {
  test('each intake creates its own campaign rather than reusing one', async () => {
    seeded = await seedDatabase('campaigns-many');
    const { db } = seeded;

    const first = await createCampaignFromIntake(db, ACTOR, 'https://brightsmile.com');
    const second = await createCampaignFromIntake(db, ACTOR, 'plumbers in Leeds');

    expect(first.campaignId).not.toBe(second.campaignId);

    const summaries = await listCampaigns(db, SEED.workspaceId);
    // Plus the one the fixture seeds.
    expect(summaries).toHaveLength(3);
  });

  test('the list carries the counts needed to choose between them', async () => {
    seeded = await seedDatabase('campaigns-counts');
    const summaries = await listCampaigns(seeded.db, SEED.workspaceId);
    const seededCampaign = summaries.find((row) => row.id === SEED.campaignId);

    // A bare list of names cannot answer "which of these is doing anything",
    // which is the only question worth asking once there are several.
    expect(seededCampaign?.people).toBeGreaterThanOrEqual(1);
    expect(seededCampaign?.awaiting_approval).toBeGreaterThanOrEqual(1);
    expect(typeof seededCampaign?.jobs_pending).toBe('number');
  });

  test('a campaign with no leads still appears', async () => {
    // The counts are correlated subqueries rather than joins precisely so this
    // holds; a LEFT JOIN with GROUP BY drops or multiplies rows here.
    seeded = await seedDatabase('campaigns-empty');
    const created = await createCampaignFromIntake(seeded.db, ACTOR, 'https://nobody.example');

    const summaries = await listCampaigns(seeded.db, SEED.workspaceId);
    const fresh = summaries.find((row) => row.id === created.campaignId);

    expect(fresh).toBeDefined();
    expect(fresh?.people).toBe(0);
  });

  test('pausing stops the campaign without touching autopilot', async () => {
    seeded = await seedDatabase('campaigns-pause');
    const { db } = seeded;

    await setCampaignAutopilot(db, SEED.workspaceId, SEED.campaignId, true);
    expect(await setCampaignStatus(db, SEED.workspaceId, SEED.campaignId, 'paused')).toBe(true);

    const row = await queryOne<{ status: string; approval_mode: string }>(
      db,
      `SELECT status, approval_mode FROM campaigns WHERE id = ?`,
      [SEED.campaignId],
    );

    // Two separate controls: one stops sending, the other stops the work.
    expect(row?.status).toBe('paused');
    expect(row?.approval_mode).toBe('trusted_automation');
  });

  test('archiving cancels the work already queued', async () => {
    seeded = await seedDatabase('campaigns-archive');
    const { db } = seeded;

    const created = await createCampaignFromIntake(db, ACTOR, 'https://brightsmile.com');
    expect(await archiveCampaign(db, SEED.workspaceId, created.campaignId)).toBe(true);

    const pending = await queryAll<{ id: string }>(
      db,
      `SELECT id FROM jobs WHERE workspace_id = ? AND status = 'pending'`,
      [SEED.workspaceId],
    );

    // Otherwise an archived campaign keeps crawling for hours: the jobs were
    // queued before the archive and know nothing about it.
    expect(pending).toHaveLength(0);
  });

  test('will not touch a campaign in another workspace', async () => {
    seeded = await seedDatabase('campaigns-tenant');
    const { db } = seeded;

    expect(await setCampaignStatus(db, 'wsp_other', SEED.campaignId, 'paused')).toBe(false);
    expect(await archiveCampaign(db, 'wsp_other', SEED.campaignId)).toBe(false);
    expect(await renameCampaign(db, 'wsp_other', SEED.campaignId, 'Hijacked')).toBe(false);
  });

  test('renaming refuses an empty name rather than blanking the row', async () => {
    seeded = await seedDatabase('campaigns-rename');
    const { db } = seeded;

    expect(await renameCampaign(db, SEED.workspaceId, SEED.campaignId, '   ')).toBe(false);
    expect(await renameCampaign(db, SEED.workspaceId, SEED.campaignId, 'Renamed')).toBe(true);

    const row = await queryOne<{ name: string }>(db, `SELECT name FROM campaigns WHERE id = ?`, [
      SEED.campaignId,
    ]);
    expect(row?.name).toBe('Renamed');
  });
});
