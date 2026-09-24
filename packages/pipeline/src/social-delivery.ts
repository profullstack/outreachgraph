/**
 * Paced delivery for X and LinkedIn.
 *
 * Approving is the instruction to send, as it is for email, but a social post
 * is public and both networks watch for accounts that act like scripts. A
 * reviewer pressing "approve all" on 100 cards would otherwise post 100 replies
 * in the time it takes the loop to run. So approval schedules a
 * `deliver_social` job instead, spaced from the last one scheduled for that
 * workspace and network, with jitter, and capped per UTC day; anything over
 * the cap starts the next day.
 *
 * The numbers are conservative on purpose. LinkedIn restricts accounts at
 * volumes well below what its UI allows a person to click, and X's API caps
 * posts per user per day by access tier.
 *
 * With a pool of accounts (`sender-pool.ts`) the numbers become per account:
 * the day's cap is what the pool's active accounts may send between them,
 * after each one's warm-up, and the gap between posts shrinks by the number
 * of accounts sharing the load — so each account still sees roughly the
 * spacing above. Which account posts is decided when the job runs, not when
 * it is scheduled, because that is when "who is already talking to this
 * person" and "who has room today" have their final answers.
 */

import { randomInt } from 'node:crypto';
import { capGroupFor, LINKEDIN_ACTION_CAPS, type CapGroup } from '@outreachgraph/domain';
import { queryOne, type Client } from '@outreachgraph/db';
import type { XOAuthClient } from '@outreachgraph/providers';
import { enqueue } from './queue';
import { assignSender, chooseSender, describeDeferral, poolCapacity } from './sender-pool';
import { xClientForWorkspace } from './x-account';
import { deliverXAction } from './outreach-x';
import { linkedInSessionForWorkspace } from './linkedin-account';
import { deliverLinkedInAction } from './outreach-linkedin';
import type { AuditActor } from './outreach-email';

export type PacedNetwork = 'x' | 'linkedin';

export const PACING: Record<PacedNetwork, { minGapMs: number; maxGapMs: number; perDay: number }> =
  {
    // Tuned for posting through a browser session (X locks accounts that
    // post like a script); an API grant would tolerate more.
    x: { minGapMs: 3 * 60_000, maxGapMs: 8 * 60_000, perDay: 20 },
    linkedin: { minGapMs: 4 * 60_000, maxGapMs: 11 * 60_000, perDay: 25 },
  };

export function isPacedNetwork(network: string): network is PacedNetwork {
  return network === 'x' || network === 'linkedin';
}

// The cap groups and LinkedIn's per-kind caps live in the domain package,
// beside the warm-up ramp, because the sender pool applies them per account
// too. Re-exported so existing importers keep one place to find them.
export { capGroupFor, LINKEDIN_ACTION_CAPS, type CapGroup };

/** The caps one action is scheduled under. */
export function capsFor(
  network: PacedNetwork,
  group: CapGroup,
): { readonly perDay: number; readonly perWeek?: number } {
  if (network === 'linkedin' && group !== 'post') return LINKEDIN_ACTION_CAPS[group];
  return { perDay: PACING[network].perDay };
}

function dayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const DAY_MS = 86_400_000;

/**
 * Queues one action to be sent after the ones already scheduled.
 * Returns when it is expected to go out.
 *
 * `kind` picks the cap the action counts against. Omitted, it is a post, which
 * is also how every job queued before per-kind caps existed is counted.
 */
export async function scheduleSocialDelivery(
  db: Client,
  input: {
    workspaceId: string;
    actionId: string;
    network: PacedNetwork;
    actor: AuditActor;
    policyVersion?: string;
    kind?: string;
  },
  nowMs: number = Date.now(),
): Promise<{ queued: boolean; runAt: string }> {
  const pace = PACING[input.network];
  const like = `%"network":"${input.network}"%`;
  const group = capGroupFor(input.kind);
  const caps = capsFor(input.network, group);

  const last = await queryOne<{ run_after: string }>(
    db,
    `SELECT run_after FROM jobs
      WHERE workspace_id = ? AND kind = 'deliver_social' AND payload_json LIKE ?
        AND status IN ('pending', 'running', 'done')
      ORDER BY run_after DESC LIMIT 1`,
    [input.workspaceId, like],
  );

  // Several accounts share the posting, so the workspace-wide gap shrinks by
  // their number and each account keeps about the single-account spacing.
  const pool = await poolCapacity(db, input.workspaceId, input.network, new Date(nowMs));
  const gap = Math.round(randomInt(pace.minGapMs, pace.maxGapMs + 1) / Math.max(1, pool.accounts));
  let runAt = Math.max(nowMs, last ? Date.parse(last.run_after) + gap : nowMs);

  // Jobs in this cap group. A post is anything marked as one, plus every job
  // queued before groups existed (no `capGroup` in its payload at all).
  const inGroup =
    group === 'post'
      ? `(payload_json LIKE '%"capGroup":"post"%' OR payload_json NOT LIKE '%"capGroup":%')`
      : `payload_json LIKE '%"capGroup":"${group}"%'`;

  const scheduledBetween = async (from: number, to: number): Promise<number> => {
    const row = await queryOne<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM jobs
        WHERE workspace_id = ? AND kind = 'deliver_social' AND payload_json LIKE ?
          AND ${inGroup}
          AND run_after >= ? AND run_after < ?`,
      [input.workspaceId, like, new Date(from).toISOString(), new Date(to).toISOString()],
    );
    return Number(row?.n ?? 0);
  };

  // Cap per UTC day, and per rolling week where the kind has one, counting
  // everything already scheduled into that window. Bounded, so a corrupt
  // queue cannot spin this forever: a year out is still an answer.
  //
  // With accounts connected the limits are the pool's: each account's cap for
  // this kind (after its warm-up) added up, so three sessions may schedule
  // three times the invitations one could — and the job, when it runs, still
  // holds every account to its own twenty a day and hundred a week.
  for (let attempt = 0; attempt < 366; attempt += 1) {
    const start = dayStart(runAt);
    const limits = await poolLimits(db, input.workspaceId, input.network, start, input.kind, caps);
    const today = await scheduledBetween(start, start + DAY_MS);
    const week =
      limits.perWeek === undefined ? 0 : await scheduledBetween(runAt - 7 * DAY_MS, runAt + 1);
    if (today < limits.perDay && (limits.perWeek === undefined || week < limits.perWeek)) break;
    // Next day, at a working hour with jitter rather than on the stroke of midnight.
    runAt = start + DAY_MS + 9 * 3_600_000 + randomInt(0, 3_600_000);
  }

  const queued = await enqueue(db, {
    workspaceId: input.workspaceId,
    kind: 'deliver_social',
    payload: {
      actionId: input.actionId,
      network: input.network,
      capGroup: group,
      actor: input.actor,
      ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
    },
    delayMs: runAt - nowMs,
    // A post that failed is reported on its card, not retried in public.
    maxAttempts: 1,
    dedupeKey: `deliver_social:${input.actionId}`,
  });

  return { queued: queued.queued, runAt: new Date(runAt).toISOString() };
}

/**
 * How many actions of one kind a network may schedule on the UTC day starting
 * at `dayStartMs`, and in any seven days.
 *
 * The pool's combined capacity that day, warm-up included, when accounts are
 * connected; the single-account figures when none are, which is what a
 * workspace that has not connected anything always got. Never below one, so
 * a pool whose caps are all zero still schedules and lets the job defer.
 */
async function poolLimits(
  db: Client,
  workspaceId: string,
  network: PacedNetwork,
  dayStartMs: number,
  kind: string | undefined,
  single: { readonly perDay: number; readonly perWeek?: number },
): Promise<{ perDay: number; perWeek?: number }> {
  // Measured at midday so a warm-up day boundary is never ambiguous.
  const pool = await poolCapacity(
    db,
    workspaceId,
    network,
    new Date(dayStartMs + 43_200_000),
    kind,
  );
  if (pool.accounts === 0) return single;
  return {
    perDay: Math.max(1, pool.capacity),
    ...(pool.weeklyCapacity === undefined ? {} : { perWeek: pool.weeklyCapacity }),
  };
}

export interface DeliverSocialDeps {
  readonly db: Client;
  readonly encryptionKey?: Buffer;
  readonly xOAuth?: XOAuthClient;
}

/** The worker's half: send one scheduled action now. */
export async function runSocialDelivery(
  deps: DeliverSocialDeps,
  job: { workspaceId: string; payload: Record<string, unknown> },
): Promise<{ sent: boolean; reason?: string; url?: string; deferredUntil?: string }> {
  const { db } = deps;
  const actionId = String(job.payload.actionId ?? '');
  const network = String(job.payload.network ?? '');
  const actor = (job.payload.actor as AuditActor | undefined) ?? {
    actorKind: 'system',
    actorId: 'deliver_social',
  };
  const policyVersion =
    typeof job.payload.policyVersion === 'string' ? job.payload.policyVersion : undefined;

  // Stopped between approval and now: the card was dismissed, or the person
  // suppressed. Posting anyway would ignore the last word a human had.
  const state = await queryOne<{
    status: string;
    rec_status: string;
    person_status: string;
    person_id: string;
    kind: string;
  }>(
    db,
    `SELECT a.status, r.status AS rec_status, p.status AS person_status, a.person_id, a.kind
       FROM actions a
       JOIN recommendations r ON r.id = a.recommendation_id
       JOIN people p ON p.id = a.person_id
      WHERE a.id = ? AND a.workspace_id = ?`,
    [actionId, job.workspaceId],
  );
  if (!state) return { sent: false, reason: 'action not found' };
  if (state.status === 'completed') return { sent: false, reason: 'already sent' };
  if (state.person_status !== 'active') return { sent: false, reason: 'person is not active' };
  if (state.rec_status !== 'approved') return { sent: false, reason: 'card is no longer approved' };

  const input = {
    workspaceId: job.workspaceId,
    actionId,
    actor,
    ...(policyVersion ? { policyVersion } : {}),
  };

  if (!isPacedNetwork(network)) return { sent: false, reason: `no paced sender for ${network}` };

  // Which account posts: the one already talking to this person, else the
  // one with the most room today. Full is not failed — the job moves itself
  // to tomorrow morning and the card stays approved.
  const selection = await chooseSender(db, {
    workspaceId: job.workspaceId,
    network,
    personId: state.person_id,
    kind: state.kind,
  });

  if (selection.choice.kind === 'deferred') {
    const retryAt = Date.parse(selection.retryAt!) + 9 * 3_600_000 + randomInt(0, 3_600_000);
    await enqueue(db, {
      workspaceId: job.workspaceId,
      kind: 'deliver_social',
      payload: job.payload,
      delayMs: Math.max(0, retryAt - Date.now()),
      maxAttempts: 1,
      // A key of its own: this job is still `running` under the original one.
      dedupeKey: `deliver_social:${actionId}:${new Date(retryAt).toISOString().slice(0, 10)}`,
    });
    const deferredUntil = new Date(retryAt).toISOString();
    return {
      sent: false,
      reason: `deferred to ${deferredUntil}: ${describeDeferral(selection.choice)}`,
      deferredUntil,
    };
  }

  const accountId = selection.account?.id;

  if (network === 'x') {
    const client = accountId
      ? await xClientForWorkspace(db, job.workspaceId, {
          ...(deps.xOAuth ? { oauth: deps.xOAuth } : {}),
          ...(deps.encryptionKey ? { encryptionKey: deps.encryptionKey } : {}),
          accountId,
        })
      : undefined;
    if (!client || !accountId) return markUnsendable(db, actionId, 'no X account is connected');
    await assignSender(db, actionId, accountId);
    return deliverXAction({ db, client, accountId }, input);
  }

  const session = accountId
    ? await linkedInSessionForWorkspace(db, job.workspaceId, deps.encryptionKey, {}, accountId)
    : undefined;
  if (!session || !accountId) {
    return markUnsendable(db, actionId, 'no LinkedIn session is connected');
  }
  await assignSender(db, actionId, accountId);
  return deliverLinkedInAction({ db, session, accountId }, input);
}

async function markUnsendable(
  db: Client,
  actionId: string,
  reason: string,
): Promise<{ sent: false; reason: string }> {
  await db.execute({
    sql: `UPDATE actions SET status = 'failed', error = ? WHERE id = ?`,
    args: [reason, actionId],
  });
  return { sent: false, reason };
}
