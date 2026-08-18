/**
 * Putting an approved Bluesky reply on the wire.
 *
 * The counterpart to `outreach-email.ts`, and the first non-email channel the
 * product can actually execute rather than hand to a human. The bookkeeping is
 * deliberately identical — the action, the interaction, the recommendation, the
 * funnel row and the audit entry — because a campaign whose email half advances
 * and whose social half vanishes is a campaign whose numbers are wrong.
 *
 * What is different is the target. Email has an address; a public reply has a
 * *post*, and the right one is not a detail. Replying to whatever the person
 * most recently wrote would be a stranger appearing under an unrelated
 * conversation, so the parent is always the post carried by the signal that
 * triggered the recommendation. No signal, no reply: the card falls back to
 * being something a human decides on.
 */

import { newId, type ProspectStatus } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import { BlueskyAuthError, BlueskyWriteError, postUriFromUrl } from '@outreachgraph/providers';
import type { BlueskyAgent } from '@outreachgraph/providers';
import { recordStatus } from './stages';
import { auditAction, type AuditActor } from './outreach-email';

export interface DeliverBlueskyDeps {
  readonly db: Client;
  readonly agent: BlueskyAgent;
}

export interface DeliverBlueskyInput {
  readonly workspaceId: string;
  readonly actionId: string;
  readonly actor: AuditActor;
  readonly policyVersion?: string;
}

export type DeliverBlueskyResult =
  | { readonly sent: true; readonly url: string; readonly uri: string }
  | { readonly sent: false; readonly reason: string };

interface ActionRow {
  readonly action_id: string;
  readonly action_status: string;
  readonly action_body: string | null;
  readonly network: string;
  readonly person_id: string;
  readonly recommendation_id: string;
  readonly campaign_id: string;
  readonly display_name: string;
  readonly draft_body: string | null;
  readonly signal_url: string | null;
  readonly handle: string | null;
  readonly platform_user_id: string | null;
}

/**
 * Sends the reply an approved action carries.
 *
 * Returns rather than throws for the cases that are answers rather than
 * faults, exactly as the email path does: no post to reply to, nothing
 * drafted, already sent. Each is something a reviewer needs to read, and a 500
 * tells them none of it.
 */
export async function deliverBlueskyAction(
  deps: DeliverBlueskyDeps,
  input: DeliverBlueskyInput,
): Promise<DeliverBlueskyResult> {
  const { db } = deps;

  const row = await queryOne<ActionRow>(
    db,
    `SELECT a.id AS action_id, a.status AS action_status, a.body AS action_body,
            a.network, a.person_id, a.recommendation_id,
            r.campaign_id,
            p.display_name,
            d.body AS draft_body,
            s.source_url AS signal_url,
            (SELECT si.handle FROM social_identities si
              WHERE si.person_id = p.id AND si.network = 'bluesky'
              ORDER BY si.confidence DESC LIMIT 1) AS handle,
            (SELECT si.platform_user_id FROM social_identities si
              WHERE si.person_id = p.id AND si.network = 'bluesky'
              ORDER BY si.confidence DESC LIMIT 1) AS platform_user_id
       FROM actions a
       JOIN recommendations r ON r.id = a.recommendation_id
       JOIN people p ON p.id = a.person_id
       LEFT JOIN drafts d ON d.recommendation_id = a.recommendation_id
       LEFT JOIN signals s ON s.id = r.trigger_signal_id
      WHERE a.id = ? AND a.workspace_id = ?`,
    [input.actionId, input.workspaceId],
  );

  if (!row) return { sent: false, reason: 'action not found' };
  if (row.network !== 'bluesky')
    return { sent: false, reason: 'this action is not a Bluesky post' };
  if (row.action_status === 'completed') return { sent: false, reason: 'already sent' };

  const body = (row.action_body ?? row.draft_body ?? '').trim();
  if (!body) return { sent: false, reason: 'there is no message to send' };

  // The post being answered. Derived from the triggering signal, because that
  // is the conversation the draft was written about — a reply attached to
  // anything else is a non-sequitur in public, under someone else's name.
  const target = await resolveTarget(deps, row);
  if (!target.ok) return { sent: false, reason: target.reason };

  try {
    const posted = await deps.agent.reply({ text: body, parent: target.parent });
    const url = permalinkFor(posted.uri, row.handle ?? undefined);

    await recordBlueskySent(db, {
      workspaceId: input.workspaceId,
      campaignId: row.campaign_id,
      personId: row.person_id,
      actionId: row.action_id,
      recommendationId: row.recommendation_id,
      body,
      uri: posted.uri,
      url,
      actor: input.actor,
      ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
    });

    return { sent: true, url, uri: posted.uri };
  } catch (error) {
    const message =
      error instanceof BlueskyAuthError
        ? 'the connected Bluesky account is no longer authorised'
        : error instanceof BlueskyWriteError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);

    await db.execute({
      sql: `UPDATE actions SET status = 'failed', error = ? WHERE id = ?`,
      args: [message.slice(0, 500), row.action_id],
    });

    await auditAction(db, input.workspaceId, row.action_id, input.actor, {
      eventType: 'action.send_failed',
      detail: { network: 'bluesky', error: message.slice(0, 500) },
    });

    return { sent: false, reason: message.slice(0, 500) };
  }
}

type TargetResult =
  | { readonly ok: true; readonly parent: { uri: string; cid: string } }
  | { readonly ok: false; readonly reason: string };

async function resolveTarget(deps: DeliverBlueskyDeps, row: ActionRow): Promise<TargetResult> {
  if (!row.signal_url) {
    return { ok: false, reason: 'no post to reply to — this card has no triggering signal' };
  }

  const did = row.platform_user_id ?? (await deps.agent.resolveHandle(row.handle ?? ''));
  if (!did) return { ok: false, reason: 'their Bluesky identity could not be resolved' };

  const uri = postUriFromUrl(row.signal_url, did);
  if (!uri) return { ok: false, reason: 'the signal does not point at a Bluesky post' };

  // The cid pins the exact version of the record. Fetching it also confirms
  // the post still exists, so a deleted post is refused here rather than
  // producing an orphaned reply.
  const parent = await deps.agent.getPost(uri);
  if (!parent) return { ok: false, reason: 'that post is no longer available' };

  return { ok: true, parent };
}

/** A human-openable link for the record we just wrote. */
function permalinkFor(uri: string, handle: string | undefined): string {
  const rkey = uri.split('/').pop() ?? '';
  return `https://bsky.app/profile/${handle ?? uri.split('/')[2] ?? ''}/post/${rkey}`;
}

export interface SentPostRecord {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly personId: string;
  readonly actionId: string;
  readonly recommendationId: string;
  readonly body: string;
  readonly uri: string;
  readonly url: string;
  readonly actor: AuditActor;
  readonly policyVersion?: string;
  readonly at?: string;
}

/**
 * Everything a completed public reply implies.
 *
 * The same five writes the email path makes, for the same reason: doing some of
 * them is worse than doing none, because a reply that went out but left the
 * recommendation pending gets posted again on the next tick — in public, under
 * the customer's own account.
 */
export async function recordBlueskySent(db: Client, record: SentPostRecord): Promise<void> {
  const at = record.at ?? now();

  await db.execute({
    sql: `UPDATE actions SET status = 'completed', external_id = ?, external_url = ?,
           executed_at = ? WHERE id = ?`,
    args: [record.uri, record.url, at, record.actionId],
  });

  await db.execute({
    sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, action_id,
          network, direction, state, body, occurred_at, recorded_at)
          VALUES (?, ?, ?, ?, ?, 'bluesky', 'outbound', 'contacted', ?, ?, ?)`,
    args: [
      newId('interaction'),
      record.workspaceId,
      record.personId,
      record.campaignId,
      record.actionId,
      record.body,
      at,
      at,
    ],
  });

  await db.execute({
    sql: `UPDATE recommendations SET status = 'executed' WHERE id = ?`,
    args: [record.recommendationId],
  });

  await db.execute({
    sql: `UPDATE campaign_people SET interaction_state = 'contacted', last_actioned_at = ?
           WHERE campaign_id = ? AND person_id = ?`,
    args: [at, record.campaignId, record.personId],
  });

  await recordStatus(db, {
    workspaceId: record.workspaceId,
    campaignId: record.campaignId,
    personId: record.personId,
    status: 'executed' satisfies ProspectStatus,
    reason: `${record.actor.actorId} replied on Bluesky`,
    at,
  });

  await auditAction(db, record.workspaceId, record.actionId, record.actor, {
    eventType: 'action.executed',
    detail: {
      mode: 'bluesky',
      url: record.url,
      ...(record.policyVersion ? { policyVersion: record.policyVersion } : {}),
    },
  });
}
