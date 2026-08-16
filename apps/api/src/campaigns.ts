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
import { now, queryOne, type Client } from '@outreachgraph/db';
import { enqueue } from '@outreachgraph/pipeline';

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

export interface WorkspaceSettingsInput {
  readonly notifyEmail?: string | null;
  readonly instantAlerts?: boolean;
  readonly dailyDigest?: boolean;
  readonly digestHourUtc?: number;
  readonly alertMinOpportunity?: number;
  readonly autopilotDailyCap?: number;
  readonly replyToEmail?: string | null;
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
            reply_to_email, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET
            notify_email = COALESCE(excluded.notify_email, workspace_settings.notify_email),
            instant_alerts = excluded.instant_alerts,
            daily_digest = excluded.daily_digest,
            digest_hour_utc = excluded.digest_hour_utc,
            alert_min_opportunity = excluded.alert_min_opportunity,
            autopilot_daily_cap = excluded.autopilot_daily_cap,
            reply_to_email = COALESCE(excluded.reply_to_email, workspace_settings.reply_to_email),
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
