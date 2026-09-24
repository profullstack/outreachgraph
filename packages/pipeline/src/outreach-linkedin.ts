/**
 * Carrying out an approved LinkedIn action through the member's session.
 *
 * Two families, with different targets:
 *
 *   - `reply` / `comment` go under the post carried by the triggering signal
 *     and nowhere else — the same target rule as Bluesky and X.
 *   - `connect`, `view_profile`, `follow` and `send_dm` act on the *person*,
 *     found through their LinkedIn identity in `social_identities`.
 *
 * Every one runs here, at execution time, after the pacing in
 * `social-delivery.ts` decided it may, and only because the capability matrix
 * allowed it for a workspace with a connected session. This function does not
 * re-decide policy; it refuses what would be pointless or harmful on
 * LinkedIn's side — inviting somebody already connected, messaging somebody
 * who is not — before spending a request on it.
 */

import { queryOne, type Client } from '@outreachgraph/db';
import {
  INVITATION_NOTE_LIMIT,
  LINKEDIN_MESSAGE_LIMIT,
  LinkedInSessionError,
  threadUrnFromUrl,
  type LinkedInSession,
} from '@outreachgraph/providers';
import { auditAction, type AuditActor } from './outreach-email';
import { recordSocialSent } from './outreach-bluesky';
import { markLinkedInSessionRevoked } from './linkedin-account';
import {
  linkedInProfileRef,
  recordInvitationSent,
  recordObservedStatus,
} from './linkedin-connections';

/** LinkedIn's own comment limit. */
const COMMENT_LIMIT = 1250;

/** The kinds a session can carry out. Anything else stays a hand-off. */
const PERSON_KINDS = new Set(['connect', 'view_profile', 'follow', 'send_dm']);

export type DeliverLinkedInResult =
  { readonly sent: true; readonly url: string } | { readonly sent: false; readonly reason: string };

interface ActionRow {
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
}

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

  const row = await queryOne<ActionRow>(
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

  try {
    if (row.kind === 'reply' || row.kind === 'comment') {
      return await deliverComment(db, session, row, input);
    }
    if (PERSON_KINDS.has(row.kind)) {
      return await deliverPersonAction(db, session, row, input);
    }
    return { sent: false, reason: `${row.kind} on LinkedIn stays a hand-off` };
  } catch (error) {
    if (error instanceof LinkedInSessionError) {
      await markLinkedInSessionRevoked(db, input.workspaceId);
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail(db, input, row.action_id, message);
  }
}

async function deliverComment(
  db: Client,
  session: LinkedInSession,
  row: ActionRow,
  input: { workspaceId: string; actor: AuditActor; policyVersion?: string },
): Promise<DeliverLinkedInResult> {
  const thread = row.signal_url ? threadUrnFromUrl(row.signal_url) : undefined;
  if (!thread) return { sent: false, reason: 'the signal does not point at a LinkedIn post' };

  const body = (row.action_body ?? row.draft_body ?? '').trim();
  if (!body) return { sent: false, reason: 'there is no message to send' };
  if (body.length > COMMENT_LIMIT) {
    return { sent: false, reason: `the comment is over ${COMMENT_LIMIT} characters` };
  }

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
}

/**
 * Invitations, visits, follows and messages: everything addressed to a person.
 *
 * Invitations and messages look the person up first (one read, which also
 * records what it saw for cadence conditions) and refuse on the answer:
 * inviting a connection or somebody already invited is refused by LinkedIn
 * and counts against the weekly allowance on the way; a message to somebody
 * who is not a connection needs InMail credits we do not spend.
 */
async function deliverPersonAction(
  db: Client,
  session: LinkedInSession,
  row: ActionRow,
  input: { workspaceId: string; actor: AuditActor; policyVersion?: string },
): Promise<DeliverLinkedInResult> {
  const profileRef = await linkedInProfileRef(db, row.person_id);
  if (!profileRef) {
    return fail(db, input, row.action_id, 'we have no LinkedIn profile for this person');
  }

  const body = (row.action_body ?? row.draft_body ?? '').trim();
  const base = {
    network: 'linkedin' as const,
    workspaceId: input.workspaceId,
    campaignId: row.campaign_id,
    personId: row.person_id,
    actionId: row.action_id,
    recommendationId: row.recommendation_id,
    actor: input.actor,
    ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
  };

  if (row.kind === 'view_profile') {
    const seen = await session.viewProfile(profileRef);
    await recordObservedStatus(db, {
      workspaceId: input.workspaceId,
      personId: row.person_id,
      profileRef,
      profileUrn: seen.profileUrn,
      status: seen.status,
    });
    const url = profileUrl(seen.publicIdentifier, profileRef);
    await recordSocialSent(db, {
      ...base,
      body: '',
      uri: seen.profileUrn,
      url,
      countsAsContact: false,
    });
    return { sent: true, url };
  }

  if (row.kind === 'follow') {
    const followed = await session.follow(profileRef);
    const url = profileUrl(undefined, profileRef);
    await recordSocialSent(db, {
      ...base,
      body: '',
      uri: followed.urn,
      url,
      countsAsContact: false,
    });
    return { sent: true, url };
  }

  // connect and send_dm both start from where the person stands with us.
  if (row.kind === 'connect' && body.length > INVITATION_NOTE_LIMIT) {
    return fail(
      db,
      input,
      row.action_id,
      `the invitation note is over LinkedIn's ${INVITATION_NOTE_LIMIT}-character limit`,
    );
  }
  if (row.kind === 'send_dm') {
    if (!body) return fail(db, input, row.action_id, 'there is no message to send');
    if (body.length > LINKEDIN_MESSAGE_LIMIT) {
      return fail(
        db,
        input,
        row.action_id,
        `the message is over ${LINKEDIN_MESSAGE_LIMIT} characters`,
      );
    }
  }

  const seen = await session.lookupProfile(profileRef);
  await recordObservedStatus(db, {
    workspaceId: input.workspaceId,
    personId: row.person_id,
    profileRef,
    profileUrn: seen.profileUrn,
    status: seen.status,
  });
  const url = profileUrl(seen.publicIdentifier, profileRef);

  if (row.kind === 'connect') {
    if (seen.status === 'connected') {
      return fail(db, input, row.action_id, 'they are already a LinkedIn connection');
    }
    if (seen.status === 'pending') {
      return fail(db, input, row.action_id, 'an invitation to them is already pending');
    }

    const invited = await session.connect(seen.profileUrn, body || undefined);
    await recordInvitationSent(db, {
      workspaceId: input.workspaceId,
      personId: row.person_id,
      campaignId: row.campaign_id,
      actionId: row.action_id,
      profileRef,
      profileUrn: seen.profileUrn,
    });
    await recordSocialSent(db, {
      ...base,
      body,
      uri: invited.invitationUrn ?? seen.profileUrn,
      url,
    });
    return { sent: true, url };
  }

  // send_dm
  if (seen.status !== 'connected') {
    return fail(
      db,
      input,
      row.action_id,
      'they are not a LinkedIn connection, so a message cannot reach them',
    );
  }
  const sent = await session.sendMessage(seen.profileUrn, body);
  await recordSocialSent(db, { ...base, body, uri: sent.urn ?? seen.profileUrn, url });
  return { sent: true, url };
}

/** A canonical profile link for the card, from what we know best. */
function profileUrl(publicIdentifier: string | undefined, ref: string): string {
  if (publicIdentifier) return `https://www.linkedin.com/in/${publicIdentifier}/`;
  if (/^https?:\/\//i.test(ref)) return ref;
  if (ref.startsWith('urn:')) return 'https://www.linkedin.com/';
  return `https://www.linkedin.com/in/${encodeURIComponent(ref)}/`;
}

/**
 * A final answer for this action: failed, with the reason on the card and in
 * the audit log. Not retried — a refusal from LinkedIn repeated on a timer is
 * exactly the pattern that gets an account restricted.
 */
async function fail(
  db: Client,
  input: { workspaceId: string; actor: AuditActor },
  actionId: string,
  message: string,
): Promise<DeliverLinkedInResult> {
  const reason = message.slice(0, 500);
  await db.execute({
    sql: `UPDATE actions SET status = 'failed', error = ? WHERE id = ?`,
    args: [reason, actionId],
  });
  await auditAction(db, input.workspaceId, actionId, input.actor, {
    eventType: 'action.send_failed',
    detail: { network: 'linkedin', error: reason },
  });
  return { sent: false, reason };
}
