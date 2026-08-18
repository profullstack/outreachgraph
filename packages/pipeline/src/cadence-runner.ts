/**
 * Wiring the cadence scheduler to the real policy engine and the real queue.
 *
 * `advanceCadences` is deliberately abstract about both — it takes a function
 * that answers "what are the policy inputs for this person" and one that writes
 * a recommendation, so the scheduler can be tested without a mail server or a
 * capability matrix loaded from the database. This module is the production
 * answer to both, and the only place the two meet.
 *
 * The counting here mirrors `pipeline.ts` rather than inventing its own. A
 * second implementation of "how many actions has this workspace taken today"
 * would drift from the first on the day someone changes what counts as an
 * action, and the failure mode is a cadence that quietly ignores the daily cap.
 */

import { newId, type CadenceStep, type Network } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import type { PolicyDecision, PolicyRequest } from '@outreachgraph/policy';
import { advanceCadences, type AdvanceResult, type DueEnrollment } from './cadence';

export interface RunCadencesDeps {
  readonly db: Client;
  /**
   * True when this deployment can put email on the wire without the workspace
   * connecting a mailbox. Mirrors the same flag on the approval path, which
   * exists because the two used to disagree and the human-facing one was the
   * broken one.
   */
  readonly platformEmailEnabled?: boolean;
  readonly now?: Date;
  readonly limit?: number;
}

/**
 * Runs every due cadence step for one workspace.
 *
 * Returns the same report `advanceCadences` produces, so a caller can log what
 * a tick did without knowing how a step is resolved.
 */
export async function runCadences(
  deps: RunCadencesDeps,
  workspaceId: string,
): Promise<AdvanceResult> {
  return advanceCadences(
    {
      db: deps.db,
      policyFor: (enrollment, step) =>
        policyInputsFor(deps.db, enrollment, step, deps.platformEmailEnabled === true),
      createRecommendation: (input) => writeCadenceRecommendation(deps.db, input),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.limit === undefined ? {} : { limit: deps.limit }),
    },
    workspaceId,
  );
}

/**
 * Everything the policy engine needs about one person, for one step.
 *
 * Network-specific by design. Resolving `hasConnectedAccount` workspace-wide
 * would let a connected mailbox authorise a step on a network the workspace
 * has never connected at all.
 */
async function policyInputsFor(
  db: Client,
  enrollment: DueEnrollment,
  step: CadenceStep,
  platformEmailEnabled: boolean,
): Promise<Omit<PolicyRequest, 'action' | 'network'>> {
  const [person, workspace, campaign] = await Promise.all([
    queryOne<{
      status: string;
      believed_minor: number;
      identity_confidence: number;
    }>(db, 'SELECT status, believed_minor, identity_confidence FROM people WHERE id = ?', [
      enrollment.person_id,
    ]),
    queryOne<{ min_outreach_confidence: number | null }>(
      db,
      'SELECT min_outreach_confidence FROM workspaces WHERE id = ?',
      [enrollment.workspace_id],
    ),
    queryOne<{ approval_mode: string; budget_json: string | null }>(
      db,
      'SELECT approval_mode, budget_json FROM campaigns WHERE id = ?',
      [enrollment.campaign_id],
    ),
  ]);

  const budget = parseJson(campaign?.budget_json);

  const [counts, flags, connected, replied] = await Promise.all([
    actionCounts(db, enrollment.workspace_id, enrollment.person_id),
    featureFlags(db, enrollment.workspace_id),
    hasConnectedAccount(db, enrollment.workspace_id, step.network),
    conversationOpen(db, enrollment.workspace_id, enrollment.person_id),
  ]);

  const suppressed =
    person?.status === 'suppressed' ||
    (await isSuppressed(db, enrollment.workspace_id, enrollment.person_id));

  return {
    approvalMode: (campaign?.approval_mode ?? 'draft_and_approve') as 'draft_and_approve',
    hasConnectedAccount: connected || (step.network === 'email' && platformEmailEnabled),
    personSuppressed: suppressed,
    personBelievedMinor: person?.believed_minor === 1,
    personDeleted: person?.status === 'deleted',
    identityConfidence: person?.identity_confidence ?? 0,
    minIdentityConfidence: workspace?.min_outreach_confidence ?? 0.85,
    actionsToday: counts.today,
    maxActionsPerDay: numberOr(budget.maxActionsPerDay, 50),
    actionsToThisProspectThisWeek: counts.thisProspect,
    maxActionsPerProspectPerWeek: numberOr(budget.maxActionsPerProspectPerWeek, 1),
    ...(counts.hoursSinceLast === undefined
      ? {}
      : { hoursSinceLastActionToProspect: counts.hoursSinceLast }),
    conversationOpen: replied,
    featureFlags: flags,
  };
}

/**
 * Writes the card a runnable step produces.
 *
 * Deliberately does not draft anything. A pending outbound recommendation with
 * no draft is already a case the product handles — the draft sweep picks it up
 * — and composing inline would put a model call inside the scheduler's loop,
 * where one slow response delays every other enrollment in the tick.
 */
async function writeCadenceRecommendation(
  db: Client,
  input: {
    readonly enrollment: DueEnrollment;
    readonly step: CadenceStep;
    readonly decision: PolicyDecision;
    readonly policyVersion: string;
  },
): Promise<string | undefined> {
  const { enrollment, step } = input;

  // A card for this exact step may already be sitting in the queue unread. A
  // second one would be the same ask twice, and approving both would send the
  // same touch twice.
  const existing = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM recommendations
      WHERE workspace_id = ? AND campaign_id = ? AND person_id = ?
        AND action = ? AND network = ? AND status = 'pending'`,
    [
      enrollment.workspace_id,
      enrollment.campaign_id,
      enrollment.person_id,
      step.action,
      step.network,
    ],
  );

  if (existing) return existing.id;

  const id = newId('recommendation');
  const score = await queryOne<{ opportunity: number }>(
    db,
    'SELECT opportunity FROM scores WHERE campaign_id = ? AND person_id = ?',
    [enrollment.campaign_id, enrollment.person_id],
  );

  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
          priority, reason, policy_status, policy_version, expected_goal, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'start_conversation', 'pending', ?)`,
    args: [
      id,
      enrollment.workspace_id,
      enrollment.campaign_id,
      enrollment.person_id,
      step.action,
      step.network,
      Number(score?.opportunity ?? 0),
      step.intent?.trim()
        ? `Cadence step ${step.position + 1}: ${step.intent.trim()}`
        : `Cadence step ${step.position + 1}.`,
      input.decision,
      input.policyVersion,
      now(),
    ],
  });

  return id;
}

// ------------------------------------------------------------------ reads

async function actionCounts(
  db: Client,
  workspaceId: string,
  personId: string,
): Promise<{ today: number; thisProspect: number; hoursSinceLast?: number }> {
  const today = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM actions
      WHERE workspace_id = ? AND created_at >= datetime('now', '-1 day')`,
    [workspaceId],
  );

  const week = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM actions
      WHERE workspace_id = ? AND person_id = ? AND created_at >= datetime('now', '-7 day')`,
    [workspaceId, personId],
  );

  const last = await queryOne<{ hours: number | null }>(
    db,
    `SELECT (julianday('now') - julianday(max(created_at))) * 24 AS hours
       FROM actions WHERE workspace_id = ? AND person_id = ?`,
    [workspaceId, personId],
  );

  const hours = last?.hours;

  return {
    today: Number(today?.n ?? 0),
    thisProspect: Number(week?.n ?? 0),
    ...(hours === null || hours === undefined ? {} : { hoursSinceLast: Number(hours) }),
  };
}

async function featureFlags(db: Client, workspaceId: string): Promise<Record<string, boolean>> {
  const rows = await queryAll<{ key: string; enabled: number }>(
    db,
    'SELECT key, enabled FROM feature_flags WHERE workspace_id = ?',
    [workspaceId],
  );

  return Object.fromEntries(rows.map((row) => [row.key, row.enabled === 1]));
}

async function hasConnectedAccount(
  db: Client,
  workspaceId: string,
  network: Network,
): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM integration_accounts
      WHERE workspace_id = ? AND network = ? AND status = 'active'`,
    [workspaceId, network],
  );

  return Number(row?.n ?? 0) > 0;
}

async function conversationOpen(
  db: Client,
  workspaceId: string,
  personId: string,
): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM interactions
      WHERE workspace_id = ? AND person_id = ? AND direction = 'inbound' AND state = 'replied'`,
    [workspaceId, personId],
  );

  return Number(row?.n ?? 0) > 0;
}

/**
 * Whether this person is suppressed, by the same keys the API matches on.
 *
 * The key shapes (`person:…`, `platform:network:id`) are the schema's contract,
 * not this module's choice — a suppression written by the deletion path has to
 * be found by every reader or the tombstone stops meaning anything. A global
 * entry suppresses in every workspace, which is what makes an opt-out survive
 * the person being re-ingested by a later provider lookup.
 */
async function isSuppressed(db: Client, workspaceId: string, personId: string): Promise<boolean> {
  const identities = await queryAll<{ network: string; platform_user_id: string | null }>(
    db,
    'SELECT network, platform_user_id FROM social_identities WHERE person_id = ?',
    [personId],
  );

  const keys = [`person:${personId}`];
  for (const identity of identities) {
    if (identity.platform_user_id) {
      keys.push(`platform:${identity.network}:${identity.platform_user_id}`);
    }
  }

  const placeholders = keys.map(() => '?').join(', ');
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM suppression_keys
      WHERE match_key IN (${placeholders})
        AND (scope = 'global' OR workspace_id = ?)`,
    [...keys, workspaceId],
  );

  return Number(row?.n ?? 0) > 0;
}

function parseJson(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
