/**
 * Starting a campaign from one line of text.
 *
 * The product used to have two front doors and neither was the one people
 * wanted. `POST /prospects` took a **GitHub handle**, which is a strange thing
 * to ask a salesperson for, and `POST /prospects/by-url` took a list of URLs,
 * which assumes you already know exactly who you are chasing.
 *
 * There is now one: a box that takes either a company website or a description
 * of a market, works out which it got, and starts a campaign for it. Both
 * paths converge on the same queue within a second or two of the request, so
 * the response is a campaign the caller can watch rather than a result they
 * have to wait for.
 */

import { classifyIntake, newId, type ClassifiedIntake } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { emitEvent, enqueue } from '@outreachgraph/pipeline';

export interface IntakeActor {
  readonly workspaceId: string;
  readonly userId: string;
}

export interface CampaignIntakeResult {
  readonly campaignId: string;
  readonly name: string;
  readonly kind: 'url' | 'keyword';
  readonly seed: string;
  readonly autopilot: boolean;
  readonly batchId: string;
  /** Sites queued immediately. Zero for a keyword — discovery queues them. */
  readonly queued: number;
  /**
   * True when the workspace has not described what it sells yet.
   *
   * The run still starts. Drafts are grounded in a placeholder offering until
   * the profile is filled in, which is worse output rather than no output, and
   * blocking the first campaign on a form is how a product feels broken.
   */
  readonly needsProfile: boolean;
}

export class IntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntakeError';
  }
}

/**
 * Creates a campaign from whatever the user typed, and queues its first work.
 *
 * Autopilot is a parameter rather than a default. `trusted_automation` is
 * opt-in by design — the policy engine will not skip human approval without
 * it — so switching it on has to be something the caller asked for.
 */
export async function createCampaignFromIntake(
  db: Client,
  actor: IntakeActor,
  rawInput: string,
  options: { autopilot?: boolean; name?: string } = {},
): Promise<CampaignIntakeResult> {
  const intake = classifyIntake(rawInput);

  if (!intake) {
    throw new IntakeError('enter a company website or describe who you want to reach');
  }

  const offering = await ensureOffering(db, actor.workspaceId);
  const campaignId = newId('campaign');
  const stamp = now();
  const name = options.name?.trim() || defaultName(intake);

  await db.execute({
    sql: `INSERT INTO campaigns (id, workspace_id, name, offering_id, networks, approval_mode,
          status, seed_kind, seed_value, created_at, updated_at, started_at)
          VALUES (?, ?, ?, ?, '["website","email"]', ?, 'active', ?, ?, ?, ?, ?)`,
    args: [
      campaignId,
      actor.workspaceId,
      name,
      offering.id,
      options.autopilot ? 'trusted_automation' : 'draft_and_approve',
      intake.kind,
      intake.value,
      stamp,
      stamp,
      stamp,
    ],
  });

  const batchId = newId('job');
  let queued = 0;

  if (intake.kind === 'url') {
    const result = await enqueue(db, {
      workspaceId: actor.workspaceId,
      kind: 'crawl_site',
      payload: { url: `https://${intake.value}`, campaignId },
      batchId,
      dedupeKey: `crawl:${campaignId}:${intake.value}`,
    });
    if (result.queued) queued += 1;
  } else {
    // Discovery runs as a job, not here: it is a model call plus up to fifty
    // enqueues, and a form that hangs for thirty seconds is a form people
    // abandon halfway through.
    await enqueue(db, {
      workspaceId: actor.workspaceId,
      kind: 'discover_domains',
      payload: { keyword: intake.value, campaignId },
      batchId,
      dedupeKey: `discover:${campaignId}`,
    });
  }

  await emitEvent(db, {
    workspaceId: actor.workspaceId,
    campaignId,
    phase: 'intake',
    level: 'success',
    message:
      intake.kind === 'url'
        ? `Started “${name}” from ${intake.value}`
        : `Started “${name}” — looking for companies matching “${intake.value}”`,
    detail: { kind: intake.kind, seed: intake.value, autopilot: options.autopilot === true },
  });

  return {
    campaignId,
    name,
    kind: intake.kind,
    seed: intake.value,
    autopilot: options.autopilot === true,
    batchId,
    queued,
    needsProfile: offering.placeholder,
  };
}

export interface CampaignSummary {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly approval_mode: string;
  readonly seed_kind: string | null;
  readonly seed_value: string | null;
  readonly brief: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  /** Leads in this campaign, and how far they have got. */
  readonly people: number;
  readonly contacted: number;
  readonly replied: number;
  readonly awaiting_approval: number;
  /** Crawls and discoveries still outstanding, so "still working" is visible. */
  readonly jobs_pending: number;
  readonly last_activity_at: string | null;
}

/**
 * Every campaign in the workspace, with enough on each row to choose between
 * them.
 *
 * A bare list of names was fine when there was effectively one campaign. With
 * several running at once the only question anyone asks is "which of these is
 * actually doing anything", so the counts are part of the list rather than
 * something you learn by opening each one in turn.
 *
 * The counts are correlated subqueries rather than joins on purpose: a campaign
 * with no leads must still appear, and four `LEFT JOIN`s with `GROUP BY` over
 * the same base table is how a row silently multiplies.
 */
export async function listCampaigns(db: Client, workspaceId: string): Promise<CampaignSummary[]> {
  return queryAll<CampaignSummary>(
    db,
    `SELECT c.id, c.name, c.status, c.approval_mode, c.seed_kind, c.seed_value, c.brief,
            c.created_at, c.started_at,
            (SELECT COUNT(*) FROM campaign_people cp WHERE cp.campaign_id = c.id) AS people,
            (SELECT COUNT(*) FROM campaign_people cp
              WHERE cp.campaign_id = c.id AND cp.interaction_state = 'contacted') AS contacted,
            (SELECT COUNT(*) FROM interactions i
              WHERE i.campaign_id = c.id AND i.direction = 'inbound') AS replied,
            (SELECT COUNT(*) FROM recommendations r
              WHERE r.campaign_id = c.id AND r.status = 'pending') AS awaiting_approval,
            (SELECT COUNT(*) FROM jobs j
              WHERE j.workspace_id = c.workspace_id
                AND j.status IN ('pending', 'running')
                AND j.payload_json LIKE '%' || c.id || '%') AS jobs_pending,
            (SELECT MAX(e.occurred_at) FROM lead_stage_events e
              WHERE e.campaign_id = c.id) AS last_activity_at
       FROM campaigns c
      WHERE c.workspace_id = ?
      ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
               c.created_at DESC`,
    [workspaceId],
  );
}

/**
 * Pauses or resumes a campaign.
 *
 * Pausing is the control people reach for that autopilot alone does not give
 * them: switching autopilot off still leaves the campaign crawling, scoring and
 * filling the approval queue. `paused` stops the work; `active` resumes it.
 */
export async function setCampaignStatus(
  db: Client,
  workspaceId: string,
  campaignId: string,
  status: 'active' | 'paused',
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE campaigns SET status = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND status != 'archived'`,
    args: [status, now(), campaignId, workspaceId],
  });

  if (result.rowsAffected > 0) {
    await emitEvent(db, {
      workspaceId,
      campaignId,
      phase: 'system',
      level: status === 'paused' ? 'warn' : 'info',
      message: status === 'paused' ? 'Campaign paused' : 'Campaign resumed',
    });
  }

  return result.rowsAffected > 0;
}

/**
 * Archives a campaign and cancels its outstanding work.
 *
 * Leaving the queue alone would mean an archived campaign kept crawling for
 * hours — the jobs were queued before the archive and know nothing about it.
 * The rows are marked `done` rather than deleted so the batch view of a
 * half-finished run still resolves.
 */
export async function archiveCampaign(
  db: Client,
  workspaceId: string,
  campaignId: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE campaigns SET status = 'archived', updated_at = ?
           WHERE id = ? AND workspace_id = ?`,
    args: [now(), campaignId, workspaceId],
  });

  if (result.rowsAffected === 0) return false;

  await db.execute({
    sql: `UPDATE jobs SET status = 'done', finished_at = ?, last_error = 'campaign archived',
             updated_at = ?
           WHERE workspace_id = ? AND status = 'pending'
             AND payload_json LIKE '%' || ? || '%'`,
    args: [now(), now(), workspaceId, campaignId],
  });

  await emitEvent(db, {
    workspaceId,
    campaignId,
    phase: 'system',
    level: 'warn',
    message: 'Campaign archived — its queued work was cancelled',
  });

  return true;
}

export async function renameCampaign(
  db: Client,
  workspaceId: string,
  campaignId: string,
  name: string,
): Promise<boolean> {
  const trimmed = name.trim().slice(0, 200);
  if (!trimmed) return false;

  const result = await db.execute({
    sql: `UPDATE campaigns SET name = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    args: [trimmed, now(), campaignId, workspaceId],
  });

  return result.rowsAffected > 0;
}

function defaultName(intake: ClassifiedIntake): string {
  return intake.kind === 'url' ? intake.value : intake.raw.slice(0, 120);
}

interface EnsuredOffering {
  readonly id: string;
  /** True when this was invented just now because the workspace had none. */
  readonly placeholder: boolean;
}

/**
 * The workspace's offering, creating a placeholder if there is none.
 *
 * `campaigns.offering_id` is NOT NULL, so without this a workspace that has
 * not been through setup cannot start a campaign at all — the first thing a
 * new account tries would fail on a foreign key. A placeholder produces weaker
 * drafts, which the caller is told about, rather than a dead end.
 */
async function ensureOffering(db: Client, workspaceId: string): Promise<EnsuredOffering> {
  const existing = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM offerings WHERE workspace_id = ? ORDER BY created_at LIMIT 1`,
    [workspaceId],
  );

  if (existing) return { id: existing.id, placeholder: false };

  const id = newId('offering');
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO offerings (id, workspace_id, name, category, description,
          value_propositions, likely_pains, competitors, created_at, updated_at)
          VALUES (?, ?, 'Unconfigured offering', 'unspecified',
                  'Set up your profile so messages can describe what you actually sell.',
                  '[]', '[]', '[]', ?, ?)`,
    args: [id, workspaceId, stamp, stamp],
  });

  return { id, placeholder: true };
}

/**
 * Turns autopilot on or off for one campaign.
 *
 * This is the only switch that matters for unattended sending, and it is
 * deliberately a campaign-level setting rather than a workspace-level one: a
 * customer may reasonably want one market run hands-off and another watched.
 */
export async function setCampaignAutopilot(
  db: Client,
  workspaceId: string,
  campaignId: string,
  autopilot: boolean,
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE campaigns SET approval_mode = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ?`,
    args: [autopilot ? 'trusted_automation' : 'draft_and_approve', now(), campaignId, workspaceId],
  });

  return result.rowsAffected > 0;
}

/**
 * Merges tunable limits into a campaign's stored budget.
 *
 * Merged rather than replaced: `budget_json` also carries the spend ceilings,
 * and a caller adjusting the daily send cap must not silently drop
 * `maxAiSpendUsd` on its way past. Undefined fields are left as they were, so
 * omitting a key means "leave it alone" and not "reset it to the default".
 */
export async function setCampaignLimits(
  db: Client,
  workspaceId: string,
  campaignId: string,
  limits: Record<string, number>,
): Promise<Record<string, unknown> | undefined> {
  const row = await queryOne<{ budget_json: string }>(
    db,
    'SELECT budget_json FROM campaigns WHERE id = ? AND workspace_id = ?',
    [campaignId, workspaceId],
  );

  if (!row) return undefined;

  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.budget_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    // A budget we cannot read is replaced rather than allowed to block the
    // write; the caller's values are the ones they just asked for.
  }

  const merged = { ...current, ...limits };

  await db.execute({
    sql: `UPDATE campaigns SET budget_json = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ?`,
    args: [JSON.stringify(merged), now(), campaignId, workspaceId],
  });

  return merged;
}

export interface WorkspaceSettingsInput {
  readonly notifyEmail?: string | null;
  readonly instantAlerts?: boolean;
  readonly dailyDigest?: boolean;
  readonly digestHourUtc?: number;
  readonly alertMinOpportunity?: number;
  readonly autopilotDailyCap?: number;
  readonly replyToEmail?: string | null;
  readonly trackLinks?: boolean;
  readonly trackingOrigin?: string | null;
}

/**
 * Upserts notification and autopilot settings.
 *
 * Written as one insert-or-update so a workspace that has never opened the
 * settings page behaves identically to one that saved the defaults — there is
 * no "no row yet" state for callers to handle.
 */
export async function saveWorkspaceSettings(
  db: Client,
  workspaceId: string,
  input: WorkspaceSettingsInput,
): Promise<void> {
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO workspace_settings (workspace_id, notify_email, instant_alerts,
            daily_digest, digest_hour_utc, alert_min_opportunity, autopilot_daily_cap,
            reply_to_email, track_links, tracking_origin, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET
            notify_email = COALESCE(excluded.notify_email, workspace_settings.notify_email),
            instant_alerts = excluded.instant_alerts,
            daily_digest = excluded.daily_digest,
            digest_hour_utc = excluded.digest_hour_utc,
            alert_min_opportunity = excluded.alert_min_opportunity,
            autopilot_daily_cap = excluded.autopilot_daily_cap,
            reply_to_email = COALESCE(excluded.reply_to_email, workspace_settings.reply_to_email),
            track_links = excluded.track_links,
            tracking_origin = COALESCE(excluded.tracking_origin, workspace_settings.tracking_origin),
            updated_at = excluded.updated_at`,
    args: [
      workspaceId,
      input.notifyEmail ?? null,
      input.instantAlerts === false ? 0 : 1,
      input.dailyDigest === false ? 0 : 1,
      clampInt(input.digestHourUtc, 0, 23, 13),
      clampInt(input.alertMinOpportunity, 0, 100, 60),
      clampInt(input.autopilotDailyCap, 0, 500, 25),
      input.replyToEmail ?? null,
      // Opt-in, and it stays opt-in: a caller that omits the field is saying
      // nothing about tracking, and "nothing" must not turn it on.
      input.trackLinks === true ? 1 : 0,
      input.trackingOrigin ?? null,
      stamp,
      stamp,
    ],
  });
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}
