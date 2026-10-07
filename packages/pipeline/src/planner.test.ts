import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { runCadences } from './cadence-runner';
import { plannerOverview, runPlanner, setPlannerEnabled } from './planner';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

// Q1 M2: the case study to anyone who opened or clicked and never replied.
const FEBRUARY = new Date('2026-02-20T15:00:00Z');

/** Jane was emailed in January by the product's campaign and opened it. */
async function janeOpenedInJanuary(
  db: Client,
  options: { replied?: boolean; tracking?: boolean } = {},
): Promise<void> {
  const sentAt = '2026-01-15T15:00:00.000Z';
  const stamp = now();
  await db.batch([
    {
      sql: `UPDATE campaigns SET approval_mode = 'trusted_automation' WHERE id = ?`,
      args: [SEED.campaignId],
    },
    {
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
            confidence, source_type, verified_by, first_seen_at)
            VALUES ('sid_jane_email', ?, 'email', 'jane@acme.com', 'jane@acme.com', 0.9,
                    'public_web', '[]', ?)`,
      args: [SEED.personId, stamp],
    },
    {
      sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
            state, body, contact_address, occurred_at, recorded_at)
            VALUES ('int_jan', ?, ?, ?, 'email', 'outbound', 'sent', 'Hello', 'jane@acme.com', ?, ?)`,
      args: [SEED.workspaceId, SEED.personId, SEED.campaignId, sentAt, sentAt],
    },
    {
      sql: `INSERT INTO open_pixels (id, workspace_id, person_id, campaign_id, created_at)
            VALUES ('opx_jan', ?, ?, ?, ?)`,
      args: [SEED.workspaceId, SEED.personId, SEED.campaignId, sentAt],
    },
    {
      sql: `INSERT INTO email_opens (id, pixel_id, workspace_id, person_id, occurred_at)
            VALUES ('eop_jan', 'opx_jan', ?, ?, ?)`,
      args: [SEED.workspaceId, SEED.personId, '2026-01-15T16:00:00.000Z'],
    },
  ]);
  if (options.tracking !== false) {
    await db.execute({
      sql: `INSERT INTO workspace_settings (workspace_id, track_opens, created_at, updated_at)
            VALUES (?, 1, ?, ?)
            ON CONFLICT (workspace_id) DO UPDATE SET track_opens = 1`,
      args: [SEED.workspaceId, stamp, stamp],
    });
  }
  if (options.replied) {
    await db.execute({
      sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
            state, occurred_at, recorded_at)
            VALUES ('int_reply', ?, ?, ?, 'email', 'inbound', 'responded', ?, ?)`,
      args: [
        SEED.workspaceId,
        SEED.personId,
        SEED.campaignId,
        '2026-01-16T10:00:00.000Z',
        '2026-01-16T10:00:00.000Z',
      ],
    });
  }
}

describe('runPlanner', () => {
  test("launches the month's play from engagement, once", async () => {
    seeded = await seedDatabase('planner-launch');
    const { db } = seeded;
    await janeOpenedInJanuary(db);

    const launched = await runPlanner({ db, now: FEBRUARY }, SEED.workspaceId);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ playKey: 'case_study_non_responders', people: 1 });

    const campaign = await queryOne<{ name: string; approval_mode: string; seed_kind: string }>(
      db,
      'SELECT name, approval_mode, seed_kind FROM campaigns WHERE id = ?',
      [launched[0]!.campaignId!],
    );
    expect(campaign?.seed_kind).toBe('planner');
    // The product runs on autopilot, so the play does too.
    expect(campaign?.approval_mode).toBe('trusted_automation');
    expect(campaign?.name).toContain('Case study to non-responders (2026-02)');

    // Idempotent for the month.
    expect(await runPlanner({ db, now: FEBRUARY }, SEED.workspaceId)).toEqual([]);

    // The cadence writes a card the composer can ground: it carries a signal.
    await runCadences(
      { db, platformEmailEnabled: true, now: new Date(FEBRUARY.getTime() + 1000) },
      SEED.workspaceId,
    );
    const card = await queryOne<{ guidance: string; trigger_signal_id: string | null }>(
      db,
      `SELECT guidance, trigger_signal_id FROM recommendations WHERE campaign_id = ?`,
      [launched[0]!.campaignId!],
    );
    expect(card?.guidance).toContain('Value first');
    expect(card?.trigger_signal_id).toBe(SEED.signalId);
  });

  test('without open or link tracking, delivered and unanswered is the segment', async () => {
    seeded = await seedDatabase('planner-blind');
    const { db } = seeded;
    await janeOpenedInJanuary(db, { tracking: false });
    // The open on record is not evidence when nothing is tracked; the
    // delivery and the silence are, and that is enough for the play.
    await db.execute({ sql: `DELETE FROM email_opens`, args: [] });

    const launched = await runPlanner({ db, now: FEBRUARY }, SEED.workspaceId);
    expect(launched[0]).toMatchObject({ playKey: 'case_study_non_responders', people: 1 });
    expect((await plannerOverview(db, SEED.workspaceId, FEBRUARY)).tracksEngagement).toBe(false);
  });

  test('with tracking on, someone who never opened is not "engaged"', async () => {
    seeded = await seedDatabase('planner-tracked-unopened');
    const { db } = seeded;
    await janeOpenedInJanuary(db);
    await db.execute({ sql: `DELETE FROM email_opens`, args: [] });

    expect(await runPlanner({ db, now: FEBRUARY }, SEED.workspaceId)).toEqual([]);
  });

  test('someone who replied is not a non-responder', async () => {
    seeded = await seedDatabase('planner-replied');
    const { db } = seeded;
    await janeOpenedInJanuary(db, { replied: true });

    expect(await runPlanner({ db, now: FEBRUARY }, SEED.workspaceId)).toEqual([]);
  });

  test('a product with the planner off gets nothing; the overview says so', async () => {
    seeded = await seedDatabase('planner-off');
    const { db } = seeded;
    await janeOpenedInJanuary(db);
    await setPlannerEnabled(db, SEED.workspaceId, SEED.offeringId, false);

    expect(await runPlanner({ db, now: FEBRUARY }, SEED.workspaceId)).toEqual([]);

    const overview = await plannerOverview(db, SEED.workspaceId, FEBRUARY);
    expect(overview.label).toBe('Case study to non-responders');
    expect(overview.next.label).toBe('Roundtable invite to slow movers');
    expect(overview.offerings[0]?.enabled).toBe(false);
  });

  test('list-refresh months make URL and keyword campaigns due for a reseed', async () => {
    seeded = await seedDatabase('planner-refresh');
    const { db } = seeded;
    await janeOpenedInJanuary(db);
    await db.execute({
      sql: `UPDATE campaigns SET seed_kind = 'url', seed_value = 'https://acme.com',
            status = 'active', reseeded_at = ? WHERE id = ?`,
      args: [now(), SEED.campaignId],
    });

    // January is Q1 M1: build fresh lists.
    const launched = await runPlanner(
      { db, now: new Date('2026-01-25T15:00:00Z') },
      SEED.workspaceId,
    );
    expect(launched.map((run) => run.playKey)).toEqual(['refresh_lists']);
    const row = await queryOne<{ reseeded_at: string }>(
      db,
      'SELECT reseeded_at FROM campaigns WHERE id = ?',
      [SEED.campaignId],
    );
    expect(row?.reseeded_at.startsWith('1970')).toBe(true);

    const runs = await queryAll<{ play_key: string }>(db, 'SELECT play_key FROM planner_runs');
    expect(runs.map((run) => run.play_key)).toEqual(['refresh_lists']);
  });
});
