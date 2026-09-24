/**
 * Approved emails that waited for a mailbox with room.
 *
 * Approving an email sends it inline (see `outreach-email.ts`). The one
 * exception is a pool where every mailbox that could send it is at today's
 * cap: the approval is still the instruction to send, so rather than failing
 * the card — which would read as "something broke" and invite a retry that
 * breaks the cap — the send is queued for when the caps reset.
 *
 * Time passes between the approval and this job, so the live facts are read
 * again before anything goes out: the card may have been dismissed, the
 * person suppressed or deleted, or they may have written back in the
 * meantime. Any of those stops the send, as it would have stopped it at
 * approval.
 */

import { randomInt } from 'node:crypto';
import { queryOne, type Client } from '@outreachgraph/db';
import type { Mailer } from '@outreachgraph/email';
import { isSuppressed } from './cadence-runner';
import { mailerForSend } from './email-account';
import { deliverEmailAction, type AuditActor } from './outreach-email';
import { enqueue } from './queue';

/**
 * Queues one approved email for when the pool has room.
 *
 * An hour of jitter after the reset rather than the stroke of midnight, so a
 * day's worth of deferred mail does not leave in one burst — the shape
 * providers read as a script.
 */
export async function scheduleEmailDelivery(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly actionId: string;
    readonly actor: AuditActor;
    readonly policyVersion?: string | undefined;
    /** When the caps reset, from `chooseSender`. */
    readonly retryAt: string;
  },
  nowMs: number = Date.now(),
): Promise<{ queued: boolean; runAt: string }> {
  const runAt = Date.parse(input.retryAt) + randomInt(0, 3_600_000);

  const queued = await enqueue(db, {
    workspaceId: input.workspaceId,
    kind: 'deliver_email',
    payload: {
      actionId: input.actionId,
      actor: input.actor,
      ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
    },
    delayMs: Math.max(0, runAt - nowMs),
    // A send that fails is reported on the action, not retried blindly.
    maxAttempts: 1,
    // Per day, because a job that defers again enqueues its successor while
    // it is itself still `running` under the previous key.
    dedupeKey: `deliver_email:${input.actionId}:${new Date(runAt).toISOString().slice(0, 10)}`,
  });

  return { queued: queued.queued, runAt: new Date(runAt).toISOString() };
}

export interface DeliverEmailJobDeps {
  readonly db: Client;
  readonly encryptionKey?: Buffer | undefined;
  /** The platform sender, used when no workspace mailbox is active. */
  readonly mailer?: Mailer | undefined;
  readonly appUrl?: string | undefined;
}

/** The worker's half: send one deferred email now, or defer it again. */
export async function runEmailDelivery(
  deps: DeliverEmailJobDeps,
  job: { workspaceId: string; payload: Record<string, unknown> },
): Promise<{ sent: boolean; reason?: string; to?: string; deferredUntil?: string }> {
  const { db } = deps;
  const actionId = String(job.payload.actionId ?? '');
  const actor = (job.payload.actor as AuditActor | undefined) ?? {
    actorKind: 'system',
    actorId: 'deliver_email',
  };
  const policyVersion =
    typeof job.payload.policyVersion === 'string' ? job.payload.policyVersion : undefined;

  const state = await queryOne<{
    status: string;
    created_at: string;
    rec_status: string;
    person_status: string;
    person_id: string;
  }>(
    db,
    `SELECT a.status, a.created_at, r.status AS rec_status, p.status AS person_status,
            a.person_id
       FROM actions a
       JOIN recommendations r ON r.id = a.recommendation_id
       JOIN people p ON p.id = a.person_id
      WHERE a.id = ? AND a.workspace_id = ?`,
    [actionId, job.workspaceId],
  );
  if (!state) return { sent: false, reason: 'action not found' };
  if (state.status === 'completed') return { sent: false, reason: 'already sent' };
  if (state.status === 'cancelled') return { sent: false, reason: 'the action was cancelled' };
  if (state.person_status !== 'active') return { sent: false, reason: 'person is not active' };
  if (state.rec_status !== 'approved') return { sent: false, reason: 'card is no longer approved' };

  if (await isSuppressed(db, job.workspaceId, state.person_id)) {
    return cancel(db, actionId, 'the person opted out while this waited');
  }

  // A reply that arrived while the message waited makes it the wrong
  // message: it was written as an opener, and they have already opened.
  const replied = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM interactions
      WHERE workspace_id = ? AND person_id = ? AND direction = 'inbound' AND occurred_at >= ?`,
    [job.workspaceId, state.person_id, state.created_at],
  );
  if (Number(replied?.n ?? 0) > 0) {
    return cancel(db, actionId, 'they wrote back while this waited');
  }

  const sender = await mailerForSend(db, job.workspaceId, {
    encryptionKey: deps.encryptionKey,
    fallback: deps.mailer,
    personId: state.person_id,
  });

  if (sender.kind === 'deferred') {
    const again = await scheduleEmailDelivery(db, {
      workspaceId: job.workspaceId,
      actionId,
      actor,
      policyVersion,
      retryAt: sender.retryAt,
    });
    return {
      sent: false,
      reason: `deferred to ${again.runAt}: ${sender.reason}`,
      deferredUntil: again.runAt,
    };
  }

  if (sender.kind === 'none') {
    return { sent: false, reason: 'no mailbox is connected, so nothing could be sent' };
  }

  const result = await deliverEmailAction(
    {
      db,
      mailer: sender.mailer,
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
      ...(deps.appUrl ? { appUrl: deps.appUrl } : {}),
      ...(sender.accountId ? { senderAccountId: sender.accountId } : {}),
    },
    {
      workspaceId: job.workspaceId,
      actionId,
      actor,
      ...(policyVersion ? { policyVersion } : {}),
    },
  );

  return result.sent ? { sent: true, to: result.to } : { sent: false, reason: result.reason };
}

async function cancel(
  db: Client,
  actionId: string,
  reason: string,
): Promise<{ sent: false; reason: string }> {
  await db.execute({
    sql: `UPDATE actions SET status = 'cancelled', error = ? WHERE id = ?`,
    args: [reason, actionId],
  });
  return { sent: false, reason };
}
