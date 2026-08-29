import { afterEach, describe, expect, test } from 'bun:test';
import { queryOne } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  claimNext,
  completeJob,
  drainQueue,
  enqueue,
  failJob,
  queueDepth,
  reclaimStalled,
} from './queue';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function setup(label: string): Promise<SeededDatabase> {
  seeded = await seedDatabase(label);
  return seeded;
}

describe('enqueue', () => {
  test('a queued job comes back with its payload intact', async () => {
    const { db } = await setup('queue-roundtrip');

    const added = await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'rescore_prospect',
      payload: { personId: 'p_1', nested: { ok: true } },
    });

    expect(added.queued).toBe(true);

    const job = await claimNext(db);
    expect(job?.id).toBe(added.id!);
    expect(job?.kind).toBe('rescore_prospect');
    expect(job?.payload).toEqual({ personId: 'p_1', nested: { ok: true } });
    expect(job?.attempts).toBe(1);
  });

  test('a duplicate dedupe key is reported, not thrown', async () => {
    const { db } = await setup('queue-dedupe');

    const first = await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'refresh_signals',
      dedupeKey: 'https://example.com',
    });
    const second = await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'refresh_signals',
      dedupeKey: 'https://example.com',
    });

    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    expect(second.id).toBeUndefined();

    expect((await queueDepth(db)).pending).toBe(1);
  });

  test('the same key can be queued again once the first job has finished', async () => {
    const { db } = await setup('queue-dedupe-expiry');

    const first = await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'refresh_signals',
      dedupeKey: 'https://example.com',
    });
    await completeJob(db, first.id!);

    // This is the point of the partial index: it guards outstanding work, not
    // all history. A site crawled last week must be crawlable again today.
    const again = await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'refresh_signals',
      dedupeKey: 'https://example.com',
    });

    expect(again.queued).toBe(true);
  });

  test('a delayed job is not claimable yet', async () => {
    const { db } = await setup('queue-delay');

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'poll_drop',
      delayMs: 60_000,
    });

    expect(await claimNext(db)).toBeUndefined();
  });
});

describe('claimNext', () => {
  test('a claim cannot be taken twice', async () => {
    const { db } = await setup('queue-claim-once');

    await enqueue(db, { workspaceId: SEED.workspaceId, kind: 'rescore_prospect' });

    const first = await claimNext(db);
    const second = await claimNext(db);

    expect(first).toBeDefined();
    // The whole point of the conditional update: the row is no longer pending,
    // so a second worker sees an empty queue rather than the same job.
    expect(second).toBeUndefined();
  });

  test('the oldest runnable job goes first', async () => {
    const { db } = await setup('queue-order');

    const soon = await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'rescore_prospect',
      payload: { which: 'soon' },
    });
    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'rescore_prospect',
      payload: { which: 'later' },
      delayMs: 30_000,
    });

    const job = await claimNext(db);
    expect(job?.id).toBe(soon.id!);
  });
});

describe('failJob', () => {
  test('a failure below the cap is rescheduled, not lost', async () => {
    const { db } = await setup('queue-retry');

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'rescore_prospect',
      maxAttempts: 3,
    });

    const job = await claimNext(db);
    const outcome = await failJob(db, job!, new Error('github said 502'));

    expect(outcome).toBe('retry');

    const row = await queryOne<{ status: string; run_after: string; last_error: string }>(
      db,
      'SELECT status, run_after, last_error FROM jobs WHERE id = ?',
      [job!.id],
    );

    expect(row?.status).toBe('pending');
    expect(row?.last_error).toContain('502');
    // Backed off into the future, so the next tick does not immediately retry.
    expect(new Date(row!.run_after).getTime()).toBeGreaterThan(Date.now());
  });

  test('the last attempt marks the job failed and keeps the reason', async () => {
    const { db } = await setup('queue-dead');

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'rescore_prospect',
      maxAttempts: 1,
    });

    const job = await claimNext(db);
    const outcome = await failJob(db, job!, new Error('unparseable homepage'));

    expect(outcome).toBe('dead');

    const row = await queryOne<{ status: string; last_error: string; payload_json: string }>(
      db,
      'SELECT status, last_error, payload_json FROM jobs WHERE id = ?',
      [job!.id],
    );

    expect(row?.status).toBe('failed');
    // A dead job is kept, not deleted — otherwise "why did that URL never
    // produce a card" is unanswerable.
    expect(row?.last_error).toContain('unparseable homepage');
  });
});

describe('reclaimStalled', () => {
  test('a job abandoned by a dead worker returns to the queue', async () => {
    const { db } = await setup('queue-reclaim');

    await enqueue(db, { workspaceId: SEED.workspaceId, kind: 'rescore_prospect' });
    const job = await claimNext(db);

    // Stand in for a container replaced mid-job: the row is running and the
    // process that owned it is gone.
    await db.execute({
      sql: 'UPDATE jobs SET started_at = ? WHERE id = ?',
      args: [new Date(Date.now() - 3_600_000).toISOString(), job!.id],
    });

    expect(await reclaimStalled(db)).toBe(1);

    const again = await claimNext(db);
    expect(again?.id).toBe(job!.id);
    // The attempt is not refunded: a payload that kills its worker must still
    // run out of attempts rather than looping forever.
    expect(again?.attempts).toBe(2);
  });

  test('a job still inside its lease is left alone', async () => {
    const { db } = await setup('queue-lease');

    await enqueue(db, { workspaceId: SEED.workspaceId, kind: 'rescore_prospect' });
    await claimNext(db);

    expect(await reclaimStalled(db)).toBe(0);
  });
});

describe('drainQueue', () => {
  test('it runs the pending jobs and reports what happened', async () => {
    const { db } = await setup('queue-drain');

    await enqueue(db, { workspaceId: SEED.workspaceId, kind: 'rescore_prospect' });
    await enqueue(db, { workspaceId: SEED.workspaceId, kind: 'refresh_signals' });

    const seen: string[] = [];
    const summary = await drainQueue(db, async (job) => {
      seen.push(job.kind);
    });

    expect(seen.sort()).toEqual(['refresh_signals', 'rescore_prospect']);
    expect(summary.processed).toBe(2);
    expect(summary.succeeded).toBe(2);
    expect((await queueDepth(db)).done).toBe(2);
  });

  test('one throwing handler does not stop the rest of the tick', async () => {
    const { db } = await setup('queue-drain-throw');

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'rescore_prospect',
      payload: { boom: true },
      maxAttempts: 1,
    });
    await enqueue(db, { workspaceId: SEED.workspaceId, kind: 'refresh_signals' });

    const summary = await drainQueue(db, async (job) => {
      if (job.payload.boom) throw new Error('handler blew up');
    });

    expect(summary.processed).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.dead).toBe(1);
  });

  test('the limit bounds how much one tick does', async () => {
    const { db } = await setup('queue-limit');

    for (let i = 0; i < 5; i += 1) {
      await enqueue(db, {
        workspaceId: SEED.workspaceId,
        kind: 'rescore_prospect',
        payload: { i },
      });
    }

    const summary = await drainQueue(db, async () => {}, { limit: 2 });

    expect(summary.processed).toBe(2);
    expect((await queueDepth(db)).pending).toBe(3);
  });
});

describe('failJob during an outage', () => {
  // Every failure here is the shared model chain refusing everybody, which is
  // what the real incident looked like: a 400 carrying a billing message.
  const outOfBudget = (error: unknown): boolean => String(error).includes('usage limits');

  test('an outage does not spend the last attempt', async () => {
    const { db } = await setup('queue-outage-refund');

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'crawl_site',
      maxAttempts: 1,
    });

    // Claiming charges the attempt up front, so this job is on its last one —
    // the exact state in which the incident killed 4,888 rows.
    const job = await claimNext(db);
    expect(job?.attempts).toBe(1);

    const outcome = await failJob(
      db,
      job!,
      new Error('You have reached your specified API usage limits.'),
      outOfBudget,
    );

    expect(outcome).toBe('deferred');

    const row = await queryOne<{ status: string; attempts: number; run_after: string }>(
      db,
      'SELECT status, attempts, run_after FROM jobs WHERE id = ?',
      [job!.id],
    );

    // Alive, and with its attempt handed back rather than burnt on an outage.
    expect(row?.status).toBe('pending');
    expect(Number(row?.attempts)).toBe(0);
    // Held for a while, so a provider that has already said no is not asked
    // again on the very next tick.
    expect(new Date(row!.run_after).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  test('a genuine fault still dies, outage check or not', async () => {
    const { db } = await setup('queue-outage-not-everything');

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'crawl_site',
      maxAttempts: 1,
    });

    const job = await claimNext(db);
    const outcome = await failJob(db, job!, new Error('unparseable homepage'), outOfBudget);

    // The refund is for outages only; widening it would let a poisonous payload
    // retry forever.
    expect(outcome).toBe('dead');

    const row = await queryOne<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', [
      job!.id,
    ]);

    expect(row?.status).toBe('failed');
  });

  test('one outage holds the rest of the tick instead of burning it', async () => {
    const { db } = await setup('queue-outage-stops-tick');

    for (let i = 0; i < 4; i += 1) {
      await enqueue(db, {
        workspaceId: SEED.workspaceId,
        kind: 'crawl_site',
        payload: { i },
        maxAttempts: 3,
      });
    }

    let calls = 0;
    const summary = await drainQueue(
      db,
      async () => {
        calls += 1;
        throw new Error('You have reached your specified API usage limits.');
      },
      { isOutage: outOfBudget },
    );

    // The outage is global, so there was no point in asking four times.
    expect(calls).toBe(1);
    expect(summary.processed).toBe(1);
    expect(summary.deferred).toBe(1);
    expect(summary.dead).toBe(0);

    // Nothing died, and the queue is intact for when the budget returns.
    const depth = await queueDepth(db);
    expect(depth.failed).toBe(0);
    expect(depth.pending).toBe(4);
  });
});
