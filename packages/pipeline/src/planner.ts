/**
 * The Outreach Planner engine: on the first sweep of each month, every product
 * with the planner on gets that month's plays (`PLANNER_YEAR` in
 * `@outreachgraph/domain`) launched from its own engagement data.
 *
 * A play is a segment and an angle. The segment is read from what people did
 * with the product's earlier outreach — opened or clicked and never replied,
 * written to and never engaged, engaged this quarter — and becomes a new
 * campaign under the same product, in the same approval mode as the product's
 * own campaigns, with a cadence carrying the play's touches. From there it is
 * ordinary outreach: drafted per person and grounded in their evidence,
 * verified before sending, one contact per company, inside business hours,
 * A/B tested where the play tests, stopped by a reply.
 *
 * Idempotent per product, month and play (`planner_runs`). A play whose
 * segment is empty this sweep is not recorded, so it launches later in the
 * month if the data arrives.
 */

import {
  BUYING_MODE_LABELS,
  newId,
  PLANNER_YEAR,
  plannerMonth,
  plannerPeriod,
  quarterRange,
  touchesWithWinner,
  type Play,
  type PlannerMonth,
  type Segment,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { latestWinningIntent } from './ab-winners';
import { createCadence, enrollInCadence } from './cadence';
import { emitEvent } from './events';

/** People per play per product, so one month never floods a mailbox pool. */
const DEFAULT_MAX_PEOPLE = 200;
/** Nobody written to in the last fortnight is pulled into another play. */
const RECENT_CONTACT_DAYS = 14;

export interface PlannerDeps {
  readonly db: Client;
  readonly now?: Date;
  readonly maxPeoplePerPlay?: number;
}

export interface LaunchedPlay {
  readonly offeringId: string;
  readonly playKey: string;
  readonly campaignId?: string;
  readonly people: number;
}

interface OfferingRow {
  readonly id: string;
  readonly name: string;
}

interface SourceCampaign {
  readonly id: string;
  readonly approval_mode: string;
  readonly auto_reply_mode: string | null;
  readonly voice_profile_id: string | null;
  readonly budget_json: string;
}

/** Runs this month's plays for every product in the workspace that has the planner on. */
export async function runPlanner(deps: PlannerDeps, workspaceId: string): Promise<LaunchedPlay[]> {
  const { db } = deps;
  const at = deps.now ?? new Date();
  const month = plannerMonth(at);
  const period = plannerPeriod(at);

  const offerings = await queryAll<OfferingRow>(
    db,
    `SELECT o.id, o.name FROM offerings o
      WHERE o.workspace_id = ? AND COALESCE(o.planner_enabled, 1) = 1
        AND EXISTS (SELECT 1 FROM campaigns c
              JOIN interactions i ON i.campaign_id = c.id
             WHERE c.offering_id = o.id AND c.status != 'archived'
               AND i.direction = 'outbound' AND i.network = 'email')`,
    [workspaceId],
  );

  const launched: LaunchedPlay[] = [];
  for (const offering of offerings) {
    if (month.refreshLists) {
      const refreshed = await refreshLists(db, workspaceId, offering, period, at);
      if (refreshed) launched.push(refreshed);
    }
    for (const play of month.plays) {
      const result = await launchPlay(deps, workspaceId, offering, month, play, period, at);
      if (result) launched.push(result);
    }
  }
  return launched;
}

/**
 * The months that build fresh lists: every URL or keyword campaign of the
 * product is made due for the reseed sweep, which re-reads its seed for new
 * companies and people. Recorded so it happens once per month.
 */
async function refreshLists(
  db: Client,
  workspaceId: string,
  offering: OfferingRow,
  period: string,
  at: Date,
): Promise<LaunchedPlay | undefined> {
  if (await alreadyRan(db, offering.id, period, 'refresh_lists')) return undefined;

  const result = await db.execute({
    sql: `UPDATE campaigns SET reseeded_at = '1970-01-01T00:00:00.000Z'
           WHERE workspace_id = ? AND offering_id = ? AND status IN ('active', 'running')
             AND seed_kind IN ('url', 'keyword')`,
    args: [workspaceId, offering.id],
  });
  const campaigns = result.rowsAffected ?? 0;

  await recordRun(db, {
    workspaceId,
    offeringId: offering.id,
    period,
    playKey: 'refresh_lists',
    people: 0,
    detail: { campaigns },
    at,
  });

  if (campaigns > 0) {
    await emitEvent(db, {
      workspaceId,
      phase: 'discover',
      level: 'info',
      message: `Planner: refreshing ${campaigns} list${campaigns === 1 ? '' : 's'} for ${offering.name}`,
      detail: { offeringId: offering.id, period },
    });
  }
  return { offeringId: offering.id, playKey: 'refresh_lists', people: 0 };
}

async function launchPlay(
  deps: PlannerDeps,
  workspaceId: string,
  offering: OfferingRow,
  month: PlannerMonth,
  play: Play,
  period: string,
  at: Date,
): Promise<LaunchedPlay | undefined> {
  const { db } = deps;
  if (await alreadyRan(db, offering.id, period, play.key)) return undefined;

  const people = await segmentPeople(db, {
    workspaceId,
    offeringId: offering.id,
    segment: play.segment,
    at,
    limit: deps.maxPeoplePerPlay ?? DEFAULT_MAX_PEOPLE,
  });
  if (people.length === 0) return undefined;

  const source = await sourceCampaign(db, offering.id);
  if (!source) return undefined;

  const stamp = at.toISOString();
  const campaignId = newId('campaign');
  const name = `${offering.name} · ${play.title} (${period})`;

  await db.execute({
    sql: `INSERT INTO campaigns (id, workspace_id, name, offering_id, voice_profile_id, brief,
          networks, approval_mode, budget_json, status, created_at, updated_at, started_at,
          auto_reply_mode, seed_kind, seed_value)
          VALUES (?, ?, ?, ?, ?, ?, '["email"]', ?, ?, 'active', ?, ?, ?, ?, 'planner', ?)`,
    args: [
      campaignId,
      workspaceId,
      name,
      offering.id,
      source.voice_profile_id,
      `${month.label}. Buying mode: ${BUYING_MODE_LABELS[month.buyingMode]}. ${month.whatBuyersAreDoing} Benchmark: ${month.benchmark}`,
      source.approval_mode,
      source.budget_json,
      stamp,
      stamp,
      stamp,
      source.auto_reply_mode ?? 'copilot',
      play.key,
    ],
  });

  const winner = await latestWinningIntent(db, workspaceId);
  const touches = touchesWithWinner(play.touches, winner);
  const cadence = await createCadence(db, {
    workspaceId,
    campaignId,
    name: play.title,
    status: 'active',
    steps: touches.map((touch, position) => ({
      position,
      network: 'email',
      action: 'send_email',
      delayHours: touch.delayHours,
      stopOnReply: true,
      intent: touch.intent,
      ...(touch.variants.length > 0 ? { variants: touch.variants } : {}),
    })),
  });
  if (!cadence.created) {
    throw new Error(
      `planner play ${play.key} has an invalid cadence: ${cadence.problems.map((p) => p.message).join('; ')}`,
    );
  }

  let enrolled = 0;
  for (const personId of people) {
    await db.execute({
      sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status,
            interaction_state, discovered_at, updated_at)
            VALUES (?, ?, ?, 'recommended', 'contacted', ?, ?)
            ON CONFLICT (campaign_id, person_id) DO NOTHING`,
      args: [campaignId, personId, workspaceId, stamp, stamp],
    });
    const result = await enrollInCadence(db, {
      cadenceId: cadence.cadenceId,
      workspaceId,
      campaignId,
      personId,
      at,
    });
    if (result.enrolled) enrolled += 1;
  }

  await recordRun(db, {
    workspaceId,
    offeringId: offering.id,
    period,
    playKey: play.key,
    campaignId,
    cadenceId: cadence.cadenceId,
    people: enrolled,
    detail: {
      sequence: play.sequence,
      steps: touches.length,
      abTested: touches.some((t) => t.variants.length > 0),
    },
    at,
  });

  await emitEvent(db, {
    workspaceId,
    campaignId,
    phase: 'social',
    level: 'success',
    message: `Planner: launched "${play.title}" for ${offering.name} to ${enrolled} ${enrolled === 1 ? 'person' : 'people'}`,
    detail: { offeringId: offering.id, period, playKey: play.key },
  });

  return { offeringId: offering.id, playKey: play.key, campaignId, people: enrolled };
}

/**
 * The people a segment names, for one product.
 *
 * "Contacted in" is when the person was first emailed by any of the product's
 * campaigns. Always excluded: anyone suppressed or ineligible, anyone whose
 * address bounced, anyone who said no or asked to stop, anyone on an active
 * cadence, anyone written to in the last 14 days, anyone the planner already
 * put in a play this month, and anyone reached this year by the plays the
 * segment excludes.
 */
export async function segmentPeople(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly offeringId: string;
    readonly segment: Segment;
    readonly at: Date;
    readonly limit: number;
  },
): Promise<string[]> {
  const { workspaceId, offeringId, segment, at } = input;
  const year = at.getUTCFullYear();

  // Contact window, as a set of [from, to) ranges.
  const ranges =
    'quarters' in segment.contacted
      ? segment.contacted.quarters.map((quarter) => quarterRange(year, quarter))
      : [
          {
            from: new Date(at.getTime() - segment.contacted.lastDays * 86_400_000).toISOString(),
            to: at.toISOString(),
          },
        ];
  const rangeSql = ranges.map(() => '(first_at >= ? AND first_at < ?)').join(' OR ');
  const rangeArgs = ranges.flatMap((range) => [range.from, range.to]);

  const recent = new Date(at.getTime() - RECENT_CONTACT_DAYS * 86_400_000).toISOString();
  const yearStart = new Date(Date.UTC(year, 0, 1)).toISOString();
  const monthStart = new Date(Date.UTC(year, at.getUTCMonth(), 1)).toISOString();
  const excluded = segment.excludePlays ?? [];

  // Opens and clicks are only evidence when the workspace tracks them, and
  // both are off by default: the planner's own rule is a plain-text first
  // email with no links or images. Without them "opened but never replied"
  // is unknowable, so each segment falls back to what is known — written to,
  // delivered, no reply — and the plays' exclusions keep one person out of
  // two plays. Nobody who said no or asked to stop is ever in a segment.
  const blind = !(await tracksEngagement(db, workspaceId));
  const engagementSql: Record<Segment['engagement'], string> = blind
    ? {
        engaged_no_reply: 'replied = 0',
        no_reply: 'replied = 0',
        unengaged: 'replied = 0',
        engaged: '(positive = 1 OR replied = 0)',
      }
    : {
        engaged_no_reply: '(opened = 1 OR clicked = 1) AND replied = 0',
        no_reply: 'replied = 0',
        unengaged: 'opened = 0 AND clicked = 0 AND replied = 0',
        engaged: '(opened = 1 OR clicked = 1 OR positive = 1)',
      };

  const rows = await queryAll<{ person_id: string }>(
    db,
    `SELECT person_id FROM (
       SELECT p.id AS person_id,
              (SELECT MIN(i.occurred_at) FROM interactions i
                 JOIN campaigns c ON c.id = i.campaign_id
                WHERE i.workspace_id = ? AND i.person_id = p.id AND i.direction = 'outbound'
                  AND i.network = 'email' AND c.offering_id = ?) AS first_at,
              (SELECT MAX(i.occurred_at) FROM interactions i
                WHERE i.workspace_id = ? AND i.person_id = p.id
                  AND i.direction = 'outbound') AS last_out,
              CASE WHEN EXISTS (SELECT 1 FROM email_opens eo
                     WHERE eo.workspace_id = ? AND eo.person_id = p.id AND eo.automated IS NULL)
                   THEN 1 ELSE 0 END AS opened,
              CASE WHEN EXISTS (SELECT 1 FROM link_clicks lc
                     WHERE lc.workspace_id = ? AND lc.person_id = p.id AND lc.automated IS NULL)
                   THEN 1 ELSE 0 END AS clicked,
              CASE WHEN EXISTS (SELECT 1 FROM interactions r
                     WHERE r.workspace_id = ? AND r.person_id = p.id AND r.direction = 'inbound'
                       AND r.state IN ('replied', 'responded'))
                   THEN 1 ELSE 0 END AS replied,
              CASE WHEN EXISTS (SELECT 1 FROM interactions r
                     WHERE r.workspace_id = ? AND r.person_id = p.id AND r.direction = 'inbound'
                       AND r.reply_label IN ('interested', 'question', 'referral'))
                   THEN 1 ELSE 0 END AS positive,
              CASE WHEN EXISTS (SELECT 1 FROM signals cs
                     WHERE cs.workspace_id = ? AND cs.company_id = p.current_company_id
                       AND cs.signal_type = 'technology_adoption' AND cs.subtype = 'competitor')
                   THEN 1 ELSE 0 END AS competitor_user
         FROM people p
        WHERE p.status = 'active' AND p.outreach_eligible = 1
          AND EXISTS (SELECT 1 FROM campaign_people cp JOIN campaigns c ON c.id = cp.campaign_id
                       WHERE cp.person_id = p.id AND cp.workspace_id = ? AND c.offering_id = ?)
          -- Something to write to that has not bounced.
          AND (EXISTS (SELECT 1 FROM social_identities si
                        WHERE si.person_id = p.id AND si.network = 'email' AND si.handle IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM email_verifications ev
                                WHERE ev.address = lower(trim(si.handle)) AND ev.status = 'invalid'))
               OR EXISTS (SELECT 1 FROM person_emails pe
                        WHERE pe.person_id = p.id AND pe.workspace_id = ?
                          AND NOT EXISTS (SELECT 1 FROM email_verifications ev
                                WHERE ev.address = lower(trim(pe.address)) AND ev.status = 'invalid')))
          AND NOT EXISTS (SELECT 1 FROM interactions b
                WHERE b.workspace_id = ? AND b.person_id = p.id AND b.state = 'bounced')
          AND NOT EXISTS (SELECT 1 FROM interactions n
                WHERE n.workspace_id = ? AND n.person_id = p.id AND n.direction = 'inbound'
                  AND n.reply_label IN ('not_interested', 'unsubscribe_request'))
          AND NOT EXISTS (SELECT 1 FROM cadence_enrollments e
                WHERE e.workspace_id = ? AND e.person_id = p.id AND e.status = 'active')
          AND NOT EXISTS (SELECT 1 FROM campaign_people pc JOIN campaigns c ON c.id = pc.campaign_id
                WHERE pc.person_id = p.id AND c.workspace_id = ? AND c.seed_kind = 'planner'
                  AND (c.created_at >= ?
                       ${excluded.length > 0 ? `OR (c.created_at >= ? AND c.seed_value IN (${excluded.map(() => '?').join(', ')}))` : ''}))
     ) segment
     WHERE first_at IS NOT NULL AND (${rangeSql})
       AND (last_out IS NULL OR last_out < ?)
       AND ${engagementSql[segment.engagement]}
     ORDER BY ${segment.preferCompetitorUsers ? 'competitor_user DESC, ' : ''}first_at ASC
     LIMIT ?`,
    [
      workspaceId,
      offeringId,
      workspaceId,
      workspaceId,
      workspaceId,
      workspaceId,
      workspaceId,
      // competitor_user
      workspaceId,
      workspaceId,
      offeringId,
      workspaceId,
      workspaceId,
      workspaceId,
      workspaceId,
      workspaceId,
      monthStart,
      ...(excluded.length > 0 ? [yearStart, ...excluded] : []),
      ...rangeArgs,
      recent,
      input.limit,
    ],
  );
  return rows.map((row) => row.person_id);
}

/** Whether opens or clicks are recorded at all, i.e. whether they can be read as engagement. */
export async function tracksEngagement(db: Client, workspaceId: string): Promise<boolean> {
  const row = await queryOne<{ track_opens: number | null; track_links: number | null }>(
    db,
    'SELECT track_opens, track_links FROM workspace_settings WHERE workspace_id = ?',
    [workspaceId],
  );
  return Number(row?.track_opens ?? 0) === 1 || Number(row?.track_links ?? 0) === 1;
}

async function sourceCampaign(db: Client, offeringId: string): Promise<SourceCampaign | undefined> {
  // The product's busiest non-planner campaign sets the approval mode, voice
  // and limits: a product run on autopilot gets plays on autopilot, a product
  // whose owner approves everything gets plays that wait for approval.
  return queryOne<SourceCampaign>(
    db,
    `SELECT c.id, c.approval_mode, c.auto_reply_mode, c.voice_profile_id, c.budget_json
       FROM campaigns c
      WHERE c.offering_id = ? AND c.status != 'archived'
        AND (c.seed_kind IS NULL OR c.seed_kind <> 'planner')
      ORDER BY (SELECT COUNT(*) FROM interactions i
                 WHERE i.campaign_id = c.id AND i.direction = 'outbound') DESC,
               c.created_at ASC
      LIMIT 1`,
    [offeringId],
  );
}

async function alreadyRan(
  db: Client,
  offeringId: string,
  period: string,
  playKey: string,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM planner_runs WHERE offering_id = ? AND period = ? AND play_key = ?',
    [offeringId, period, playKey],
  );
  return row !== undefined;
}

async function recordRun(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly offeringId: string;
    readonly period: string;
    readonly playKey: string;
    readonly campaignId?: string;
    readonly cadenceId?: string;
    readonly people: number;
    readonly detail: Record<string, unknown>;
    readonly at: Date;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO planner_runs (id, workspace_id, offering_id, period, play_key, campaign_id,
          cadence_id, people, detail, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (offering_id, period, play_key) DO NOTHING`,
    args: [
      newId('plannerRun'),
      input.workspaceId,
      input.offeringId,
      input.period,
      input.playKey,
      input.campaignId ?? null,
      input.cadenceId ?? null,
      input.people,
      JSON.stringify(input.detail),
      input.at.toISOString(),
    ],
  });
}

export interface PlannerOverview {
  readonly period: string;
  readonly quarter: number;
  readonly month: number;
  readonly label: string;
  readonly buyingMode: string;
  readonly whatBuyersAreDoing: string;
  readonly benchmark: string;
  readonly plays: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly sequence: string;
  }>;
  readonly next: { readonly period: string; readonly label: string };
  /** False when neither opens nor clicks are tracked, so segments use delivery and replies. */
  readonly tracksEngagement: boolean;
  readonly offerings: ReadonlyArray<{
    readonly offeringId: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly runs: ReadonlyArray<{
      readonly period: string;
      readonly playKey: string;
      readonly campaignId: string | null;
      readonly people: number;
      readonly createdAt: string;
    }>;
  }>;
}

/** This month's plan, next month's, and what the planner launched per product. */
export async function plannerOverview(
  db: Client,
  workspaceId: string,
  at: Date = new Date(),
): Promise<PlannerOverview> {
  const month = plannerMonth(at);
  const nextAt = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  const next = plannerMonth(nextAt);

  const offerings = await queryAll<{ id: string; name: string; planner_enabled: number | null }>(
    db,
    `SELECT id, name, planner_enabled FROM offerings WHERE workspace_id = ? ORDER BY name`,
    [workspaceId],
  );
  const runs = await queryAll<{
    offering_id: string;
    period: string;
    play_key: string;
    campaign_id: string | null;
    people: number;
    created_at: string;
  }>(
    db,
    `SELECT offering_id, period, play_key, campaign_id, people, created_at FROM planner_runs
      WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 500`,
    [workspaceId],
  );

  return {
    period: plannerPeriod(at),
    quarter: month.quarter,
    month: month.month,
    label: month.label,
    buyingMode: BUYING_MODE_LABELS[month.buyingMode],
    whatBuyersAreDoing: month.whatBuyersAreDoing,
    benchmark: month.benchmark,
    plays: month.plays.map((play) => ({
      key: play.key,
      title: play.title,
      sequence: play.sequence,
    })),
    next: { period: plannerPeriod(nextAt), label: next.label },
    tracksEngagement: await tracksEngagement(db, workspaceId),
    offerings: offerings.map((offering) => ({
      offeringId: offering.id,
      name: offering.name,
      enabled: (offering.planner_enabled ?? 1) === 1,
      runs: runs
        .filter((run) => run.offering_id === offering.id)
        .map((run) => ({
          period: run.period,
          playKey: run.play_key,
          campaignId: run.campaign_id,
          people: Number(run.people),
          createdAt: run.created_at,
        })),
    })),
  };
}

/** Turns the planner on or off for one product. False when no such product. */
export async function setPlannerEnabled(
  db: Client,
  workspaceId: string,
  offeringId: string,
  enabled: boolean,
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE offerings SET planner_enabled = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    args: [enabled ? 1 : 0, now(), offeringId, workspaceId],
  });
  return (result.rowsAffected ?? 0) > 0;
}

/** The whole year, for the API and the page. */
export function plannerYear(): typeof PLANNER_YEAR {
  return PLANNER_YEAR;
}
