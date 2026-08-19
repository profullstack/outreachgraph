/**
 * Clearing the work that never needed a person.
 *
 * The approval queue exists so a human decides before a prospect is contacted.
 * Some recommendations contact nobody: `refresh_research` re-reads a company's
 * own website, `observe` records something already seen, `wait` does nothing.
 * The policy engine has always known this — `isInternalAction` exempts them
 * from the budget and every rate limit — and the queue asked for a click all
 * the same.
 *
 * Production held 179 of these against 25 cards a person could actually act
 * on. A review surface that is three-quarters filler is one that stops being
 * read, and the decisions that mattered were buried in it.
 *
 * What this deliberately does **not** touch:
 *
 *   - Anything outbound. An email or a post still waits for a human or for
 *     autopilot, which is a separate, campaign-level decision.
 *   - `manual_review`, whose entire purpose is that a person looks at it.
 *   - `create_crm_task` and `suppress`, which write somewhere else or remove a
 *     lead. Both are safe to automate and neither is urgent; leaving them
 *     manual keeps this change to the case that was demonstrably wrong.
 *
 * The policy engine still runs on every card. Internal actions skip the rate
 * limits, not the gates above them: a deleted, suppressed or believed-minor
 * person is refused here exactly as they would be on the approval path. That
 * ordering is the reason this can be automatic at all.
 */

import { evaluatePolicy, isExecutable } from '@outreachgraph/policy';
import { newId, type ActionKind, type Network } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { enqueue } from './queue';

/**
 * The actions cleared without a person.
 *
 * A deliberate subset of `isInternalAction`, not a re-use of it. That
 * predicate answers "does this cost anything or reach anyone", which is the
 * right question for rate limits and the wrong one for "may this happen with
 * nobody watching".
 */
const AUTO_APPROVED: readonly ActionKind[] = ['refresh_research', 'observe', 'wait'];

export interface AutoApproveResult {
  readonly considered: number;
  readonly approved: number;
  readonly refused: number;
  readonly queuedCrawls: number;
}

interface PendingRow {
  readonly id: string;
  readonly person_id: string;
  readonly campaign_id: string | null;
  readonly action: string;
  readonly network: string;
  readonly person_status: string;
  readonly believed_minor: number;
  readonly identity_confidence: number;
  readonly approval_mode: string;
  readonly min_outreach_confidence: number | null;
}

/**
 * Approves the internal cards in one workspace.
 *
 * Bounded per run because this is called from the worker tick: a backlog of
 * several hundred should drain over a few minutes rather than hold the loop
 * while everything else — sending, listening, cadences — waits behind it.
 */
export async function autoApproveInternal(
  db: Client,
  input: { readonly workspaceId: string; readonly limit?: number },
): Promise<AutoApproveResult> {
  const workspace = await queryOne<{ auto_approve_internal: number }>(
    db,
    'SELECT auto_approve_internal FROM workspaces WHERE id = ?',
    [input.workspaceId],
  );

  // Absent workspace or the setting turned off. Not an error: a workspace that
  // wants to watch its own research go by is entitled to.
  if (!workspace || workspace.auto_approve_internal !== 1) {
    return { considered: 0, approved: 0, refused: 0, queuedCrawls: 0 };
  }

  const placeholders = AUTO_APPROVED.map(() => '?').join(', ');

  const rows = await queryAll<PendingRow>(
    db,
    `SELECT r.id, r.person_id, r.campaign_id, r.action, r.network,
            p.status AS person_status, p.believed_minor, p.identity_confidence,
            c.approval_mode, w.min_outreach_confidence
       FROM recommendations r
       JOIN people p ON p.id = r.person_id
       LEFT JOIN campaigns c ON c.id = r.campaign_id
       JOIN workspaces w ON w.id = r.workspace_id
      WHERE r.workspace_id = ? AND r.status = 'pending' AND r.action IN (${placeholders})
      ORDER BY r.created_at
      LIMIT ?`,
    [input.workspaceId, ...AUTO_APPROVED, input.limit ?? 200],
  );

  let approved = 0;
  let refused = 0;
  let queuedCrawls = 0;

  for (const row of rows) {
    const decision = evaluatePolicy({
      network: row.network as Network,
      action: row.action as ActionKind,
      approvalMode: (row.approval_mode ?? 'draft_and_approve') as 'draft_and_approve',
      // Irrelevant for an internal action — nothing is sent — but the engine
      // takes it, and claiming a connected account we do not have would be a
      // lie that shows up somewhere else later.
      hasConnectedAccount: true,
      personSuppressed: row.person_status === 'suppressed',
      personBelievedMinor: row.believed_minor === 1,
      personDeleted: row.person_status === 'deleted',
      identityConfidence: row.identity_confidence,
      minIdentityConfidence: row.min_outreach_confidence ?? 0.85,
      // The rate limits are skipped for internal actions inside the engine, so
      // these are passed as satisfied rather than queried. Reading the real
      // counts would be work whose answer cannot change the outcome.
      actionsToday: 0,
      maxActionsPerDay: Number.MAX_SAFE_INTEGER,
      actionsToThisProspectThisWeek: 0,
      maxActionsPerProspectPerWeek: Number.MAX_SAFE_INTEGER,
    });

    if (!isExecutable(decision.decision, true)) {
      refused += 1;
      continue;
    }

    const stamp = now();
    const approvalId = newId('approval');
    const actionId = newId('action');

    await db.batch([
      {
        sql: `INSERT INTO approvals (id, workspace_id, recommendation_id, decision, decided_by,
              decided_at, note) VALUES (?, ?, ?, 'approve', ?, ?, ?)`,
        args: [
          approvalId,
          input.workspaceId,
          row.id,
          // Attributed to the system rather than to whoever last signed in.
          // An audit trail that credits a person for a decision they never
          // made is worse than one that says nobody decided.
          AUTO_APPROVE_ACTOR,
          stamp,
          'Approved automatically: internal action, nobody is contacted',
        ],
      },
      {
        sql: `UPDATE recommendations SET status = 'approved' WHERE id = ?`,
        args: [row.id],
      },
      {
        sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
              mode, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'manual', 'queued', ?)`,
        args: [actionId, input.workspaceId, row.id, row.person_id, row.action, row.network, stamp],
      },
      {
        sql: `INSERT INTO audit_events (id, workspace_id, actor_kind, actor_id, event_type,
              entity_kind, entity_id, detail_json, occurred_at)
              VALUES (?, ?, 'system', ?, 'recommendation.auto_approved', 'recommendation', ?, ?, ?)`,
        args: [
          newId('auditEvent'),
          input.workspaceId,
          AUTO_APPROVE_ACTOR,
          row.id,
          JSON.stringify({ action: row.action, actionId }),
          stamp,
        ],
      },
    ]);

    approved += 1;

    // Approving research is the instruction to go and research. Without this
    // the card closes and nothing re-reads the site, which is the state that
    // produced the same card again on the next tick.
    if (row.action === 'refresh_research') {
      const site = await queryOne<{ domain: string }>(
        db,
        `SELECT co.domain
           FROM people p
           JOIN companies co ON co.id = p.current_company_id
          WHERE p.id = ? AND co.domain IS NOT NULL AND trim(co.domain) <> ''`,
        [row.person_id],
      );

      if (site?.domain) {
        const queued = await enqueue(db, {
          workspaceId: input.workspaceId,
          kind: 'crawl_site',
          payload: {
            url: normaliseDomain(site.domain),
            ...(row.campaign_id ? { campaignId: row.campaign_id } : {}),
          },
        });

        if (queued.queued) queuedCrawls += 1;
      }
    }
  }

  return { considered: rows.length, approved, refused, queuedCrawls };
}

/** Who the audit trail credits for an unattended approval. */
export const AUTO_APPROVE_ACTOR = 'usr_auto_approve';

/** Bare domains arrive without a scheme; the crawler needs one. */
function normaliseDomain(domain: string): string {
  const trimmed = domain.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Every workspace with internal cards waiting, for the worker to sweep. */
export async function workspacesWithInternalBacklog(db: Client): Promise<string[]> {
  const placeholders = AUTO_APPROVED.map(() => '?').join(', ');

  const rows = await queryAll<{ workspace_id: string }>(
    db,
    `SELECT DISTINCT r.workspace_id
       FROM recommendations r
       JOIN workspaces w ON w.id = r.workspace_id
      WHERE r.status = 'pending' AND r.action IN (${placeholders})
        AND w.auto_approve_internal = 1`,
    AUTO_APPROVED as unknown as string[],
  );

  return rows.map((row) => row.workspace_id);
}
