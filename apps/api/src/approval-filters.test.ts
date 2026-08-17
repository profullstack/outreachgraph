/**
 * Narrowing the queue to what can actually be approved.
 *
 * The queue was one undifferentiated list, which made it unusable in practice.
 * Production held 73 `refresh_research` cards — internal actions that have no
 * message by definition and never will — against a single email waiting for a
 * decision. Every one of the 73 renders as a card with nothing written on it,
 * so the page read as "the composer is broken" when it was really "you are
 * looking at the wrong 73 rows".
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { now, type Client } from '@outreachgraph/db';
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

interface Queue {
  recommendations: { id: string; action: string; bucket: string }[];
  counts: { all: number; ready: number; needs_draft: number; research: number };
  filter: string;
}

async function harness(label: string): Promise<{ app: Hono<AppEnv>; db: Client }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  return { app: createApp({ db: seeded.db, authenticate: async () => ACTOR }), db: seeded.db };
}

/** A pending recommendation of the given kind, with or without a draft. */
async function add(
  db: Client,
  id: string,
  action: string,
  network: string,
  withDraft: boolean,
): Promise<void> {
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
          network, priority, reason, trigger_signal_id, policy_status, policy_version,
          expected_goal, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 50, 'Queued.', ?, 'allow_with_approval', '2026-08-11',
          'start_conversation', 'pending', ?)`,
    args: [
      id,
      SEED.workspaceId,
      SEED.campaignId,
      SEED.personId,
      action,
      network,
      SEED.signalId,
      stamp,
    ],
  });

  if (withDraft) {
    await db.execute({
      sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, body, grounded_signal_ids,
            checks_json, created_at, updated_at)
            VALUES (?, ?, ?, 'A written message.', '[]', '[]', ?, ?)`,
      args: [`drf_${id}`, SEED.workspaceId, id, stamp, stamp],
    });
  }
}

async function queue(app: Hono<AppEnv>, filter?: string): Promise<Queue> {
  const suffix = filter ? `&filter=${filter}` : '';
  const response = await app.request(`/api/v1/recommendations?limit=50${suffix}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Queue;
}

describe('filtering the approval queue', () => {
  test('ready shows only outbound work that has a message written', async () => {
    const { app, db } = await harness('filter-ready');
    await add(db, 'rec_research_1', 'refresh_research', 'website', false);
    await add(db, 'rec_email_undrafted', 'send_email', 'email', false);
    await add(db, 'rec_email_drafted', 'send_email', 'email', true);

    const ready = await queue(app, 'ready');
    const ids = ready.recommendations.map((r) => r.id);

    expect(ids).toContain('rec_email_drafted');
    expect(ids).not.toContain('rec_email_undrafted');
    expect(ids).not.toContain('rec_research_1');
  });

  test('research is the bucket the blank cards belong in', async () => {
    const { app, db } = await harness('filter-research');
    await add(db, 'rec_research_1', 'refresh_research', 'website', false);
    await add(db, 'rec_email_drafted', 'send_email', 'email', true);

    const research = await queue(app, 'research');
    const ids = research.recommendations.map((r) => r.id);

    expect(ids).toContain('rec_research_1');
    expect(ids).not.toContain('rec_email_drafted');
  });

  test('needs_draft separates "no message yet" from "never has one"', async () => {
    const { app, db } = await harness('filter-needs-draft');
    await add(db, 'rec_research_1', 'refresh_research', 'website', false);
    await add(db, 'rec_email_undrafted', 'send_email', 'email', false);

    const pending = await queue(app, 'needs_draft');
    const ids = pending.recommendations.map((r) => r.id);

    // Both look blank on the page; only one of them is a problem.
    expect(ids).toContain('rec_email_undrafted');
    expect(ids).not.toContain('rec_research_1');
  });

  test('the counts are what tell you where the queue actually is', async () => {
    const { app, db } = await harness('filter-counts');
    await add(db, 'rec_research_1', 'refresh_research', 'website', false);
    await add(db, 'rec_research_2', 'refresh_research', 'website', false);
    await add(db, 'rec_email_drafted', 'send_email', 'email', true);

    const { counts } = await queue(app, 'all');

    // The seeded fixture contributes one drafted outbound card of its own.
    expect(counts.research).toBe(2);
    expect(counts.ready).toBeGreaterThanOrEqual(1);
    expect(counts.all).toBe(counts.ready + counts.needs_draft + counts.research);
  });

  /**
   * The page fetches `all` once and the tabs pick from it in the browser, so
   * the bucket on each row is what the tabs actually sort by. If it ever
   * disagreed with the counts the tabs would show a number next to a list
   * that contradicts it.
   */
  test('every card names its bucket, and the buckets add up to the counts', async () => {
    const { app, db } = await harness('filter-buckets');
    await add(db, 'rec_research_1', 'refresh_research', 'website', false);
    await add(db, 'rec_research_2', 'refresh_research', 'website', false);
    await add(db, 'rec_email_undrafted', 'send_email', 'email', false);
    await add(db, 'rec_email_drafted', 'send_email', 'email', true);

    const { recommendations, counts } = await queue(app, 'all');
    const bucketOf = (id: string) => recommendations.find((r) => r.id === id)?.bucket;

    expect(bucketOf('rec_research_1')).toBe('research');
    expect(bucketOf('rec_email_undrafted')).toBe('needs_draft');
    expect(bucketOf('rec_email_drafted')).toBe('ready');

    // What the client-side tabs do, done here: filtering by bucket has to
    // land on the same number the badge shows.
    for (const bucket of ['ready', 'needs_draft', 'research'] as const) {
      expect(recommendations.filter((r) => r.bucket === bucket)).toHaveLength(counts[bucket]);
    }
  });

  test('the bucket survives a narrowed query', async () => {
    const { app, db } = await harness('filter-buckets-narrowed');
    await add(db, 'rec_research_1', 'refresh_research', 'website', false);
    await add(db, 'rec_email_undrafted', 'send_email', 'email', false);

    // The bucket is computed in the SELECT, so narrowing the WHERE clause
    // shifts every placeholder after it — the classic way this breaks is a
    // filtered query binding the wrong arguments.
    const needsDraft = await queue(app, 'needs_draft');
    expect(needsDraft.recommendations.map((r) => r.id)).toContain('rec_email_undrafted');
    expect(needsDraft.recommendations.every((r) => r.bucket === 'needs_draft')).toBe(true);

    const research = await queue(app, 'research');
    expect(research.recommendations.map((r) => r.id)).toContain('rec_research_1');
    expect(research.recommendations.every((r) => r.bucket === 'research')).toBe(true);
  });

  test('an unknown filter shows the queue rather than failing', async () => {
    const { app, db } = await harness('filter-unknown');
    await add(db, 'rec_research_1', 'refresh_research', 'website', false);

    // A stale bookmark should not be a 400.
    const body = await queue(app, 'nonsense');
    expect(body.filter).toBe('all');
  });
});
