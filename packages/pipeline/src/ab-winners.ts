/**
 * A/B tests that decide themselves. The rule is `decideAbTest` in
 * `@outreachgraph/domain`; this reads each tested step's results and, once a
 * test is decided, makes the winning angle the step's intent and records why.
 */

import { decideAbTest, newId, variantLabel, type ArmResult } from '@outreachgraph/domain';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import { emitEvent } from './events';

export interface VariantRow {
  readonly step: number;
  readonly variant: string;
  readonly assigned: number;
  readonly sent: number;
  readonly opened: number;
  readonly clicked: number;
  readonly replied: number;
}

/**
 * How each arm of each tested step is doing, counting people rather than
 * messages. `replied` is a reply recorded after that step's action went out,
 * in either spelling — the mailbox poll writes `responded`, the manual route
 * `replied`, and reading only the second missed every reply the poll saw.
 *
 * `since` restricts a step to runs after its last decided test, so a fresh
 * test on the same step starts from zero.
 */
export async function variantStats(
  db: Client,
  workspaceId: string,
  cadenceId: string,
): Promise<VariantRow[]> {
  const rows = await queryAll<{
    step_position: number;
    variant: string;
    assigned: number;
    sent: number;
    opened: number;
    clicked: number;
    replied: number;
  }>(
    db,
    `WITH runs AS (
       SELECT r.step_position, r.variant, e.person_id, r.recommendation_id
         FROM cadence_step_runs r
         JOIN cadence_enrollments e ON e.id = r.enrollment_id
        WHERE e.cadence_id = ? AND r.workspace_id = ? AND r.variant IS NOT NULL
          AND r.occurred_at > COALESCE(
            (SELECT MAX(ab.decided_at) FROM ab_results ab
              WHERE ab.cadence_id = e.cadence_id AND ab.step_position = r.step_position), '')
     ),
     sent AS (
       SELECT runs.*, a.id AS action_id, COALESCE(a.executed_at, a.created_at) AS executed_at
         FROM runs
         JOIN actions a ON a.recommendation_id = runs.recommendation_id
                       AND a.status = 'completed'
     )
     SELECT runs.step_position, runs.variant,
            count(DISTINCT runs.person_id) AS assigned,
            (SELECT count(DISTINCT s.person_id) FROM sent s
              WHERE s.step_position = runs.step_position AND s.variant = runs.variant) AS sent,
            (SELECT count(DISTINCT s.person_id) FROM sent s
               JOIN open_pixels op ON op.action_id = s.action_id
               JOIN email_opens eo ON eo.pixel_id = op.id AND eo.automated IS NULL
              WHERE s.step_position = runs.step_position AND s.variant = runs.variant) AS opened,
            (SELECT count(DISTINCT s.person_id) FROM sent s
               JOIN tracked_links tl ON tl.action_id = s.action_id
               JOIN link_clicks lc ON lc.tracked_link_id = tl.id AND lc.automated IS NULL
              WHERE s.step_position = runs.step_position AND s.variant = runs.variant) AS clicked,
            (SELECT count(DISTINCT s.person_id) FROM sent s
               JOIN interactions i ON i.person_id = s.person_id
                                  AND i.workspace_id = ?
                                  AND i.direction = 'inbound'
                                  AND i.state IN ('replied', 'responded')
                                  AND i.occurred_at >= s.executed_at
              WHERE s.step_position = runs.step_position AND s.variant = runs.variant) AS replied
       FROM runs
   GROUP BY runs.step_position, runs.variant
   ORDER BY runs.step_position, runs.variant`,
    [cadenceId, workspaceId, workspaceId],
  );

  return rows.map((row) => ({
    step: Number(row.step_position),
    variant: row.variant,
    assigned: Number(row.assigned),
    sent: Number(row.sent),
    opened: Number(row.opened),
    clicked: Number(row.clicked),
    replied: Number(row.replied),
  }));
}

export interface PromotedWinner {
  readonly cadenceId: string;
  readonly step: number;
  readonly winner: string;
  readonly reason: string;
}

/**
 * Decides every test in the workspace that has enough data, and promotes the
 * winners. Returns what changed; a step still collecting data is untouched.
 */
export async function promoteAbWinners(
  db: Client,
  workspaceId: string,
  at: Date = new Date(),
): Promise<PromotedWinner[]> {
  const steps = await queryAll<{
    cadence_id: string;
    campaign_id: string | null;
    position: number;
    intent: string | null;
    variants_json: string | null;
  }>(
    db,
    `SELECT s.cadence_id, c.campaign_id, s.position, s.intent, s.variants_json
       FROM cadence_steps s
       JOIN cadences c ON c.id = s.cadence_id
      WHERE c.workspace_id = ? AND s.variants_json IS NOT NULL AND s.variants_json <> '[]'
        AND s.intent IS NOT NULL AND trim(s.intent) <> ''`,
    [workspaceId],
  );

  const promoted: PromotedWinner[] = [];
  const statsByCadence = new Map<string, VariantRow[]>();

  for (const step of steps) {
    const variants = parseVariants(step.variants_json);
    if (variants.length === 0) continue;
    const arms = [(step.intent as string).trim(), ...variants];

    let stats = statsByCadence.get(step.cadence_id);
    if (!stats) {
      stats = await variantStats(db, workspaceId, step.cadence_id);
      statsByCadence.set(step.cadence_id, stats);
    }

    // Every arm is reported, including one nobody has been assigned yet, so
    // a test with an empty arm is never decided by the arms that happen to
    // have data.
    const results: ArmResult[] = arms.map((_, index) => {
      const label = variantLabel(index);
      const row = stats?.find((entry) => entry.step === step.position && entry.variant === label);
      return { variant: label, sent: row?.sent ?? 0, replied: row?.replied ?? 0 };
    });

    const decision = decideAbTest(results);
    if (!decision.decided) continue;

    const winnerIndex = decision.winner.charCodeAt(0) - 65;
    const winnerIntent = arms[winnerIndex] ?? arms[0] ?? '';
    const stamp = at.toISOString();

    await db.batch([
      {
        sql: `UPDATE cadence_steps SET intent = ?, variants_json = NULL
               WHERE cadence_id = ? AND position = ?`,
        args: [winnerIntent, step.cadence_id, step.position],
      },
      {
        sql: `INSERT INTO ab_results (id, workspace_id, cadence_id, step_position, winner,
              winner_intent, basis, reason, arms_json, decided_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId('abResult'),
          workspaceId,
          step.cadence_id,
          step.position,
          decision.winner,
          winnerIntent,
          decision.basis,
          decision.reason,
          JSON.stringify(results.map((result, index) => ({ ...result, intent: arms[index] }))),
          stamp,
        ],
      },
    ]);

    await emitEvent(db, {
      workspaceId,
      ...(step.campaign_id ? { campaignId: step.campaign_id } : {}),
      phase: 'social',
      level: 'success',
      message: `A/B test on step ${step.position + 1} decided: ${decision.winner} is now the default. ${decision.reason}.`,
      detail: { cadenceId: step.cadence_id, step: step.position, winner: decision.winner },
    });

    promoted.push({
      cadenceId: step.cadence_id,
      step: step.position,
      winner: decision.winner,
      reason: decision.reason,
    });
  }

  return promoted;
}

export interface AbResultRow {
  readonly cadenceId: string;
  readonly step: number;
  readonly winner: string;
  readonly winnerIntent: string;
  readonly basis: string;
  readonly reason: string;
  readonly arms: unknown;
  readonly decidedAt: string;
}

/** Decided tests, newest first — what the planner reuses as default angles. */
export async function abResults(
  db: Client,
  workspaceId: string,
  options: { readonly cadenceId?: string; readonly limit?: number } = {},
): Promise<AbResultRow[]> {
  const rows = await queryAll<{
    cadence_id: string;
    step_position: number;
    winner: string;
    winner_intent: string;
    basis: string;
    reason: string;
    arms_json: string;
    decided_at: string;
  }>(
    db,
    `SELECT cadence_id, step_position, winner, winner_intent, basis, reason, arms_json, decided_at
       FROM ab_results
      WHERE workspace_id = ? ${options.cadenceId ? 'AND cadence_id = ?' : ''}
      ORDER BY decided_at DESC
      LIMIT ?`,
    [workspaceId, ...(options.cadenceId ? [options.cadenceId] : []), options.limit ?? 50],
  );
  return rows.map((row) => ({
    cadenceId: row.cadence_id,
    step: Number(row.step_position),
    winner: row.winner,
    winnerIntent: row.winner_intent,
    basis: row.basis,
    reason: row.reason,
    arms: safeParse(row.arms_json),
    decidedAt: row.decided_at,
  }));
}

/** The winning angle of the most recent decided test, if any. */
export async function latestWinningIntent(
  db: Client,
  workspaceId: string,
): Promise<string | undefined> {
  const row = await queryOne<{ winner_intent: string }>(
    db,
    `SELECT winner_intent FROM ab_results
      WHERE workspace_id = ? AND basis = 'significant'
      ORDER BY decided_at DESC LIMIT 1`,
    [workspaceId],
  );
  return row?.winner_intent;
}

function parseVariants(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed
          .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
          .map((v) => v.trim())
      : [];
  } catch {
    return [];
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
