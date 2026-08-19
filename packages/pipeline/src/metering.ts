/**
 * Counting what a workspace has used, and refusing when it runs out.
 *
 * `packages/policy` has had a `budget_exhausted` gate since the first version
 * and nothing has ever set it — `budgetExhausted` was simply never passed, so
 * the gate was dead code protecting nothing. This is the other half.
 *
 * Usage is **derived, never counted into a column.** A `credits_used` integer
 * incremented on every send is a number that drifts: a crashed job, a retried
 * request or a manual database fix leaves it permanently wrong, and nothing
 * ever notices because there is nothing to compare it against. Deriving from
 * `interactions` means the meter and the audit trail cannot disagree, and a
 * recount is a query rather than a migration.
 */

import {
  ADMIN_PLAN,
  newId,
  periodStart,
  planById,
  type Plan,
  type UsageSnapshot,
} from '@outreachgraph/domain';
import { queryOne, type Client } from '@outreachgraph/db';

/**
 * What this workspace has used in the calendar month containing `at`.
 *
 * Prospects are counted distinct: contacting the same person four times in a
 * cadence costs one, which is what makes the follow-up that actually works
 * free rather than penalised.
 */
export async function usageFor(
  db: Client,
  workspaceId: string,
  at: Date = new Date(),
): Promise<UsageSnapshot> {
  const since = periodStart(at).toISOString();

  const contacted = await queryOne<{ n: number }>(
    db,
    `SELECT count(DISTINCT person_id) AS n FROM interactions
      WHERE workspace_id = ? AND direction = 'outbound' AND occurred_at >= ?`,
    [workspaceId, since],
  );

  const cells = await queryOne<{ n: number }>(
    db,
    `SELECT coalesce(sum(quantity), 0) AS n FROM usage_events
      WHERE workspace_id = ? AND unit = 'research_cell' AND occurred_at >= ?`,
    [workspaceId, since],
  );

  return {
    prospectsContacted: Number(contacted?.n ?? 0),
    gridCells: Number(cells?.n ?? 0),
  };
}

/**
 * Whether this workspace belongs to an organization that platform staff own.
 *
 * Keyed on the **owner**, not on membership. A staff account added to a
 * customer's organization to look at a problem is a `member` or a `viewer`
 * there, and that must not silently lift the customer's ceiling — the
 * exemption is meant to stop us metering ourselves, not to leak onto whoever
 * we last helped.
 */
async function isStaffOrganization(db: Client, workspaceId: string): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n
       FROM workspaces w
       JOIN organization_members m ON m.organization_id = w.organization_id
       JOIN users u ON u.id = m.user_id
      WHERE w.id = ? AND m.role = 'owner' AND u.is_admin = 1`,
    [workspaceId],
  );

  return Number(row?.n ?? 0) > 0;
}

/**
 * The plan this workspace is on.
 *
 * Billing lives on the organization rather than the workspace, so two
 * workspaces in one organization share an allowance. That is deliberate: the
 * alternative is a customer creating workspaces to reset a meter.
 */
export async function planFor(db: Client, workspaceId: string): Promise<Plan> {
  // Staff first, because it is the one answer a billing row must not be able
  // to override. Doing it here rather than at each call site is what makes it
  // cover the approval queue, autopilot, the cadence runner and the research
  // grid at once — `planFor` is the only road to a limit, so an exemption
  // placed anywhere else is one that some fourth caller has to remember.
  if (await isStaffOrganization(db, workspaceId)) return ADMIN_PLAN;

  const row = await queryOne<{ plan: string; status: string }>(
    db,
    `SELECT b.plan, b.status
       FROM workspaces w
       JOIN billing_accounts b ON b.organization_id = w.organization_id
      WHERE w.id = ?`,
    [workspaceId],
  );

  // No billing account is the free plan, not unlimited. A workspace that
  // predates billing must not be the one that can send without limit.
  if (!row) return planById('free');

  // A suspended or past-due account keeps its plan's shape but is treated as
  // free for limits, so service degrades to a trickle rather than stopping
  // dead — a customer whose card expired should not lose a campaign.
  if (row.status !== 'active') return planById('free');

  return planById(row.plan);
}

export interface BudgetStatus {
  readonly exhausted: boolean;
  readonly plan: Plan;
  readonly usage: UsageSnapshot;
  readonly reason?: string;
}

/**
 * Whether outbound work is still within the month's allowance.
 *
 * Called on the policy path, where it becomes the `budgetExhausted` input to
 * the deterministic engine rather than a separate check somewhere else. That
 * matters: a limit enforced outside the policy engine is a limit that the
 * approval queue, autopilot and the cadence runner each have to remember
 * independently, and one of them eventually will not.
 */
export async function budgetStatus(
  db: Client,
  workspaceId: string,
  at: Date = new Date(),
): Promise<BudgetStatus> {
  const [plan, usage] = await Promise.all([
    planFor(db, workspaceId),
    usageFor(db, workspaceId, at),
  ]);

  const exhausted = usage.prospectsContacted >= plan.prospectsPerMonth;

  return {
    exhausted,
    plan,
    usage,
    ...(exhausted
      ? {
          reason: `The ${plan.name} plan covers ${plan.prospectsPerMonth} prospects a month and ${usage.prospectsContacted} have been contacted.`,
        }
      : {}),
  };
}

/**
 * Records research spend.
 *
 * One row per answered cell rather than one per grid, so a grid abandoned
 * halfway is charged for what it actually consumed. The unit is named
 * `research_cell` rather than reusing `ai` because the two are metered against
 * different allowances and a shared name would make them impossible to
 * separate later.
 */
export async function recordResearchUsage(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly campaignId?: string | undefined;
    readonly personId?: string | undefined;
    readonly cells: number;
    readonly at?: string;
  },
): Promise<void> {
  if (input.cells <= 0) return;

  await db.execute({
    sql: `INSERT INTO usage_events (id, workspace_id, campaign_id, person_id, unit,
          quantity, occurred_at)
          VALUES (?, ?, ?, ?, 'research_cell', ?, ?)`,
    args: [
      newId('usageEvent'),
      input.workspaceId,
      input.campaignId ?? null,
      input.personId ?? null,
      input.cells,
      input.at ?? new Date().toISOString(),
    ],
  });
}
