/**
 * Recording where a lead is, and when it got there.
 *
 * `campaign_people.status` is a single column that each update overwrites, so
 * before this the product could answer "where is this lead now" and no other
 * question about it. Not "how long did it sit unapproved", not "how many made
 * it from researched to contacted last week", not "when did this go out" —
 * all of which are the questions a funnel exists to answer.
 *
 * Every status change now goes through one function that writes both the
 * current state and an immutable event. Two rules make the history worth
 * trusting:
 *
 *   - A change to the same status writes nothing. The pipeline re-runs stages
 *     on resume, and a resumed run must not look like a lead bouncing.
 *   - The funnel stage is stamped on the event at write time, not derived when
 *     the chart is drawn, so re-grouping the state machine later cannot
 *     retroactively rewrite what last quarter looked like.
 */

import {
  newId,
  stageForStatus,
  type FunnelPosition,
  type ProspectStatus,
} from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';

export interface StatusChange {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly personId: string;
  readonly status: ProspectStatus | string;
  readonly reason?: string;
  readonly at?: string;
}

export interface StatusChangeResult {
  readonly changed: boolean;
  readonly from?: string;
  readonly to: string;
  readonly stage: FunnelPosition;
}

/**
 * Moves a lead to `status` and records the move.
 *
 * The read-then-write is not wrapped in a transaction deliberately: the worker
 * is a single instance by design, and the only cost of losing the race is one
 * duplicate event in a history nothing reads transactionally. Buying strict
 * ordering here would mean a lock on the hottest table in the pipeline.
 */
export async function recordStatus(db: Client, change: StatusChange): Promise<StatusChangeResult> {
  const stamp = change.at ?? now();
  const stage = stageForStatus(change.status as ProspectStatus) ?? 'discovered';

  const existing = await queryOne<{ status: string }>(
    db,
    `SELECT status FROM campaign_people WHERE campaign_id = ? AND person_id = ?`,
    [change.campaignId, change.personId],
  );

  // A lead that is not in this campaign cannot move through it. Without this
  // the update below matches nothing, the insert still runs, and the event
  // references a membership that does not exist — which the foreign key
  // rejects, turning a harmless no-op into a failed job.
  if (!existing) {
    return { changed: false, to: change.status, stage };
  }

  const from = existing.status;

  await db.execute({
    sql: `UPDATE campaign_people SET status = ?, status_reason = ?, updated_at = ?
           WHERE campaign_id = ? AND person_id = ?`,
    args: [change.status, change.reason ?? null, stamp, change.campaignId, change.personId],
  });

  if (from === change.status) {
    return { changed: false, ...(from ? { from } : {}), to: change.status, stage };
  }

  await db.execute({
    sql: `INSERT INTO lead_stage_events (id, workspace_id, campaign_id, person_id,
          from_status, to_status, stage, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('stageEvent'),
      change.workspaceId,
      change.campaignId,
      change.personId,
      from ?? null,
      change.status,
      stage,
      stamp,
    ],
  });

  return { changed: true, ...(from ? { from } : {}), to: change.status, stage };
}

/**
 * Records the first event for a lead that has just joined a campaign.
 *
 * Membership is created with `ON CONFLICT DO NOTHING`, so this is only called
 * where that insert actually inserted — otherwise re-crawling a site would
 * stamp every one of its people back to the top of the funnel.
 */
export async function recordDiscovered(
  db: Client,
  change: Omit<StatusChange, 'status'>,
): Promise<void> {
  const stamp = change.at ?? now();

  await db.execute({
    sql: `INSERT INTO lead_stage_events (id, workspace_id, campaign_id, person_id,
          from_status, to_status, stage, occurred_at)
          VALUES (?, ?, ?, ?, NULL, 'discovered', 'discovered', ?)`,
    args: [newId('stageEvent'), change.workspaceId, change.campaignId, change.personId, stamp],
  });
}
