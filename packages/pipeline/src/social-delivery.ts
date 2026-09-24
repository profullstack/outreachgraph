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
 */

import { randomInt } from 'node:crypto';
import { queryOne, type Client } from '@outreachgraph/db';
import type { XOAuthClient } from '@outreachgraph/providers';
import { enqueue } from './queue';
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

/**
 * What a paced action is counted against.
 *
 * `post` is a public reply or comment, and is capped by `PACING[network].perDay`
 * as it always has been. Everything else a LinkedIn session can do has its own
 * budget, because LinkedIn watches each separately and at very different
 * volumes: a person visits many more profiles than they send invitations.
 */
export type CapGroup = 'post' | 'connect' | 'view_profile' | 'follow' | 'send_dm';

export function capGroupFor(kind: string | undefined): CapGroup {
  if (kind === 'connect' || kind === 'view_profile' || kind === 'follow' || kind === 'send_dm') {
    return kind;
  }
  return 'post';
}

/**
 * Per-kind caps on LinkedIn, per UTC day and per rolling seven days.
 *
 * Conservative on purpose, and well below what the UI lets a person click:
 *
 *   connect       20/day, 100/week — LinkedIn's weekly invitation limit sits
 *                 around 100 for most accounts, and an account that hits it
 *                 is warned and then restricted. The day cap spreads the week
 *                 so a Monday "approve all" is not the whole week at once.
 *   view_profile  60/day — visits are metered for commercial use, and a free
 *                 account that reads too many profiles is cut off for a month.
 *   follow        30/day.
 *   send_dm       25/day — only ever to connections, and still a message.
 *
 * All of them share the network's gap: the minutes between two actions belong
 * to the account whichever kind each one is, because what LinkedIn sees is one
 * member doing things too fast.
 */
export const LINKEDIN_ACTION_CAPS: Readonly<
  Record<Exclude<CapGroup, 'post'>, { readonly perDay: number; readonly perWeek?: number }>
> = {
  connect: { perDay: 20, perWeek: 100 },
  view_profile: { perDay: 60 },
  follow: { perDay: 30 },
  send_dm: { perDay: 25 },
};

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

  const gap = randomInt(pace.minGapMs, pace.maxGapMs + 1);
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
  for (let attempt = 0; attempt < 366; attempt += 1) {
    const start = dayStart(runAt);
    const today = await scheduledBetween(start, start + DAY_MS);
    const week =
      caps.perWeek === undefined ? 0 : await scheduledBetween(runAt - 7 * DAY_MS, runAt + 1);
    if (today < caps.perDay && (caps.perWeek === undefined || week < caps.perWeek)) break;
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

export interface DeliverSocialDeps {
  readonly db: Client;
  readonly encryptionKey?: Buffer;
  readonly xOAuth?: XOAuthClient;
}

/** The worker's half: send one scheduled action now. */
export async function runSocialDelivery(
  deps: DeliverSocialDeps,
  job: { workspaceId: string; payload: Record<string, unknown> },
): Promise<{ sent: boolean; reason?: string; url?: string }> {
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
  const state = await queryOne<{ status: string; rec_status: string; person_status: string }>(
    db,
    `SELECT a.status, r.status AS rec_status, p.status AS person_status
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

  if (network === 'x') {
    const client = await xClientForWorkspace(db, job.workspaceId, {
      ...(deps.xOAuth ? { oauth: deps.xOAuth } : {}),
      ...(deps.encryptionKey ? { encryptionKey: deps.encryptionKey } : {}),
    });
    if (!client) return markUnsendable(db, actionId, 'no X account is connected');
    return deliverXAction({ db, client }, input);
  }

  if (network === 'linkedin') {
    const session = await linkedInSessionForWorkspace(db, job.workspaceId, deps.encryptionKey);
    if (!session) return markUnsendable(db, actionId, 'no LinkedIn session is connected');
    return deliverLinkedInAction({ db, session }, input);
  }

  return { sent: false, reason: `no paced sender for ${network}` };
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
