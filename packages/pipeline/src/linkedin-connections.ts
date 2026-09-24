/**
 * Who the workspace's LinkedIn member has invited, and who accepted.
 *
 * LinkedIn tells the *invitee* about an invitation and tells the sender
 * nothing a third party can receive when it is accepted: there is no webhook,
 * and the notification lives in the member's own feed. So acceptance is
 * something we have to go and look for, one profile at a time, and this module
 * is the bookkeeping that makes that cheap and bounded:
 *
 *   - sending an invitation writes a `pending` row due for a check tomorrow;
 *   - any profile lookup that happens anyway (before a message, say) records
 *     what it saw, for free;
 *   - the daily check reads each pending invitation at most once a day, one
 *     profile per few minutes per workspace, and turns an acceptance into an
 *     interaction, a workflow event and a `connection_accepted` rule trigger.
 *
 * Cadence conditions (`if_connected`) read the row this module keeps. They
 * never call LinkedIn themselves: a plan with five hundred people on it
 * evaluating a condition must not be five hundred profile views.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  LinkedInSessionError,
  memberIdentityFrom,
  type LinkedInConnectionStatus,
  type LinkedInSession,
} from '@outreachgraph/providers';
import { emitEvent } from './events';
import { markLinkedInSessionRevoked } from './linkedin-account';
import { runRules } from './rules';

const DAY_MS = 86_400_000;

/**
 * How long an unanswered invitation is worth checking.
 *
 * LinkedIn keeps an invitation open for months, but a sender is never told
 * about a decline — a declined invitation simply stays pending on their side.
 * Past a month the odds of a late acceptance no longer pay for a daily
 * profile view, so the check stops and the row says so.
 */
export const MAX_PENDING_CHECK_DAYS = 30;

/** Minimum time between two acceptance checks in one workspace. */
export const ACCEPTANCE_CHECK_GAP_MS = 3 * 60_000;

/**
 * The best LinkedIn reference we hold for a person: a profile URL first (it
 * carries the vanity name exactly as LinkedIn spells it), then a handle, then
 * a provider's platform id. Highest confidence wins among several.
 */
export async function linkedInProfileRef(
  db: Client,
  personId: string,
): Promise<string | undefined> {
  const rows = await queryAll<{
    handle: string | null;
    platform_user_id: string | null;
    profile_url: string | null;
  }>(
    db,
    `SELECT handle, platform_user_id, profile_url FROM social_identities
      WHERE person_id = ? AND network = 'linkedin'
      ORDER BY confidence DESC, first_seen_at`,
    [personId],
  );

  for (const row of rows) {
    for (const candidate of [row.profile_url, row.handle, row.platform_user_id]) {
      if (candidate && memberIdentityFrom(candidate)) return candidate;
    }
  }
  return undefined;
}

interface ConnectionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly person_id: string;
  readonly campaign_id: string | null;
  readonly action_id: string | null;
  readonly profile_ref: string;
  readonly status: string;
  readonly invited_at: string | null;
}

/** Records a sent invitation: pending, first checked about a day from now. */
export async function recordInvitationSent(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly personId: string;
    readonly campaignId?: string;
    readonly actionId?: string;
    readonly profileRef: string;
    readonly profileUrn?: string;
    readonly at?: string;
  },
): Promise<void> {
  const at = input.at ?? now();
  const nextCheck = new Date(Date.parse(at) + DAY_MS).toISOString();

  await db.execute({
    sql: `INSERT INTO linkedin_connections (id, workspace_id, person_id, campaign_id, action_id,
          profile_ref, profile_urn, status, invited_at, next_check_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
          ON CONFLICT (workspace_id, person_id) DO UPDATE SET
            campaign_id = excluded.campaign_id, action_id = excluded.action_id,
            profile_ref = excluded.profile_ref,
            profile_urn = coalesce(excluded.profile_urn, linkedin_connections.profile_urn),
            status = 'pending', invited_at = excluded.invited_at, accepted_at = NULL,
            next_check_at = excluded.next_check_at, updated_at = excluded.updated_at`,
    args: [
      newId('linkedinConnection'),
      input.workspaceId,
      input.personId,
      input.campaignId ?? null,
      input.actionId ?? null,
      input.profileRef,
      input.profileUrn ?? null,
      at,
      nextCheck,
      at,
      at,
    ],
  });
}

/**
 * Records what a profile lookup saw, and reports whether it was an acceptance.
 *
 * Only a pending invitation turning into a connection is an acceptance. A
 * person who was already a connection before we ever invited them is recorded
 * as connected — cadence conditions need that — but fires nothing, because
 * nothing happened.
 *
 * A pending invitation that now reads as "no invitation" is *not* taken as a
 * decline: LinkedIn never tells a sender about one, and the pending branch of
 * the relationship response is the least verified part of the parse. It stays
 * pending, and is simply checked again tomorrow until the window closes.
 */
export async function recordObservedStatus(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly personId: string;
    readonly profileRef: string;
    readonly profileUrn?: string;
    readonly status: LinkedInConnectionStatus;
    readonly at?: string;
  },
): Promise<{ readonly accepted: boolean }> {
  const at = input.at ?? now();
  const existing = await queryOne<ConnectionRow>(
    db,
    `SELECT id, workspace_id, person_id, campaign_id, action_id, profile_ref, status, invited_at
       FROM linkedin_connections WHERE workspace_id = ? AND person_id = ?`,
    [input.workspaceId, input.personId],
  );

  if (!existing) {
    await db.execute({
      sql: `INSERT INTO linkedin_connections (id, workspace_id, person_id, profile_ref,
            profile_urn, status, last_checked_at, next_check_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('linkedinConnection'),
        input.workspaceId,
        input.personId,
        input.profileRef,
        input.profileUrn ?? null,
        input.status,
        at,
        // Somebody else's invitation to us, or one sent by hand: worth
        // watching the same way.
        input.status === 'pending' ? new Date(Date.parse(at) + DAY_MS).toISOString() : null,
        at,
        at,
      ],
    });
    return { accepted: false };
  }

  if (input.status === 'connected') {
    const accepted = existing.status === 'pending';
    await db.execute({
      sql: `UPDATE linkedin_connections
               SET status = 'connected', accepted_at = CASE WHEN ? THEN ? ELSE accepted_at END,
                   profile_urn = coalesce(?, profile_urn), last_checked_at = ?,
                   next_check_at = NULL, updated_at = ?
             WHERE id = ?`,
      args: [accepted ? 1 : 0, at, input.profileUrn ?? null, at, at, existing.id],
    });
    if (accepted) await announceAcceptance(db, existing, at);
    return { accepted };
  }

  if (existing.status === 'pending') {
    const invited = existing.invited_at ? Date.parse(existing.invited_at) : Date.parse(at);
    const giveUp = Date.parse(at) - invited > MAX_PENDING_CHECK_DAYS * DAY_MS;
    await db.execute({
      sql: `UPDATE linkedin_connections
               SET status = ?, last_checked_at = ?, next_check_at = ?,
                   profile_urn = coalesce(?, profile_urn), updated_at = ?
             WHERE id = ?`,
      args: [
        giveUp ? 'none' : 'pending',
        at,
        giveUp ? null : new Date(Date.parse(at) + DAY_MS).toISOString(),
        input.profileUrn ?? null,
        at,
        existing.id,
      ],
    });
    return { accepted: false };
  }

  await db.execute({
    sql: `UPDATE linkedin_connections
             SET status = ?, last_checked_at = ?, profile_urn = coalesce(?, profile_urn),
                 next_check_at = CASE WHEN ? = 'pending' THEN ? ELSE NULL END, updated_at = ?
           WHERE id = ?`,
    args: [
      input.status,
      at,
      input.profileUrn ?? null,
      input.status,
      new Date(Date.parse(at) + DAY_MS).toISOString(),
      at,
      existing.id,
    ],
  });
  return { accepted: false };
}

/**
 * The three things an acceptance is: an inbound interaction on the person's
 * timeline, a workflow event somebody can see, and a rule trigger.
 */
async function announceAcceptance(db: Client, row: ConnectionRow, at: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, action_id,
          network, direction, state, occurred_at, recorded_at)
          VALUES (?, ?, ?, ?, ?, 'linkedin', 'inbound', 'connection_accepted', ?, ?)`,
    args: [
      newId('interaction'),
      row.workspace_id,
      row.person_id,
      row.campaign_id,
      row.action_id,
      at,
      at,
    ],
  });

  await emitEvent(db, {
    workspaceId: row.workspace_id,
    ...(row.campaign_id ? { campaignId: row.campaign_id } : {}),
    personId: row.person_id,
    phase: 'social',
    level: 'success',
    message: 'They accepted your LinkedIn invitation.',
    detail: { network: 'linkedin', event: 'connection_accepted' },
  });

  await runRules(db, row.workspace_id, {
    trigger: 'connection_accepted',
    personId: row.person_id,
    ...(row.campaign_id ? { campaignId: row.campaign_id } : {}),
  });
}

export interface AcceptanceCheckResult {
  readonly checked: number;
  readonly accepted: number;
  /** Set when nothing was checked because the last check was too recent. */
  readonly paced?: boolean;
  readonly error?: string;
}

/**
 * The daily acceptance check, one small slice at a time.
 *
 * Called every worker tick for each workspace with a LinkedIn session. It
 * reads at most `limit` pending invitations whose check is due, and none at
 * all if this workspace was checked less than `minGapMs` ago — so a hundred
 * pending invitations drain over a few hours of spaced profile views, once a
 * day each, rather than as a burst LinkedIn would notice.
 *
 * A signed-out session revokes itself and stops; any other failure is counted
 * as a check and pushed to tomorrow, so one broken profile cannot pin the
 * queue.
 */
export async function checkLinkedInAcceptances(
  deps: {
    readonly db: Client;
    readonly session: LinkedInSession;
    readonly now?: Date;
    readonly limit?: number;
    readonly minGapMs?: number;
  },
  workspaceId: string,
): Promise<AcceptanceCheckResult> {
  const { db, session } = deps;
  const at = (deps.now ?? new Date()).toISOString();
  const gap = deps.minGapMs ?? ACCEPTANCE_CHECK_GAP_MS;

  const last = await queryOne<{ last: string | null }>(
    db,
    `SELECT max(last_checked_at) AS last FROM linkedin_connections WHERE workspace_id = ?`,
    [workspaceId],
  );
  if (last?.last && Date.parse(at) - Date.parse(last.last) < gap) {
    return { checked: 0, accepted: 0, paced: true };
  }

  const due = await queryAll<{ person_id: string; profile_ref: string }>(
    db,
    `SELECT person_id, profile_ref FROM linkedin_connections
      WHERE workspace_id = ? AND status = 'pending'
        AND next_check_at IS NOT NULL AND next_check_at <= ?
      ORDER BY next_check_at LIMIT ?`,
    [workspaceId, at, deps.limit ?? 1],
  );

  let checked = 0;
  let accepted = 0;

  for (const row of due) {
    checked += 1;
    try {
      const seen = await session.lookupProfile(row.profile_ref);
      const outcome = await recordObservedStatus(db, {
        workspaceId,
        personId: row.person_id,
        profileRef: row.profile_ref,
        profileUrn: seen.profileUrn,
        status: seen.status,
        at,
      });
      if (outcome.accepted) accepted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof LinkedInSessionError) {
        await markLinkedInSessionRevoked(db, workspaceId);
        return { checked, accepted, error: message };
      }
      await db.execute({
        sql: `UPDATE linkedin_connections SET last_checked_at = ?, next_check_at = ?, updated_at = ?
               WHERE workspace_id = ? AND person_id = ?`,
        args: [at, new Date(Date.parse(at) + DAY_MS).toISOString(), at, workspaceId, row.person_id],
      });
    }
  }

  return { checked, accepted };
}

/** Workspaces whose LinkedIn session is live, for the worker's tick. */
export async function workspacesWithLinkedInSession(db: Client): Promise<readonly string[]> {
  const rows = await queryAll<{ workspace_id: string }>(
    db,
    `SELECT DISTINCT workspace_id FROM integration_accounts
      WHERE network = 'linkedin' AND status = 'active'`,
    [],
  );
  return rows.map((row) => row.workspace_id);
}
