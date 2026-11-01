/**
 * Who gets a `find_email` job, and when.
 *
 * Separate from `find-email.ts` because the pipeline enqueues from inside
 * `createRecommendation`, and the job itself calls back into the pipeline to
 * re-decide the person. Keeping the enqueue side here keeps that a line rather
 * than a cycle.
 *
 * Two ways in, both idempotent:
 *
 *   - **At decision time.** A card that came out `manual_only` for a person
 *     with no way to be emailed queues a search for them there and then, so a
 *     fresh import converges on email without anyone asking.
 *   - **By sweep.** People who were carded before this existed — the ninety
 *     LinkedIn-only people in production — are found from a derived set and
 *     queued a bounded handful per tick.
 *
 * Jobs key on the person, so multiple campaigns still produce one search.
 * `email_searched_at` leaves a month between misses rather than retrying every
 * minute.
 */

import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  CONTACT_EMAIL_SQL,
  isNonBuyerDesk,
  isWellFormed,
  nonBuyerDeskSql,
} from './recipient-guard';
import { enqueue } from './queue';

/**
 * How long a finished search stands before it may run again.
 *
 * Long, because a miss is usually a fact about the domain (no MX, catch-all,
 * port 25 blocked) and those change slowly. Not forever, because the strongest
 * input — a colleague's confirmed address teaching the domain's pattern —
 * accumulates as the workspace grows.
 */
export const FIND_EMAIL_RETRY_MS = 30 * 86_400_000;

/** People queued per workspace per tick by the sweep. */
const SWEEP_SIZE = 20;

export function findEmailDedupeKey(personId: string): string {
  return `find_email:${personId}`;
}

function retryCutoff(at: Date = new Date()): string {
  return new Date(at.getTime() - FIND_EMAIL_RETRY_MS).toISOString();
}

/**
 * Queues a search for one person, unless one ran recently.
 *
 * The recency check lives here rather than in the job so that a job, once
 * queued, always does its work — a retry after a DNS timeout must not find its
 * own stamp and quietly skip.
 */
export async function enqueueFindEmail(
  db: Client,
  input: { readonly workspaceId: string; readonly personId: string; readonly now?: Date },
): Promise<boolean> {
  const due = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM people
      WHERE id = ? AND status = 'active' AND kind = 'person'
        AND (email_searched_at IS NULL OR email_searched_at < ?)`,
    [input.personId, retryCutoff(input.now)],
  );
  if (!due) return false;

  const result = await enqueue(db, {
    workspaceId: input.workspaceId,
    kind: 'find_email',
    payload: { personId: input.personId },
    dedupeKey: findEmailDedupeKey(input.personId),
    // A DNS timeout deserves a second go; a third failure is the domain.
    maxAttempts: 3,
  });

  return result.queued;
}

/**
 * Active campaign members without a contactable personal address, not
 * searched recently, and not already queued. Company inboxes do not count as a
 * personal address, so a support@ desk does not prevent a search for the person.
 */
const AWAITING = `
  FROM campaign_people cp
  JOIN people p ON p.id = cp.person_id
  JOIN campaigns c ON c.id = cp.campaign_id
 WHERE cp.status NOT IN ('unqualified', 'suppressed', 'not_interested')
   AND c.status != 'archived'
   AND p.status = 'active' AND p.kind = 'person' AND p.outreach_eligible = 1
   AND (p.email_searched_at IS NULL OR p.email_searched_at < ?)
   AND NOT EXISTS (SELECT 1 FROM person_emails pe WHERE pe.person_id = p.id
                    AND NOT ${nonBuyerDeskSql('pe.address')}
                    AND NOT EXISTS (SELECT 1 FROM email_verifications ev
                      WHERE lower(trim(ev.address)) = lower(trim(pe.address))
                        AND ev.status = 'invalid'))
   AND NOT EXISTS (
         SELECT 1 FROM social_identities si
          WHERE si.person_id = p.id AND si.network = 'email'
            AND si.handle IS NOT NULL AND trim(si.handle) <> ''
            AND NOT ${nonBuyerDeskSql('si.handle')}
            AND NOT EXISTS (SELECT 1 FROM email_verifications ev
              WHERE lower(trim(ev.address)) = lower(trim(si.handle))
                AND ev.status = 'invalid'))
   AND NOT EXISTS (
         SELECT 1 FROM jobs j
          WHERE j.workspace_id = cp.workspace_id
            AND j.dedupe_key = 'find_email:' || p.id
            AND j.status IN ('pending', 'running'))`;

export interface FindEmailSweepResult {
  readonly queued: number;
}

/**
 * Queues the next few searches for one workspace.
 *
 * Bounded, because each job may hold an SMTP conversation open for seconds and
 * the drain is shared with crawls. A queue row per person is fine at this
 * scale — it is dozens, not the seventeen thousand that taught the contact
 * enrichment sweep to avoid them.
 */
export async function sweepFindEmail(
  db: Client,
  input: { readonly workspaceId: string; readonly limit?: number; readonly now?: Date },
): Promise<FindEmailSweepResult> {
  const rows = await queryAll<{ person_id: string }>(
    db,
    `SELECT DISTINCT p.id AS person_id ${AWAITING} AND cp.workspace_id = ? LIMIT ?`,
    [retryCutoff(input.now), input.workspaceId, input.limit ?? SWEEP_SIZE],
  );

  let queued = 0;
  for (const row of rows) {
    const result = await enqueue(db, {
      workspaceId: input.workspaceId,
      kind: 'find_email',
      payload: { personId: row.person_id },
      dedupeKey: findEmailDedupeKey(row.person_id),
      maxAttempts: 3,
    });
    if (result.queued) queued += 1;
  }

  return { queued };
}

/** Workspaces holding anyone the sweep would queue. */
export async function workspacesAwaitingEmailSearch(db: Client, at?: Date): Promise<string[]> {
  const rows = await queryAll<{ workspace_id: string }>(
    db,
    `SELECT DISTINCT cp.workspace_id ${AWAITING}`,
    [retryCutoff(at)],
  );
  return rows.map((row) => row.workspace_id);
}

export interface UnsendableEmailArchiveResult {
  readonly archived: number;
  readonly searchesQueued: number;
}

/**
 * Removes cold email cards that have no deliverable recipient from approvals.
 * Their campaign membership stays active, so the monthly search sweep can
 * create a fresh card if a personal address is published later.
 */
export async function archiveUnsendableEmailRecommendations(
  db: Client,
  input: { readonly workspaceId: string; readonly limit?: number; readonly now?: Date },
): Promise<UnsendableEmailArchiveResult> {
  const rows = await queryAll<{
    id: string;
    person_id: string;
    person_status: string;
    person_kind: string;
    outreach_eligible: number;
    address: string | null;
  }>(
    db,
    `SELECT r.id, r.person_id, p.status AS person_status, p.kind AS person_kind,
            p.outreach_eligible, ${CONTACT_EMAIL_SQL} AS address
       FROM recommendations r
       JOIN people p ON p.id = r.person_id
  LEFT JOIN companies co ON co.id = p.current_company_id
      WHERE r.workspace_id = ? AND r.status = 'pending'
        AND r.action = 'send_email' AND r.network = 'email'
        AND r.expected_goal != 'continue_conversation'
        AND r.reply_to_interaction_id IS NULL
        AND (
          ${CONTACT_EMAIL_SQL} IS NULL
          OR trim(${CONTACT_EMAIL_SQL}) = ''
          OR instr(trim(${CONTACT_EMAIL_SQL}), '@') <= 1
          OR length(trim(${CONTACT_EMAIL_SQL})) -
             length(replace(trim(${CONTACT_EMAIL_SQL}), '@', '')) != 1
          OR instr(trim(${CONTACT_EMAIL_SQL}), ' ') > 0
          OR instr(
               substr(trim(${CONTACT_EMAIL_SQL}), instr(trim(${CONTACT_EMAIL_SQL}), '@') + 1),
               '.'
             ) = 0
        )
   ORDER BY r.created_at ASC, r.id ASC
      LIMIT ?`,
    [input.workspaceId, input.limit ?? 200],
  );

  let archived = 0;
  let searchesQueued = 0;

  for (const row of rows) {
    const address = row.address?.trim();
    if (address && isWellFormed(address) && !isNonBuyerDesk(address)) continue;

    if (
      row.person_status === 'active' &&
      row.person_kind === 'person' &&
      row.outreach_eligible === 1
    ) {
      if (
        await enqueueFindEmail(db, {
          workspaceId: input.workspaceId,
          personId: row.person_id,
          ...(input.now ? { now: input.now } : {}),
        })
      ) {
        searchesQueued += 1;
      }
    }

    const result = await db.execute({
      sql: `UPDATE recommendations SET status = 'skipped'
             WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
      args: [row.id, input.workspaceId],
    });
    archived += result.rowsAffected;
  }

  return { archived, searchesQueued };
}

/** Workspaces with pending first-touch email cards to clean up. */
export async function workspacesWithUnsendableEmailRecommendations(db: Client): Promise<string[]> {
  const rows = await queryAll<{ workspace_id: string }>(
    db,
    `SELECT DISTINCT workspace_id FROM recommendations
      WHERE status = 'pending' AND action = 'send_email' AND network = 'email'
        AND expected_goal != 'continue_conversation' AND reply_to_interaction_id IS NULL`,
  );
  return rows.map((row) => row.workspace_id);
}

/** Stamps a search as run, whatever it found. */
export async function markEmailSearched(db: Client, personId: string): Promise<void> {
  await db.execute({
    sql: 'UPDATE people SET email_searched_at = ? WHERE id = ?',
    args: [now(), personId],
  });
}
