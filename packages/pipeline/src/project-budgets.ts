/**
 * Dollars per day, per project, turned into caps the policy engine enforces.
 *
 * Nothing here sends anything and nothing here refuses anything. A budget set
 * through the AutoGTM surface becomes `dailyBudgetUsd` and `maxActionsPerDay`
 * on the campaign's `budget_json`, and from there the existing engine reads it
 * the same way it reads a cap set from the settings page. That is the whole
 * design: a limit enforced outside the policy engine is a limit the approval
 * queue, autopilot and the cadence runner each have to remember separately.
 *
 * The allocator runs once a tick per workspace and once, synchronously, after
 * any change to a project's budget or autopilot, so the number the API hands
 * back is the number the worker will act on.
 */

import {
  allocateDailyBudget,
  capUnderCeiling,
  dailyContactsFor,
  roundUsd,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';

/** How far back reply performance is read when splitting a budget. */
const PERFORMANCE_WINDOW_DAYS = 14;

export interface CampaignBudget {
  readonly dailyBudgetUsd: number | undefined;
  readonly maxActionsPerDay: number | undefined;
}

export function readBudgetJson(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function campaignBudgetFrom(text: string | null | undefined): CampaignBudget {
  const budget = readBudgetJson(text);
  return {
    dailyBudgetUsd:
      typeof budget.dailyBudgetUsd === 'number' && Number.isFinite(budget.dailyBudgetUsd)
        ? budget.dailyBudgetUsd
        : undefined,
    maxActionsPerDay:
      typeof budget.maxActionsPerDay === 'number' && Number.isFinite(budget.maxActionsPerDay)
        ? budget.maxActionsPerDay
        : undefined,
  };
}

/**
 * Sets one campaign's daily budget, writing the cap alongside it.
 *
 * `null` clears both, returning the campaign to whatever cap it had by
 * default. Merged into the existing budget so the anti-spam knobs beside it
 * survive. Returns the stored budget, or undefined for a campaign this
 * workspace does not hold.
 */
export async function setCampaignDailyBudget(
  db: Client,
  workspaceId: string,
  campaignId: string,
  dailyBudgetUsd: number | null,
): Promise<CampaignBudget | undefined> {
  const row = await queryOne<{ budget_json: string }>(
    db,
    'SELECT budget_json FROM campaigns WHERE id = ? AND workspace_id = ?',
    [campaignId, workspaceId],
  );
  if (!row) return undefined;

  const current = readBudgetJson(row.budget_json);
  const next: Record<string, unknown> = { ...current };

  if (dailyBudgetUsd === null) {
    delete next.dailyBudgetUsd;
    delete next.maxActionsPerDay;
  } else {
    next.dailyBudgetUsd = roundUsd(dailyBudgetUsd);
    next.maxActionsPerDay = dailyContactsFor(dailyBudgetUsd);
  }

  const serialised = JSON.stringify(next);
  if (serialised !== JSON.stringify(current)) {
    await db.execute({
      sql: 'UPDATE campaigns SET budget_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
      args: [serialised, now(), campaignId, workspaceId],
    });
  }

  return campaignBudgetFrom(serialised);
}

export interface ProjectBudgetRow {
  readonly id: string;
  readonly daily_budget_usd: number | null;
  readonly autopilot: number;
}

export interface ApplyResult {
  /** Campaigns whose stored budget changed. */
  readonly changed: number;
  readonly projects: number;
}

/**
 * Brings every campaign's budget into line with its project's.
 *
 * Autopilot on: the project's ceiling is split across its active campaigns by
 * reply rate and written to each. Autopilot off: campaign budgets are the
 * customer's own and are only scaled down when together they would exceed the
 * ceiling. A project without a ceiling is left entirely alone, which is every
 * project that predates this.
 */
export async function applyProjectBudgets(db: Client, workspaceId: string): Promise<ApplyResult> {
  const projects = await queryAll<ProjectBudgetRow>(
    db,
    `SELECT id, daily_budget_usd, autopilot FROM offerings
      WHERE workspace_id = ? AND daily_budget_usd IS NOT NULL`,
    [workspaceId],
  );

  let changed = 0;

  for (const project of projects) {
    changed += await applyOneProject(db, workspaceId, project);
  }

  return { changed, projects: projects.length };
}

/** The same reconciliation for one project, run after its settings change. */
export async function applyProjectBudget(
  db: Client,
  workspaceId: string,
  offeringId: string,
): Promise<number> {
  const project = await queryOne<ProjectBudgetRow>(
    db,
    `SELECT id, daily_budget_usd, autopilot FROM offerings WHERE id = ? AND workspace_id = ?`,
    [offeringId, workspaceId],
  );
  if (!project || project.daily_budget_usd === null) return 0;
  return applyOneProject(db, workspaceId, project);
}

async function applyOneProject(
  db: Client,
  workspaceId: string,
  project: ProjectBudgetRow,
): Promise<number> {
  const ceiling = Math.max(0, project.daily_budget_usd ?? 0);
  const since = new Date(Date.now() - PERFORMANCE_WINDOW_DAYS * 24 * 3_600_000).toISOString();

  const campaigns = await queryAll<{
    id: string;
    budget_json: string;
    contacted: number;
    replies: number;
  }>(
    db,
    `SELECT c.id, c.budget_json,
            (SELECT COUNT(*) FROM interactions i
               JOIN campaign_people cp ON cp.person_id = i.person_id AND cp.campaign_id = c.id
              WHERE i.workspace_id = c.workspace_id AND i.direction = 'outbound'
                AND i.occurred_at >= ?) AS contacted,
            (SELECT COUNT(*) FROM interactions i
               JOIN campaign_people cp ON cp.person_id = i.person_id AND cp.campaign_id = c.id
              WHERE i.workspace_id = c.workspace_id AND i.direction = 'inbound'
                AND i.occurred_at >= ?) AS replies
       FROM campaigns c
      WHERE c.workspace_id = ? AND c.offering_id = ? AND c.status NOT IN ('paused', 'archived', 'draft')
      ORDER BY c.created_at`,
    [since, since, workspaceId, project.id],
  );

  if (campaigns.length === 0) return 0;

  let target: ReadonlyMap<string, number>;

  if (project.autopilot === 1) {
    target = allocateDailyBudget({
      totalUsd: ceiling,
      campaigns: campaigns.map((row) => ({
        id: row.id,
        contacted: Number(row.contacted),
        replies: Number(row.replies),
      })),
    });
  } else {
    const own = new Map<string, number>();
    for (const row of campaigns) {
      const budget = campaignBudgetFrom(row.budget_json);
      if (budget.dailyBudgetUsd !== undefined) own.set(row.id, budget.dailyBudgetUsd);
    }
    target = capUnderCeiling(own, ceiling);
  }

  let changed = 0;
  for (const row of campaigns) {
    const wanted = target.get(row.id);
    if (wanted === undefined) continue;

    const before = campaignBudgetFrom(row.budget_json);
    if (before.dailyBudgetUsd === wanted && before.maxActionsPerDay === dailyContactsFor(wanted)) {
      continue;
    }

    await setCampaignDailyBudget(db, workspaceId, row.id, wanted);
    changed += 1;
  }

  return changed;
}
