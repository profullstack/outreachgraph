/**
 * The durable job queue.
 *
 * Enqueue is cheap and synchronous; everything expensive happens later on the
 * worker tick. That split is what lets a hundred URLs be accepted in one
 * request without any of them being crawled inside it.
 *
 * The functions here deal only in rows and state transitions — they never know
 * what a job *does*. `drainQueue` takes a handler, so the pipeline can supply
 * behaviour without this module importing it and the tests can supply a stub.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { type JobKind } from './jobs';

export const JOB_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** First retry waits this long; each further attempt doubles it. */
const BASE_BACKOFF_MS = 30_000;

/** Ceiling on the doubling, so attempt 20 is not scheduled for next year. */
const MAX_BACKOFF_MS = 3_600_000;

/**
 * How long a job waits after a failure that was not its own fault.
 *
 * Flat rather than doubling, because there is no escalating suspicion to
 * express: the job is fine and the world is not. Ten minutes is long enough
 * that a provider which has already refused everyone is not asked again every
 * tick, and short enough that the queue comes back to life within minutes of
 * the outage clearing rather than within the hour.
 */
const OUTAGE_BACKOFF_MS = 600_000;

/**
 * How long a claimed job may stay `running` before it is considered abandoned.
 *
 * Generous on purpose: the cost of reclaiming too early is running a job twice,
 * which is worse than running it late. Deploys are the common cause — the
 * container is replaced mid-job and nothing ever writes the row back.
 */
const LEASE_MS = 900_000;

export interface QueuedJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: JobKind;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface EnqueueInput {
  readonly workspaceId: string;
  readonly kind: JobKind;
  readonly payload?: Record<string, unknown>;
  /** Delay before the job first becomes runnable. */
  readonly delayMs?: number;
  readonly maxAttempts?: number;
  /** Suppresses a duplicate while an identical job is still outstanding. */
  readonly dedupeKey?: string;
  /** Groups this job with the rest of one bulk submission. */
  readonly batchId?: string;
}

export interface EnqueueResult {
  readonly id?: string;
  /** False when an identical job was already queued or running. */
  readonly queued: boolean;
}

function plus(stamp: string, ms: number): string {
  return new Date(new Date(stamp).getTime() + ms).toISOString();
}

/**
 * Adds one job.
 *
 * A duplicate is a normal outcome rather than an error: pasting the same URL
 * twice in one batch should enqueue it once and report that plainly, not fail
 * the whole batch. The unique index is what decides, so two callers racing
 * still produce one job.
 */
export async function enqueue(db: Client, input: EnqueueInput): Promise<EnqueueResult> {
  const stamp = now();
  const id = newId('job');

  try {
    await db.execute({
      sql: `INSERT INTO jobs (id, workspace_id, kind, payload_json, status, attempts,
              max_attempts, run_after, dedupe_key, batch_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.workspaceId,
        input.kind,
        JSON.stringify(input.payload ?? {}),
        input.maxAttempts ?? 5,
        plus(stamp, input.delayMs ?? 0),
        input.dedupeKey ?? null,
        input.batchId ?? null,
        stamp,
        stamp,
      ],
    });
  } catch (error) {
    // Only the dedupe index can reject an insert here — every other column is
    // supplied. Anything else is a real fault and must not be swallowed.
    if (isUniqueViolation(error)) return { queued: false };
    throw error;
  }

  return { id, queued: true };
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed');
}

/**
 * Takes the oldest runnable job and marks it running, in one statement.
 *
 * The `UPDATE … WHERE id = (SELECT …)` shape is what makes the claim atomic:
 * two workers cannot both win, because the second one's `status = 'pending'`
 * predicate no longer matches. One replica runs today, so this is not yet
 * load-bearing — but it costs nothing now and `numReplicas` will not stay at 1
 * forever, and a queue that quietly double-runs jobs is a bad thing to discover
 * later.
 */
export async function claimNext(db: Client, workspaceId?: string): Promise<QueuedJob | undefined> {
  const stamp = now();
  const scope = workspaceId ? 'AND workspace_id = ?' : '';
  const args = workspaceId ? [stamp, stamp, stamp, workspaceId] : [stamp, stamp, stamp];

  const row = await queryOne<{
    id: string;
    workspace_id: string;
    kind: string;
    payload_json: string;
    attempts: number;
    max_attempts: number;
  }>(
    db,
    `UPDATE jobs
        SET status = 'running', attempts = attempts + 1,
            started_at = ?, updated_at = ?
      WHERE id = (
        SELECT id FROM jobs
         WHERE status = 'pending' AND run_after <= ? ${scope}
         ORDER BY run_after, created_at
         LIMIT 1
      )
  RETURNING id, workspace_id, kind, payload_json, attempts, max_attempts`,
    args,
  );

  if (!row) return undefined;

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    // The column is text; `JobKind` is a compile-time convenience. Whatever is
    // stored is passed through unchanged, so a kind this build does not know
    // about is reported by its real name in the dispatcher's error rather than
    // quietly becoming some other job.
    kind: row.kind as JobKind,
    payload: safeParse(row.payload_json),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function completeJob(db: Client, id: string): Promise<void> {
  const stamp = now();
  await db.execute({
    sql: `UPDATE jobs SET status = 'done', finished_at = ?, updated_at = ?, last_error = NULL
           WHERE id = ?`,
    args: [stamp, stamp, id],
  });
}

export type FailOutcome = 'retry' | 'dead' | 'deferred';

/**
 * Recognises a failure caused by shared infrastructure rather than by this job.
 *
 * Injected rather than imported so this module keeps knowing nothing about what
 * a job actually does: the server passes `isBudgetExhausted`, and a test passes
 * whatever it needs to.
 */
export type OutageCheck = (error: unknown) => boolean;

/**
 * Records a failed attempt, and either schedules a retry or gives up.
 *
 * Giving up is a state, not a deletion: a `failed` row keeps its payload and
 * its last error, which is the only way to answer "why did that URL never
 * produce a card".
 */
export async function failJob(
  db: Client,
  job: QueuedJob,
  error: unknown,
  isOutage?: OutageCheck,
): Promise<FailOutcome> {
  const stamp = now();
  const message = error instanceof Error ? error.message : String(error);

  // A job must not be charged an attempt for someone else's outage. Charging it
  // is how three days of exhausted model budget silently emptied the queue:
  // every job burned through `max_attempts` against providers that were
  // refusing everybody, and nothing ever brings a `failed` row back, so the
  // pipeline reached a fixed point it could not leave once the budget returned.
  //
  // Refunding is safe here in a way it deliberately is not in `reclaimStalled`:
  // there the suspect is the payload, and the evidence is that this job killed
  // its container. Here the evidence points the other way — every other job in
  // the queue is failing identically, which is precisely what makes the payload
  // innocent.
  if (isOutage?.(error)) {
    await db.execute({
      sql: `UPDATE jobs SET status = 'pending', attempts = MAX(attempts - 1, 0),
              last_error = ?, run_after = ?, started_at = NULL, updated_at = ?
             WHERE id = ?`,
      args: [message.slice(0, 2000), plus(stamp, OUTAGE_BACKOFF_MS), stamp, job.id],
    });

    return 'deferred';
  }

  const exhausted = job.attempts >= job.maxAttempts;

  if (exhausted) {
    await db.execute({
      sql: `UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ?
             WHERE id = ?`,
      args: [message.slice(0, 2000), stamp, stamp, job.id],
    });
    return 'dead';
  }

  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (job.attempts - 1), MAX_BACKOFF_MS);

  await db.execute({
    sql: `UPDATE jobs SET status = 'pending', last_error = ?, run_after = ?,
            started_at = NULL, updated_at = ?
           WHERE id = ?`,
    args: [message.slice(0, 2000), plus(stamp, backoff), stamp, job.id],
  });

  return 'retry';
}

/**
 * Returns jobs abandoned by a dead worker to the queue.
 *
 * The attempt is not refunded — a job that reliably kills its container would
 * otherwise retry forever, which is how one poisonous payload takes down a
 * deployment.
 */
export async function reclaimStalled(db: Client, leaseMs = LEASE_MS): Promise<number> {
  const stamp = now();
  const cutoff = plus(stamp, -leaseMs);

  const stalled = await queryAll<{ id: string }>(
    db,
    `SELECT id FROM jobs WHERE status = 'running' AND started_at IS NOT NULL
       AND started_at < ?`,
    [cutoff],
  );

  if (stalled.length === 0) return 0;

  await db.execute({
    sql: `UPDATE jobs
             SET status = 'pending', started_at = NULL, updated_at = ?,
                 last_error = 'reclaimed after lease expiry'
           WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`,
    args: [stamp, cutoff],
  });

  return stalled.length;
}

export type JobHandler = (job: QueuedJob) => Promise<void>;

export interface DrainSummary {
  readonly processed: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly dead: number;
  /** Put back untouched because the failure was an outage, not a fault. */
  readonly deferred: number;
  readonly reclaimed: number;
}

export interface DrainOptions {
  /** Ceiling on how many jobs one tick runs. */
  readonly limit?: number;
  /** Recognises a failure that means "not this job's fault". */
  readonly isOutage?: OutageCheck;
}

/**
 * Runs up to `limit` jobs, one at a time.
 *
 * Serial by design. The work behind these jobs is rate-limited by other
 * people's services — GitHub's quota, a crawl politeness delay, the model API —
 * so concurrency here would only move the queue from this process into someone
 * else's 429s. `limit` is the real throttle, and it bounds how long one tick
 * can hold the loop.
 */
export async function drainQueue(
  db: Client,
  handler: JobHandler,
  options: DrainOptions = {},
): Promise<DrainSummary> {
  const { limit = 25, isOutage } = options;

  const reclaimed = await reclaimStalled(db);
  let processed = 0;
  let succeeded = 0;
  let retried = 0;
  let dead = 0;
  let deferred = 0;

  for (let i = 0; i < limit; i += 1) {
    const job = await claimNext(db);
    if (!job) break;

    processed += 1;

    try {
      await handler(job);
      await completeJob(db, job.id);
      succeeded += 1;
    } catch (error) {
      // A handler throwing is an expected outcome, not a bug in the loop: it is
      // how a job says "not this time". The tick must survive it.
      const outcome = await failJob(db, job, error, isOutage);

      if (outcome === 'dead') {
        dead += 1;
      } else if (outcome === 'deferred') {
        deferred += 1;
        // An outage is global by definition, so every remaining job would fail
        // the same way. Stopping now spares the rest of the tick and, more to
        // the point, stops us asking a provider that has already said no.
        break;
      } else {
        retried += 1;
      }
    }
  }

  return { processed, succeeded, retried, dead, deferred, reclaimed };
}

export interface BatchItem {
  readonly id: string;
  readonly status: JobStatus;
  readonly attempts: number;
  /** The URL this job was created for, when it has one. */
  readonly url?: string;
  readonly lastError?: string;
}

export interface BatchStatus {
  readonly batchId: string;
  readonly total: number;
  readonly pending: number;
  readonly running: number;
  readonly done: number;
  readonly failed: number;
  readonly items: readonly BatchItem[];
}

/**
 * Progress for one bulk submission.
 *
 * Returns the individual rows rather than only the counts, because the useful
 * question after a hundred URLs is not "how many failed" but "which ones, and
 * why" — and that answer lives in each row's `last_error`.
 */
export async function batchStatus(
  db: Client,
  workspaceId: string,
  batchId: string,
): Promise<BatchStatus | undefined> {
  const rows = await queryAll<{
    id: string;
    status: string;
    attempts: number;
    payload_json: string;
    last_error: string | null;
  }>(
    db,
    `SELECT id, status, attempts, payload_json, last_error
       FROM jobs WHERE batch_id = ? AND workspace_id = ? ORDER BY created_at`,
    [batchId, workspaceId],
  );

  if (rows.length === 0) return undefined;

  const counts: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  const items: BatchItem[] = [];

  for (const row of rows) {
    const status = (
      (JOB_STATUSES as readonly string[]).includes(row.status) ? row.status : 'pending'
    ) as JobStatus;
    counts[status] += 1;

    const url = safeParse(row.payload_json).url;

    items.push({
      id: row.id,
      status,
      attempts: Number(row.attempts),
      ...(typeof url === 'string' ? { url } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
    });
  }

  return { batchId, total: rows.length, ...counts, items };
}

/** Queue depth by status, for the tick log and, later, an operator view. */
export async function queueDepth(db: Client): Promise<Record<JobStatus, number>> {
  const rows = await queryAll<{ status: string; n: number }>(
    db,
    'SELECT status, COUNT(*) AS n FROM jobs GROUP BY status',
  );

  const depth: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const row of rows) {
    if ((JOB_STATUSES as readonly string[]).includes(row.status)) {
      depth[row.status as JobStatus] = Number(row.n);
    }
  }
  return depth;
}
