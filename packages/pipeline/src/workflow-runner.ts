/**
 * The workflow engine (Engineering Contract Outreach PRD §14 "Durable execution").
 *
 * Walks a validated node graph in dependency order and calls one handler per
 * step type. The handlers — what "discover" or "send" actually does — are
 * supplied by the caller and are calls into existing machinery; this module
 * owns only the parts that make execution safe to repeat:
 *
 *   - **Idempotency.** A step that changes state runs under the key
 *     `workflow:slot:step`, recorded in `workflow_step_effects` before the run
 *     moves on. A retry or a resume of the same slot finds the key and reports
 *     the earlier result instead of acting again. The table's primary key is
 *     the lock: two workers racing for one step cannot both record it.
 *   - **Failure isolation.** A failed step fails only what depends on it;
 *     independent branches still run, and the log says which step blocked what.
 *   - **Cancellation.** Checked before every step; what has not started stays
 *     unstarted.
 *   - **Bounded retries.** A failed run is retried on the same slot after 5,
 *     30 and 120 minutes, then left as `dead_letter` for a person to look at.
 *
 * No step can bypass the policy engine from here: the engine has no send
 * path. Sending is autopilot's, which re-checks policy per message.
 */

import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  newId,
  SIDE_EFFECT_NODE_TYPES,
  topologicalOrder,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkflowRunStatus,
  type WorkflowRunTrigger,
} from '@outreachgraph/domain';

export const WORKFLOW_RETRY_DELAYS_MINUTES = [5, 30, 120] as const;
export const MAX_WORKFLOW_ATTEMPTS = WORKFLOW_RETRY_DELAYS_MINUTES.length + 1;

export type WorkflowStepStatus = 'ok' | 'skipped' | 'failed' | 'blocked' | 'cancelled' | 'replayed';

export interface WorkflowStepLog {
  readonly id: string;
  readonly type: WorkflowNodeType;
  readonly title: string;
  readonly status: WorkflowStepStatus;
  readonly detail: string;
  readonly counts?: Readonly<Record<string, number>>;
  /** Present on steps that change state. */
  readonly idempotencyKey?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface WorkflowStepOutcome {
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly detail: string;
  readonly counts?: Readonly<Record<string, number>>;
}

export interface WorkflowRunContext {
  readonly db: Client;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly slotKey: string;
  readonly at: Date;
  /** Shared between steps of one run (the campaign id, for one). */
  readonly state: Record<string, unknown>;
}

export type WorkflowStepHandler = (
  node: WorkflowNode,
  context: WorkflowRunContext,
) => Promise<WorkflowStepOutcome>;

export type WorkflowHandlers = Readonly<Record<WorkflowNodeType, WorkflowStepHandler>>;

export interface StartRunInput {
  readonly workflowId: string;
  readonly workspaceId: string;
  readonly version: number;
  readonly trigger: Exclude<WorkflowRunTrigger, 'dry_run'>;
  readonly slotKey: string;
  readonly attempt?: number;
  readonly retryOf?: string | undefined;
  readonly at?: Date;
}

export interface WorkflowRunOutcome {
  readonly runId: string;
  readonly status: WorkflowRunStatus;
  readonly steps: readonly WorkflowStepLog[];
  readonly error: string | null;
  readonly retryAt: string | null;
}

/** Inserts the run row. A separate call so a caller can return the id at once. */
export async function startWorkflowRun(db: Client, input: StartRunInput): Promise<string> {
  const runId = newId('workflowRun');
  await db.execute({
    sql: `INSERT INTO workflow_runs (id, workflow_id, workspace_id, version, run_trigger, status,
            slot_key, attempt, retry_of, started_at)
          VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    args: [
      runId,
      input.workflowId,
      input.workspaceId,
      input.version,
      input.trigger,
      input.slotKey,
      input.attempt ?? 1,
      input.retryOf ?? null,
      (input.at ?? new Date()).toISOString(),
    ],
  });
  return runId;
}

/** Executes a started run to the end and records the outcome. Never throws for a step. */
export async function executeWorkflowRun(
  db: Client,
  input: {
    readonly runId: string;
    readonly definition: WorkflowDefinition;
    readonly handlers: WorkflowHandlers;
    readonly state?: Record<string, unknown>;
    readonly at?: Date;
    readonly clock?: () => Date;
  },
): Promise<WorkflowRunOutcome> {
  const run = await queryOne<{
    workflow_id: string;
    workspace_id: string;
    slot_key: string;
    attempt: number;
  }>(db, 'SELECT workflow_id, workspace_id, slot_key, attempt FROM workflow_runs WHERE id = ?', [
    input.runId,
  ]);
  if (!run) throw new Error(`workflow run ${input.runId} does not exist`);

  const clock = input.clock ?? (() => new Date());
  const context: WorkflowRunContext = {
    db,
    workspaceId: run.workspace_id,
    workflowId: run.workflow_id,
    runId: input.runId,
    slotKey: run.slot_key,
    at: input.at ?? clock(),
    state: input.state ?? {},
  };

  const order = topologicalOrder(input.definition.nodes);
  if (!order) throw new Error('refusing to run a cyclic workflow');
  const byId = new Map(input.definition.nodes.map((n) => [n.id, n]));
  const results = new Map<string, WorkflowStepLog>();
  const steps: WorkflowStepLog[] = [];
  const record = (log: WorkflowStepLog) => {
    results.set(log.id, log);
    steps.push(log);
  };

  for (const id of order) {
    const node = byId.get(id)!;
    const startedAt = clock().toISOString();
    const base = { id: node.id, type: node.type, title: node.label, startedAt };

    if (await isCancelled(db, input.runId)) {
      record({
        ...base,
        status: 'cancelled',
        detail: 'run cancelled before this step',
        finishedAt: startedAt,
      });
      continue;
    }

    // A join proceeds on whatever finished: four discovery sources feeding one
    // enrich step should not all wait on the one whose search timed out. It
    // is blocked only when every parent failed. The failure still fails the
    // run, so the retry of this slot picks the missing source up, and the
    // steps that already ran are replayed from their records, not repeated.
    const unfinished = node.after.filter((parent) => {
      const status = results.get(parent)?.status;
      return status === 'failed' || status === 'blocked' || status === 'cancelled';
    });
    const blocker = unfinished.length === node.after.length ? unfinished[0] : undefined;
    if (blocker) {
      record({
        ...base,
        status: 'blocked',
        detail: `not run: “${byId.get(blocker)?.label ?? blocker}” did not finish`,
        finishedAt: startedAt,
      });
      continue;
    }

    const sideEffect = SIDE_EFFECT_NODE_TYPES.includes(node.type);
    const key = sideEffect ? `${run.workflow_id}:${run.slot_key}:${node.id}` : undefined;

    if (key) {
      const done = await queryOne<{ run_id: string; result_json: string }>(
        db,
        'SELECT run_id, result_json FROM workflow_step_effects WHERE idempotency_key = ?',
        [key],
      );
      if (done) {
        const earlier = safeJson(done.result_json) as Partial<WorkflowStepOutcome> & {
          state?: Record<string, unknown>;
        };
        // A replay still has to hand later steps what this one produced.
        Object.assign(context.state, earlier.state ?? {});
        record({
          ...base,
          status: 'replayed',
          detail: `already done in this slot by run ${done.run_id}: ${earlier.detail ?? 'ok'}`,
          ...(earlier.counts ? { counts: earlier.counts } : {}),
          idempotencyKey: key,
          finishedAt: clock().toISOString(),
        });
        continue;
      }
    }

    let outcome: WorkflowStepOutcome;
    try {
      outcome = await input.handlers[node.type](node, context);
    } catch (error) {
      outcome = { status: 'failed', detail: describeError(error) };
    }

    if (key && outcome.status !== 'failed') {
      // ON CONFLICT: a racing worker recorded it first; its record stands.
      await db.execute({
        sql: `INSERT INTO workflow_step_effects (idempotency_key, workflow_id, run_id, node_id,
                result_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (idempotency_key) DO NOTHING`,
        args: [
          key,
          run.workflow_id,
          input.runId,
          node.id,
          JSON.stringify({ ...outcome, state: context.state }),
          now(),
        ],
      });
    }

    record({
      ...base,
      status: outcome.status,
      detail: outcome.detail,
      ...(outcome.counts ? { counts: outcome.counts } : {}),
      ...(key ? { idempotencyKey: key } : {}),
      finishedAt: clock().toISOString(),
    });
  }

  const failed = steps.filter((s) => s.status === 'failed');
  const cancelled = steps.some((s) => s.status === 'cancelled');
  const attempt = Number(run.attempt);
  let status: WorkflowRunStatus;
  let retryAt: string | null = null;
  if (cancelled) status = 'cancelled';
  else if (failed.length === 0) status = 'succeeded';
  else if (attempt < MAX_WORKFLOW_ATTEMPTS) {
    status = 'retry_scheduled';
    const minutes = WORKFLOW_RETRY_DELAYS_MINUTES[attempt - 1] ?? 120;
    retryAt = new Date(clock().getTime() + minutes * 60_000).toISOString();
  } else status = 'dead_letter';

  const error = failed.length ? failed.map((s) => `${s.title}: ${s.detail}`).join('\n') : null;
  await db.execute({
    sql: `UPDATE workflow_runs SET status = ?, finished_at = ?, steps_json = ?, summary_json = ?,
            error = ?, retry_at = ?
           WHERE id = ?`,
    args: [
      status,
      clock().toISOString(),
      JSON.stringify(steps),
      JSON.stringify({
        state: context.state,
        failed: failed.length,
        replayed: steps.filter((s) => s.status === 'replayed').length,
      }),
      error,
      retryAt,
      input.runId,
    ],
  });

  return { runId: input.runId, status, steps, error, retryAt };
}

/** Asks a running or retry-pending run to stop. True when there was one to stop. */
export async function cancelWorkflowRun(
  db: Client,
  workflowId: string,
  runId: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE workflow_runs SET status = 'cancelled', retry_at = NULL,
            finished_at = COALESCE(finished_at, ?)
           WHERE id = ? AND workflow_id = ? AND status IN ('running', 'retry_scheduled')`,
    args: [now(), runId, workflowId],
  });
  return result.rowsAffected > 0;
}

/** How long a run may say `running` before it is presumed orphaned. */
export const WORKFLOW_RUN_STALE_MS = 30 * 60_000;

/**
 * Runs a restarted worker left saying `running` forever. Each becomes a retry
 * of its own slot, due now — the steps it finished are replayed from their
 * records — or `dead_letter` when it was already the last attempt.
 */
export async function recoverInterruptedWorkflowRuns(db: Client, at: Date): Promise<number> {
  const cutoff = new Date(at.getTime() - WORKFLOW_RUN_STALE_MS).toISOString();
  const stamp = at.toISOString();
  const result = await db.execute({
    sql: `UPDATE workflow_runs
             SET status = CASE WHEN attempt < ? THEN 'retry_scheduled' ELSE 'dead_letter' END,
                 retry_at = CASE WHEN attempt < ? THEN ? ELSE NULL END,
                 finished_at = ?,
                 error = 'interrupted: the worker stopped during this run'
           WHERE status = 'running' AND run_trigger != 'dry_run' AND started_at < ?`,
    args: [MAX_WORKFLOW_ATTEMPTS, MAX_WORKFLOW_ATTEMPTS, stamp, stamp, cutoff],
  });
  return result.rowsAffected;
}

/** Marks a run that threw outside a step (it never reached its own bookkeeping). */
export async function failWorkflowRun(db: Client, runId: string, error: unknown): Promise<void> {
  await db.execute({
    sql: `UPDATE workflow_runs SET status = 'failed', finished_at = ?, error = ?
           WHERE id = ? AND status = 'running'`,
    args: [now(), describeError(error), runId],
  });
}

/** Retries that have come due, oldest first. */
export async function dueWorkflowRetries(
  db: Client,
  at: Date,
  limit = 5,
): Promise<readonly { id: string; workflow_id: string; slot_key: string; attempt: number }[]> {
  return queryAll(
    db,
    `SELECT r.id, r.workflow_id, r.slot_key, r.attempt
       FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
      WHERE r.status = 'retry_scheduled' AND r.retry_at IS NOT NULL AND r.retry_at <= ?
        AND w.status = 'active'
      ORDER BY r.retry_at LIMIT ?`,
    [at.toISOString(), limit],
  );
}

/**
 * Marks a scheduled retry as taken, so one retry is started once.
 * The conditional update is the claim: a second worker updates nothing.
 */
export async function claimWorkflowRetry(db: Client, runId: string): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE workflow_runs SET status = 'failed', retry_at = NULL
           WHERE id = ? AND status = 'retry_scheduled'`,
    args: [runId],
  });
  return result.rowsAffected > 0;
}

async function isCancelled(db: Client, runId: string): Promise<boolean> {
  const row = await queryOne<{ status: string }>(
    db,
    'SELECT status FROM workflow_runs WHERE id = ?',
    [runId],
  );
  return row?.status === 'cancelled';
}

function safeJson(text: string | null | undefined): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
