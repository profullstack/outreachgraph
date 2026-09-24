/**
 * Carrying out an approved LinkedIn comment through the member's session.
 *
 * Same target rule as Bluesky and X: the comment goes under the post carried
 * by the triggering signal and nowhere else.
 */

import { queryOne, type Client } from '@outreachgraph/db';
import {
  LinkedInSessionError,
  threadUrnFromUrl,
  type LinkedInSession,
} from '@outreachgraph/providers';
import { auditAction, type AuditActor } from './outreach-email';
import { recordSocialSent } from './outreach-bluesky';
import { markLinkedInSessionRevoked } from './linkedin-account';

/** LinkedIn's own comment limit. */
const COMMENT_LIMIT = 1250;

export type DeliverLinkedInResult =
  { readonly sent: true; readonly url: string } | { readonly sent: false; readonly reason: string };

export async function deliverLinkedInAction(
  deps: { readonly db: Client; readonly session: LinkedInSession },
  input: {
    readonly workspaceId: string;
    readonly actionId: string;
    readonly actor: AuditActor;
    readonly policyVersion?: string;
  },
): Promise<DeliverLinkedInResult> {
  const { db, session } = deps;

  const row = await queryOne<{
    action_id: string;
    action_status: string;
    action_body: string | null;
    kind: string;
    network: string;
    person_id: string;
    recommendation_id: string;
    campaign_id: string;
    draft_body: string | null;
    signal_url: string | null;
  }>(
    db,
    `SELECT a.id AS action_id, a.status AS action_status, a.body AS action_body, a.kind,
            a.network, a.person_id, a.recommendation_id, r.campaign_id,
            d.body AS draft_body, s.source_url AS signal_url
       FROM actions a
       JOIN recommendations r ON r.id = a.recommendation_id
       LEFT JOIN drafts d ON d.recommendation_id = a.recommendation_id
       LEFT JOIN signals s ON s.id = r.trigger_signal_id
      WHERE a.id = ? AND a.workspace_id = ?`,
    [input.actionId, input.workspaceId],
  );

  if (!row) return { sent: false, reason: 'action not found' };
  if (row.network !== 'linkedin') return { sent: false, reason: 'this is not a LinkedIn action' };
  if (row.action_status === 'completed') return { sent: false, reason: 'already sent' };
  if (row.kind !== 'reply' && row.kind !== 'comment') {
    return { sent: false, reason: `${row.kind} on LinkedIn stays a hand-off` };
  }

  const thread = row.signal_url ? threadUrnFromUrl(row.signal_url) : undefined;
  if (!thread) return { sent: false, reason: 'the signal does not point at a LinkedIn post' };

  const body = (row.action_body ?? row.draft_body ?? '').trim();
  if (!body) return { sent: false, reason: 'there is no message to send' };
  if (body.length > COMMENT_LIMIT) {
    return { sent: false, reason: `the comment is over ${COMMENT_LIMIT} characters` };
  }

  try {
    const posted = await session.comment(thread, body);
    const url = row.signal_url!;

    await recordSocialSent(db, {
      network: 'linkedin',
      workspaceId: input.workspaceId,
      campaignId: row.campaign_id,
      personId: row.person_id,
      actionId: row.action_id,
      recommendationId: row.recommendation_id,
      body,
      uri: posted.urn ?? thread,
      url,
      actor: input.actor,
      ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
    });

    return { sent: true, url };
  } catch (error) {
    if (error instanceof LinkedInSessionError) {
      await markLinkedInSessionRevoked(db, input.workspaceId);
    }
    const message = error instanceof Error ? error.message : String(error);

    await db.execute({
      sql: `UPDATE actions SET status = 'failed', error = ? WHERE id = ?`,
      args: [message.slice(0, 500), row.action_id],
    });
    await auditAction(db, input.workspaceId, row.action_id, input.actor, {
      eventType: 'action.send_failed',
      detail: { network: 'linkedin', error: message.slice(0, 500) },
    });

    return { sent: false, reason: message.slice(0, 500) };
  }
}
