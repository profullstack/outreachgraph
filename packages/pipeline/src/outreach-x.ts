/**
 * Carrying out an approved X action.
 *
 * The X counterpart to `outreach-bluesky.ts`, with the same rule about the
 * target: a reply answers the post carried by the signal that triggered the
 * card, never whatever the person wrote most recently, because a reply under
 * an unrelated post is a stranger barging into someone else's conversation.
 * No signal pointing at a post, no reply; the card stays a hand-off.
 */

import { queryOne, type Client } from '@outreachgraph/db';
import {
  tweetIdFromUrl,
  XAuthError,
  XWriteError,
  X_POST_LIMIT,
  type XClient,
} from '@outreachgraph/providers';
import { auditAction, type AuditActor } from './outreach-email';
import { recordSocialSent } from './outreach-bluesky';

export interface DeliverXInput {
  readonly workspaceId: string;
  readonly actionId: string;
  readonly actor: AuditActor;
  readonly policyVersion?: string;
}

export type DeliverXResult =
  { readonly sent: true; readonly url: string } | { readonly sent: false; readonly reason: string };

interface ActionRow {
  readonly action_id: string;
  readonly action_status: string;
  readonly action_body: string | null;
  readonly kind: string;
  readonly network: string;
  readonly person_id: string;
  readonly recommendation_id: string;
  readonly campaign_id: string;
  readonly draft_body: string | null;
  readonly signal_url: string | null;
  readonly handle: string | null;
  readonly platform_user_id: string | null;
}

export async function deliverXAction(
  deps: { readonly db: Client; readonly client: XClient },
  input: DeliverXInput,
): Promise<DeliverXResult> {
  const { db, client } = deps;

  const row = await queryOne<ActionRow>(
    db,
    `SELECT a.id AS action_id, a.status AS action_status, a.body AS action_body, a.kind,
            a.network, a.person_id, a.recommendation_id, r.campaign_id,
            d.body AS draft_body, s.source_url AS signal_url,
            (SELECT si.handle FROM social_identities si
              WHERE si.person_id = a.person_id AND si.network = 'x'
              ORDER BY si.confidence DESC LIMIT 1) AS handle,
            (SELECT si.platform_user_id FROM social_identities si
              WHERE si.person_id = a.person_id AND si.network = 'x'
              ORDER BY si.confidence DESC LIMIT 1) AS platform_user_id
       FROM actions a
       JOIN recommendations r ON r.id = a.recommendation_id
       LEFT JOIN drafts d ON d.recommendation_id = a.recommendation_id
       LEFT JOIN signals s ON s.id = r.trigger_signal_id
      WHERE a.id = ? AND a.workspace_id = ?`,
    [input.actionId, input.workspaceId],
  );

  if (!row) return { sent: false, reason: 'action not found' };
  if (row.network !== 'x') return { sent: false, reason: 'this action is not an X action' };
  if (row.action_status === 'completed') return { sent: false, reason: 'already sent' };

  const tweetId = row.signal_url ? tweetIdFromUrl(row.signal_url) : undefined;
  const body = (row.action_body ?? row.draft_body ?? '').trim();

  try {
    let url: string;
    let externalId: string;

    switch (row.kind) {
      case 'reply':
      case 'comment': {
        if (!tweetId) return { sent: false, reason: 'the signal does not point at an X post' };
        if (!body) return { sent: false, reason: 'there is no message to send' };
        if ([...body].length > X_POST_LIMIT) {
          return { sent: false, reason: `the reply is over ${X_POST_LIMIT} characters` };
        }
        const posted = await client.reply({ text: body, inReplyTo: tweetId });
        url = posted.url;
        externalId = posted.id;
        break;
      }
      case 'like': {
        if (!tweetId) return { sent: false, reason: 'the signal does not point at an X post' };
        await client.like(tweetId);
        url = row.signal_url!;
        externalId = tweetId;
        break;
      }
      case 'follow': {
        const target =
          row.platform_user_id ?? (row.handle ? await client.userIdFor(row.handle) : undefined);
        if (!target) return { sent: false, reason: 'their X account could not be resolved' };
        await client.follow(target);
        url = `https://x.com/${row.handle ?? `i/user/${target}`}`;
        externalId = target;
        break;
      }
      default:
        return { sent: false, reason: `${row.kind} is not something the product does on X` };
    }

    await recordSocialSent(db, {
      network: 'x',
      workspaceId: input.workspaceId,
      campaignId: row.campaign_id,
      personId: row.person_id,
      actionId: row.action_id,
      recommendationId: row.recommendation_id,
      body,
      uri: externalId,
      url,
      actor: input.actor,
      ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
    });

    return { sent: true, url };
  } catch (error) {
    const message =
      error instanceof XAuthError
        ? 'the connected X account is no longer authorised'
        : error instanceof XWriteError || error instanceof Error
          ? error.message
          : String(error);

    await db.execute({
      sql: `UPDATE actions SET status = 'failed', error = ? WHERE id = ?`,
      args: [message.slice(0, 500), row.action_id],
    });
    await auditAction(db, input.workspaceId, row.action_id, input.actor, {
      eventType: 'action.send_failed',
      detail: { network: 'x', error: message.slice(0, 500) },
    });

    return { sent: false, reason: message.slice(0, 500) };
  }
}
