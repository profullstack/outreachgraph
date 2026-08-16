/**
 * The progress ledger.
 *
 * Two properties carry the whole feature: the cursor never replays or skips an
 * event, and emitting can never break the work it describes.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { emitEvent, pruneWorkflowEvents, readEvents, workflowStatus } from './events';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const WS = SEED.workspaceId;

describe('emitEvent', () => {
  test('records a line of progress', async () => {
    seeded = await seedDatabase('events-emit');
    await emitEvent(seeded.db, { workspaceId: WS, phase: 'crawl', message: 'Reading example.com' });

    const events = await readEvents(seeded.db, { workspaceId: WS });
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toBe('Reading example.com');
    expect(events[0]?.level).toBe('info');
  });

  test('never throws, whatever the database does', async () => {
    seeded = await seedDatabase('events-safe');
    await seeded.db.execute(`DROP TABLE workflow_events`);

    // A crawl that completes its work and then dies writing a progress row —
    // leaving the job to retry the entire fetch — is strictly worse than a
    // missing line in a feed.
    await emitEvent(seeded.db, { workspaceId: WS, phase: 'crawl', message: 'x' });
  });

  test('truncates a runaway message rather than storing it whole', async () => {
    seeded = await seedDatabase('events-long');
    await emitEvent(seeded.db, { workspaceId: WS, phase: 'send', message: 'x'.repeat(5_000) });

    expect((await readEvents(seeded.db, { workspaceId: WS }))[0]?.message).toHaveLength(500);
  });
});

describe('readEvents', () => {
  async function fill(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await emitEvent(seeded!.db, { workspaceId: WS, phase: 'crawl', message: `event ${index}` });
    }
  }

  test('returns the newest page when there is no cursor', async () => {
    seeded = await seedDatabase('events-newest');
    await fill(10);

    const events = await readEvents(seeded.db, { workspaceId: WS, limit: 3 });

    // Oldest-first within the page, but it is the *latest* three: someone
    // opening the app wants recent history, not the first thing that ever
    // happened in the workspace.
    expect(events.map((event) => event.message)).toEqual(['event 7', 'event 8', 'event 9']);
  });

  test('resumes from a cursor without replaying or skipping', async () => {
    seeded = await seedDatabase('events-cursor');
    await fill(6);

    const first = await readEvents(seeded.db, { workspaceId: WS, limit: 6 });
    const cursor = first[2]?.seq ?? 0;
    const rest = await readEvents(seeded.db, { workspaceId: WS, sinceSeq: cursor });

    expect(rest.map((event) => event.message)).toEqual(['event 3', 'event 4', 'event 5']);
    // Strictly greater than the cursor — an inclusive bound would redeliver the
    // last event on every reconnect.
    expect(rest.every((event) => event.seq > cursor)).toBe(true);
  });

  test('scopes to one campaign when asked', async () => {
    seeded = await seedDatabase('events-campaign');
    await emitEvent(seeded.db, {
      workspaceId: WS,
      campaignId: SEED.campaignId,
      phase: 'crawl',
      message: 'in the campaign',
    });
    // Workspace-level progress — a mail server test, say — belongs to no
    // campaign and must not appear when one is selected.
    await emitEvent(seeded.db, { workspaceId: WS, phase: 'system', message: 'workspace wide' });

    const events = await readEvents(seeded.db, { workspaceId: WS, campaignId: SEED.campaignId });
    expect(events.map((event) => event.message)).toEqual(['in the campaign']);
  });

  test('does not return another workspace’s events', async () => {
    seeded = await seedDatabase('events-tenant');
    await emitEvent(seeded.db, { workspaceId: WS, phase: 'crawl', message: 'mine' });

    expect(await readEvents(seeded.db, { workspaceId: 'wsp_other' })).toHaveLength(0);
  });

  test('survives a detail column that will not parse', async () => {
    seeded = await seedDatabase('events-baddetail');
    await emitEvent(seeded.db, { workspaceId: WS, phase: 'crawl', message: 'still readable' });
    await seeded.db.execute(`UPDATE workflow_events SET detail_json = 'not json'`);

    const events = await readEvents(seeded.db, { workspaceId: WS });
    expect(events[0]?.message).toBe('still readable');
    expect(events[0]?.detail).toEqual({});
  });
});

describe('workflowStatus', () => {
  test('reports an empty workspace without dividing by nothing', async () => {
    seeded = await seedDatabase('status-empty');
    const status = await workflowStatus(seeded.db, WS);

    expect(status.queue.pending).toBe(0);
    expect(status.busy).toBe(false);
    expect(status.sending.configured).toBe(false);
    expect(status.sending.dailyCap).toBe(25);
  });

  test('counts outstanding work by kind', async () => {
    seeded = await seedDatabase('status-queue');
    await seeded.db.execute({
      sql: `INSERT INTO jobs (id, workspace_id, kind, status, run_after, created_at, updated_at)
            VALUES ('job_1', ?, 'crawl_site', 'pending', ?, ?, ?),
                   ('job_2', ?, 'crawl_site', 'running', ?, ?, ?),
                   ('job_3', ?, 'discover_domains', 'pending', ?, ?, ?)`,
      args: Array.from({ length: 3 }).flatMap(() => [
        WS,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      ]),
    });

    const status = await workflowStatus(seeded.db, WS);

    expect(status.queue.pending).toBe(2);
    expect(status.queue.running).toBe(1);
    expect(status.queue.byKind.crawl_site).toBe(2);
    expect(status.busy).toBe(true);
  });

  test('reports whether sending is verified, not merely configured', async () => {
    seeded = await seedDatabase('status-sending');
    await seeded.db.execute({
      sql: `INSERT INTO email_accounts (id, workspace_id, provider, from_email, status,
              created_at, updated_at)
            VALUES ('eml_1', ?, 'smtp', 'a@b.com', 'unverified', ?, ?)`,
      args: [WS, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    });

    const status = await workflowStatus(seeded.db, WS);
    expect(status.sending.configured).toBe(true);
    expect(status.sending.verified).toBe(false);
  });
});

describe('pruneWorkflowEvents', () => {
  test('removes progress lines nobody will read again', async () => {
    seeded = await seedDatabase('events-prune');
    await emitEvent(seeded.db, { workspaceId: WS, phase: 'crawl', message: 'old' });
    await seeded.db.execute(`UPDATE workflow_events SET occurred_at = '2020-01-01T00:00:00.000Z'`);
    await emitEvent(seeded.db, { workspaceId: WS, phase: 'crawl', message: 'new' });

    expect(await pruneWorkflowEvents(seeded.db, 14)).toBe(1);
    expect((await readEvents(seeded.db, { workspaceId: WS })).map((e) => e.message)).toEqual([
      'new',
    ]);
  });
});
