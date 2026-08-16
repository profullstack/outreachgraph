/**
 * The numbers behind the funnel.
 *
 * Two shapes, because sales people look at two things and they are not the
 * same question:
 *
 *   - **The funnel** — how many leads reached each stage, and where they fall
 *     out. Aggregate, one row per stage, read left to right.
 *   - **The timeline** — one lead's journey, stage by stage, with dates. This
 *     is the "sideways chart" view: each lead a row, each stage a segment,
 *     length showing how long it sat there.
 *
 * Both read `lead_stage_events`, which is why that table exists. Neither is
 * answerable from `campaign_people.status` alone, because that column keeps
 * only the present.
 */

import {
  FUNNEL_STAGES,
  isFunnelStage,
  stageForStatus,
  summariseFunnel,
  type FunnelPosition,
  type FunnelStage,
  type FunnelSummary,
  type ProspectStatus,
} from '@outreachgraph/domain';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';

export interface FunnelQuery {
  readonly workspaceId: string;
  /** Narrow to one campaign. Omit for the whole workspace. */
  readonly campaignId?: string;
  /** ISO instant; only events at or after this count toward `reached`. */
  readonly since?: string;
}

/**
 * Current occupancy and historical reach, per stage.
 *
 * `current` comes from the live status column and `reached` from the event
 * log, which is the only combination that produces an honest funnel: a lead
 * that has been contacted is no longer *at* "Researched", but it certainly
 * reached it, and a chart built from current occupancy alone would show the
 * top of the funnel emptying as things went well.
 */
export async function campaignFunnel(db: Client, query: FunnelQuery): Promise<FunnelSummary> {
  const scope = query.campaignId ? 'AND cp.campaign_id = ?' : '';
  const scopeArgs = query.campaignId ? [query.campaignId] : [];

  const currentRows = await queryAll<{ status: string; n: number }>(
    db,
    `SELECT cp.status AS status, COUNT(*) AS n
       FROM campaign_people cp
       JOIN people p ON p.id = cp.person_id
      WHERE cp.workspace_id = ? ${scope}
        AND p.status != 'deleted'
      GROUP BY cp.status`,
    [query.workspaceId, ...scopeArgs],
  );

  const current: Partial<Record<FunnelPosition, number>> = {};
  for (const row of currentRows) {
    const stage = stageForStatus(row.status as ProspectStatus);
    if (!stage) continue;
    current[stage] = (current[stage] ?? 0) + row.n;
  }

  const eventScope = query.campaignId ? 'AND e.campaign_id = ?' : '';
  const sinceScope = query.since ? 'AND e.occurred_at >= ?' : '';

  const reachedRows = await queryAll<{ stage: string; n: number }>(
    db,
    `SELECT e.stage AS stage, COUNT(DISTINCT e.person_id) AS n
       FROM lead_stage_events e
      WHERE e.workspace_id = ? ${eventScope} ${sinceScope}
      GROUP BY e.stage`,
    [query.workspaceId, ...scopeArgs, ...(query.since ? [query.since] : [])],
  );

  const reached: Partial<Record<FunnelStage, number>> = {};
  for (const row of reachedRows) {
    if (isFunnelStage(row.stage)) reached[row.stage] = row.n;
  }

  return summariseFunnel(current, reached);
}

export interface TimelineSegment {
  readonly stage: FunnelPosition;
  readonly enteredAt: string;
  /** Absent while the lead is still sitting here. */
  readonly leftAt?: string;
  readonly hours?: number;
}

export interface LeadTimeline {
  readonly personId: string;
  readonly personName: string;
  readonly companyName?: string;
  readonly currentStage: FunnelPosition;
  readonly opportunity?: number;
  readonly firstSeenAt: string;
  readonly segments: readonly TimelineSegment[];
}

/**
 * One row per lead, each a sequence of stage segments.
 *
 * Consecutive events in the same stage are collapsed: the internal state
 * machine moves `discovered → enriching → resolved` and all three are the
 * single funnel stage "Found", so drawing them as three segments would show
 * detail that means nothing to the reader.
 */
export async function leadTimeline(
  db: Client,
  query: FunnelQuery & { limit?: number },
): Promise<readonly LeadTimeline[]> {
  const scope = query.campaignId ? 'AND e.campaign_id = ?' : '';
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);

  const rows = await queryAll<{
    person_id: string;
    display_name: string;
    company_name: string | null;
    stage: string;
    to_status: string;
    occurred_at: string;
    opportunity: number | null;
  }>(
    db,
    `SELECT e.person_id, p.display_name, co.name AS company_name,
            e.stage, e.to_status, e.occurred_at, s.opportunity
       FROM lead_stage_events e
       JOIN people p ON p.id = e.person_id
       LEFT JOIN companies co ON co.id = p.current_company_id
       LEFT JOIN scores s ON s.person_id = e.person_id AND s.campaign_id = e.campaign_id
      WHERE e.workspace_id = ? ${scope}
        AND p.status != 'deleted'
        AND e.person_id IN (
          SELECT person_id FROM lead_stage_events
           WHERE workspace_id = ? ${query.campaignId ? 'AND campaign_id = ?' : ''}
           GROUP BY person_id
           ORDER BY MAX(occurred_at) DESC
           LIMIT ?
        )
      ORDER BY e.person_id ASC, e.occurred_at ASC`,
    [
      query.workspaceId,
      ...(query.campaignId ? [query.campaignId] : []),
      query.workspaceId,
      ...(query.campaignId ? [query.campaignId] : []),
      limit,
    ],
  );

  const byPerson = new Map<string, LeadTimeline & { segments: TimelineSegment[] }>();

  for (const row of rows) {
    const stage = (
      isFunnelStage(row.stage) ? row.stage : stageForStatus(row.to_status as ProspectStatus)
    ) as FunnelPosition;

    let entry = byPerson.get(row.person_id);

    if (!entry) {
      entry = {
        personId: row.person_id,
        personName: row.display_name,
        ...(row.company_name ? { companyName: row.company_name } : {}),
        currentStage: stage,
        ...(row.opportunity !== null ? { opportunity: Math.round(row.opportunity) } : {}),
        firstSeenAt: row.occurred_at,
        segments: [],
      };
      byPerson.set(row.person_id, entry);
    }

    const last = entry.segments[entry.segments.length - 1];

    // Same funnel stage as the previous event: the lead did not visibly move,
    // so extend rather than start a new segment.
    if (last && last.stage === stage) continue;

    if (last) {
      const hours = (Date.parse(row.occurred_at) - Date.parse(last.enteredAt)) / 3_600_000;
      entry.segments[entry.segments.length - 1] = {
        ...last,
        leftAt: row.occurred_at,
        ...(Number.isFinite(hours) ? { hours: Math.round(hours * 10) / 10 } : {}),
      };
    }

    entry.segments.push({ stage, enteredAt: row.occurred_at });
    (entry as { currentStage: FunnelPosition }).currentStage = stage;
  }

  return [...byPerson.values()].sort(
    (a, b) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt),
  );
}

export interface WorkspaceAnalytics {
  readonly funnel: FunnelSummary;
  readonly sentThisWeek: number;
  readonly repliesThisWeek: number;
  readonly awaitingApproval: number;
  readonly activeCampaigns: number;
  readonly autopilotCampaigns: number;
  /** Median hours from a lead being found to being written to. */
  readonly medianHoursToContact?: number;
}

/** The headline numbers, for the top of the funnel page. */
export async function workspaceAnalytics(
  db: Client,
  workspaceId: string,
  at: Date = new Date(),
): Promise<WorkspaceAnalytics> {
  const weekAgo = new Date(at.getTime() - 7 * 24 * 3_600_000).toISOString();

  const funnel = await campaignFunnel(db, { workspaceId });

  const [sent, replies, awaiting, campaigns, speeds] = await Promise.all([
    count(
      db,
      `SELECT COUNT(*) AS n FROM actions
        WHERE workspace_id = ? AND status = 'completed' AND executed_at >= ?`,
      [workspaceId, weekAgo],
    ),
    count(
      db,
      `SELECT COUNT(*) AS n FROM interactions
        WHERE workspace_id = ? AND direction = 'inbound' AND occurred_at >= ?`,
      [workspaceId, weekAgo],
    ),
    count(
      db,
      `SELECT COUNT(*) AS n FROM recommendations WHERE workspace_id = ? AND status = 'pending'`,
      [workspaceId],
    ),
    queryAll<{ approval_mode: string; n: number }>(
      db,
      `SELECT approval_mode, COUNT(*) AS n FROM campaigns
        WHERE workspace_id = ? AND status != 'archived' GROUP BY approval_mode`,
      [workspaceId],
    ),
    queryAll<{ hours: number }>(
      db,
      `SELECT (julianday(contacted.occurred_at) - julianday(found.occurred_at)) * 24 AS hours
         FROM (SELECT person_id, MIN(occurred_at) AS occurred_at FROM lead_stage_events
                WHERE workspace_id = ? AND stage = 'contacted' GROUP BY person_id) contacted
         JOIN (SELECT person_id, MIN(occurred_at) AS occurred_at FROM lead_stage_events
                WHERE workspace_id = ? AND stage = 'discovered' GROUP BY person_id) found
           ON found.person_id = contacted.person_id`,
      [workspaceId, workspaceId],
    ),
  ]);

  const active = campaigns.reduce((total, row) => total + row.n, 0);
  const autopilot = campaigns
    .filter((row) => row.approval_mode === 'trusted_automation')
    .reduce((total, row) => total + row.n, 0);

  const hours = speeds
    .map((row) => row.hours)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  const median = hours.length
    ? Math.round((hours[Math.floor(hours.length / 2)] as number) * 10) / 10
    : undefined;

  return {
    funnel,
    sentThisWeek: sent,
    repliesThisWeek: replies,
    awaitingApproval: awaiting,
    activeCampaigns: active,
    autopilotCampaigns: autopilot,
    ...(median !== undefined ? { medianHoursToContact: median } : {}),
  };
}

async function count(db: Client, sql: string, args: unknown[]): Promise<number> {
  const row = await queryOne<{ n: number }>(db, sql, args as never);
  return row?.n ?? 0;
}

/** Re-exported so callers can label a chart without importing two packages. */
export { FUNNEL_STAGES };
