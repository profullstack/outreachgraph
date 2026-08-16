/**
 * Handing a drafted message to a network the product is not allowed to post to.
 *
 * Everything here is one step: build a prefilled composer URL, record that it
 * was opened, and move the lead along the funnel. No credentials, no API calls,
 * no posting on anyone's behalf — the human clicks, reads, and posts in the
 * network's own interface.
 *
 * The recording half is what makes this more than a link. A campaign where the
 * email leads advance and the social leads vanish is a campaign whose numbers
 * are wrong, and until now the entire `manual_only` half of the capability
 * matrix produced no trace at all. A composed post is stored in `social_posts`
 * and moves the lead through `recordStatus`, the same funnel transition an
 * automated send produces — see `recordShare` for why it deliberately writes
 * neither an `actions` nor an `interactions` row.
 */

import {
  buildShareLinks,
  newId,
  type ProspectStatus,
  type ShareLink,
  type ShareNetwork,
} from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import { emitEvent, recordStatus } from '@outreachgraph/pipeline';

export class SocialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocialError';
  }
}

interface DraftRow {
  readonly recommendation_id: string;
  readonly campaign_id: string;
  readonly person_id: string;
  readonly display_name: string;
  readonly subject: string | null;
  readonly body: string | null;
  readonly company_name: string | null;
  readonly company_domain: string | null;
}

async function loadDraft(
  db: Client,
  workspaceId: string,
  recommendationId: string,
): Promise<DraftRow> {
  const row = await queryOne<DraftRow>(
    db,
    `SELECT r.id AS recommendation_id, r.campaign_id, r.person_id,
            p.display_name, d.subject, d.body,
            co.name AS company_name, co.domain AS company_domain
       FROM recommendations r
       JOIN people p ON p.id = r.person_id
       LEFT JOIN drafts d ON d.recommendation_id = r.id
       LEFT JOIN companies co ON co.id = p.current_company_id
      WHERE r.id = ? AND r.workspace_id = ?`,
    [recommendationId, workspaceId],
  );

  if (!row) throw new SocialError('no such recommendation');
  return row;
}

export interface ShareOptions {
  readonly mastodonInstance?: string;
  readonly subreddit?: string;
  /** Overrides the drafted body, for a message the user edited before posting. */
  readonly text?: string;
  readonly url?: string;
}

export interface ShareView {
  readonly recommendationId: string;
  readonly personId: string;
  readonly personName: string;
  readonly companyName?: string;
  readonly text: string;
  readonly links: readonly ShareLink[];
}

/**
 * Every composer that can be offered for one recommendation.
 *
 * The prospect's own site is used as the link when nothing else is given: a
 * post about a company that does not link to it is a post that cannot be acted
 * on, and it is also what unlocks Facebook and Hacker News, which refuse to
 * open a composer without one.
 */
export async function shareLinksFor(
  db: Client,
  workspaceId: string,
  recommendationId: string,
  options: ShareOptions = {},
): Promise<ShareView> {
  const draft = await loadDraft(db, workspaceId, recommendationId);
  const text = (options.text ?? draft.body ?? '').trim();

  if (!text) {
    throw new SocialError('there is no drafted message to post yet');
  }

  const url = options.url ?? (draft.company_domain ? `https://${draft.company_domain}` : undefined);

  const links = buildShareLinks({
    text,
    ...(url ? { url } : {}),
    ...(draft.subject ? { title: draft.subject } : {}),
    ...(options.mastodonInstance ? { mastodonInstance: options.mastodonInstance } : {}),
    ...(options.subreddit ? { subreddit: options.subreddit } : {}),
  });

  return {
    recommendationId,
    personId: draft.person_id,
    personName: draft.display_name,
    ...(draft.company_name ? { companyName: draft.company_name } : {}),
    text,
    links,
  };
}

export interface RecordedShare {
  readonly socialPostId: string;
  readonly network: ShareNetwork;
  readonly shareUrl: string;
}

/**
 * Records that a composer was opened, and advances the lead.
 *
 * Recorded at open rather than on confirmation because there is no confirmation
 * to wait for — the networks involved report nothing back, and a state that can
 * only ever be reached by the user remembering to press a second button is a
 * state that stays empty. `confirmed_at` exists for the user who does press it;
 * `opened_at` is the fact the product actually knows.
 *
 * Note what this deliberately does *not* write:
 *
 *   - **No `actions` row.** `kind` and `network` there are drawn from the
 *     domain vocabulary the policy engine reasons over, and neither `post` nor
 *     `nextdoor` is in it. Inventing values would make an unknown pair appear
 *     in a table the engine reads, and the engine's fail-closed rule depends on
 *     unknown pairs meaning "never automate" rather than "someone did this
 *     once". `actions` is also what the autopilot day cap counts, and a post
 *     someone made by hand must not consume the budget for automated email.
 *   - **No `interactions` row**, for the same vocabulary reason.
 *
 * `social_posts` is the record instead, and the funnel move goes through
 * `recordStatus` exactly as an automated send does — so a lead contacted by
 * hand on Bluesky counts as contacted, which is the thing that actually
 * matters.
 */
export async function recordShare(
  db: Client,
  workspaceId: string,
  input: {
    readonly recommendationId: string;
    readonly network: ShareNetwork;
    readonly shareUrl: string;
    readonly text: string;
    readonly url?: string;
  },
): Promise<RecordedShare> {
  const draft = await loadDraft(db, workspaceId, input.recommendationId);
  const stamp = now();
  const socialPostId = newId('socialPost');

  await db.execute({
    sql: `INSERT INTO social_posts (id, workspace_id, campaign_id, person_id, recommendation_id,
          network, body, url, share_url, opened_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      socialPostId,
      workspaceId,
      draft.campaign_id,
      draft.person_id,
      input.recommendationId,
      input.network,
      input.text,
      input.url ?? null,
      input.shareUrl,
      stamp,
    ],
  });

  await db.execute({
    sql: `UPDATE recommendations SET status = 'executed' WHERE id = ?`,
    args: [input.recommendationId],
  });

  await db.execute({
    sql: `UPDATE campaign_people SET interaction_state = 'contacted', last_actioned_at = ?
           WHERE campaign_id = ? AND person_id = ?`,
    args: [stamp, draft.campaign_id, draft.person_id],
  });

  // The same funnel transition an automated email produces. A lead contacted by
  // hand on Bluesky has been contacted.
  await recordStatus(db, {
    workspaceId,
    campaignId: draft.campaign_id,
    personId: draft.person_id,
    status: 'executed' satisfies ProspectStatus,
    reason: `posted on ${input.network}`,
    at: stamp,
  });

  await db.execute({
    sql: `INSERT INTO audit_events (id, workspace_id, actor_kind, actor_id, event_type,
          entity_kind, entity_id, detail_json, occurred_at)
          VALUES (?, ?, 'user', 'share', 'social.composed', 'social_post', ?, ?, ?)`,
    args: [
      newId('auditEvent'),
      workspaceId,
      socialPostId,
      JSON.stringify({ mode: 'manual', network: input.network }),
      stamp,
    ],
  });

  await emitEvent(db, {
    workspaceId,
    campaignId: draft.campaign_id,
    personId: draft.person_id,
    phase: 'social',
    level: 'success',
    message: `Opened a ${input.network} post for ${draft.display_name}`,
    detail: { network: input.network },
  });

  return { socialPostId, network: input.network, shareUrl: input.shareUrl };
}

/** Marks a composed post as one the user says they went through with. */
export async function confirmShare(
  db: Client,
  workspaceId: string,
  socialPostId: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE social_posts SET confirmed_at = ?
           WHERE id = ? AND workspace_id = ? AND confirmed_at IS NULL`,
    args: [now(), socialPostId, workspaceId],
  });

  return result.rowsAffected > 0;
}
