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

/**
 * How long a person is left alone after their research has been run.
 *
 * This exists because automating the approval turned a visible backlog into
 * an invisible loop. A `refresh_research` card is proposed *because* we have
 * nothing to say about someone; approving it re-reads their company's site;
 * if that still yields nothing, the next pass proposes the same card again.
 * While a human had to click, the cards simply piled up — production held 179
 * — and the waste was at least in plain sight. Approving them automatically
 * closed the loop and turned it into crawl traffic nobody was watching:
 * within minutes of shipping, one person had three cards and 195 crawls were
 * queued.
 *
 * A day is chosen because that is the shortest interval over which a company
 * website plausibly changes. Shorter re-reads the same bytes; much longer
 * would delay picking up a genuine change.
 */
const RESEARCH_COOLDOWN_HOURS = 24;

export interface AutoApproveResult {
  readonly considered: number;
  readonly approved: number;
  readonly refused: number;
  readonly queuedCrawls: number;
  /** Closed without re-crawling, because the answer would not have changed. */
  readonly cooledDown: number;
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
    return { considered: 0, approved: 0, refused: 0, queuedCrawls: 0, cooledDown: 0 };
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
  let cooledDown = 0;

  for (const row of rows) {
    // Research we have already done for this person, recently enough that
    // doing it again would read the same page. Closed rather than approved:
    // approving it would enqueue the crawl that creates the next card.
    if (row.action === 'refresh_research' && (await researchedRecently(db, row.person_id))) {
      await closeWithoutCrawling(db, input.workspaceId, row.id, row.action);
      cooledDown += 1;
      continue;
    }

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
        const url = normaliseDomain(site.domain);

        const queued = await enqueue(db, {
          workspaceId: input.workspaceId,
          kind: 'crawl_site',
          payload: {
            url,
            ...(row.campaign_id ? { campaignId: row.campaign_id } : {}),
          },
          // One crawl per site at a time. Without this a research card is a
          // crawl *per person*, and a page that names many people asks for the
          // same page many times: production queued accenture.com 226 times,
          // toptal.com 81, from a single pass. The site is read once and every
          // person on it is served by that read.
          //
          // The index behind this covers only pending and running jobs, so the
          // key frees itself the moment the crawl finishes — this suppresses
          // duplicates, never future work.
          dedupeKey: crawlDedupeKey(url),
        });

        if (queued.queued) queuedCrawls += 1;
      }
    }
  }

  return { considered: rows.length, approved, refused, queuedCrawls, cooledDown };
}

/**
 * Whether this person's research has already run inside the cooldown.
 *
 * Counted from `actions`, which is written on every approval — automatic or
 * clicked — so a human who approved the card an hour ago also suppresses the
 * automatic re-run. The alternative, looking at crawl jobs, would miss a
 * person whose company has no domain and whose card therefore never produced
 * one.
 */
async function researchedRecently(db: Client, personId: string): Promise<boolean> {
  const since = new Date(Date.now() - RESEARCH_COOLDOWN_HOURS * 3_600_000).toISOString();

  const row = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM actions
      WHERE person_id = ? AND kind = 'refresh_research' AND created_at >= ?`,
    [personId, since],
  );

  return Number(row?.n ?? 0) > 0;
}

/**
 * Retires a card whose answer is already known, without spending a crawl.
 *
 * `skipped` rather than `approved`, because approving would claim we went and
 * looked. The status already exists for exactly this — a card that is over
 * without having been acted on — and it keeps the card out of the queue
 * without inventing a fourth outcome.
 */
async function closeWithoutCrawling(
  db: Client,
  workspaceId: string,
  recommendationId: string,
  action: string,
): Promise<void> {
  await db.batch([
    {
      sql: `UPDATE recommendations SET status = 'skipped' WHERE id = ?`,
      args: [recommendationId],
    },
    {
      sql: `INSERT INTO audit_events (id, workspace_id, actor_kind, actor_id, event_type,
            entity_kind, entity_id, detail_json, occurred_at)
            VALUES (?, ?, 'system', ?, 'recommendation.research_cooldown', 'recommendation', ?, ?, ?)`,
      args: [
        newId('auditEvent'),
        workspaceId,
        AUTO_APPROVE_ACTOR,
        recommendationId,
        JSON.stringify({ action, cooldownHours: RESEARCH_COOLDOWN_HOURS }),
        now(),
      ],
    },
  ]);
}

/** Who the audit trail credits for an unattended approval. */
export const AUTO_APPROVE_ACTOR = 'usr_auto_approve';

/** Bare domains arrive without a scheme; the crawler needs one. */
function normaliseDomain(domain: string): string {
  const trimmed = domain.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * The key that collapses many requests for one site into a single crawl.
 *
 * Deliberately the same string `POST /prospects/by-url` has always used —
 * `crawl:<host>`, without `www.` — because two paths deduping under different
 * keys do not deduplicate against each other, which is the entire point. That
 * route had this from the start; the approval paths never passed a key at all,
 * which is why one of them could queue accenture.com 226 times while the other
 * could not queue it twice.
 *
 * Keyed on the host rather than the full URL so that `example.com` and
 * `https://www.example.com/` are one crawl, which is what they fetch.
 */
export function crawlDedupeKey(url: string): string {
  try {
    return `crawl:${new URL(url).hostname.replace(/^www\./, '')}`;
  } catch {
    // Unparseable is still deduplicable against itself, and the crawl job will
    // fail on its own terms rather than here.
    return `crawl:${url.toLowerCase()}`;
  }
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
