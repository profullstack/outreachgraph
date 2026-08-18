/**
 * Turning what a prospect did into something the scoring engine can read.
 *
 * `scoreRelationship` has existed since the first migration and has never
 * received an input — `rescoreProspect` passed a literal `relationship: 0`,
 * so a prospect who replied last week and one who has never heard of us
 * produced the same opportunity score. The reply reader fixed that for the
 * policy engine (it refuses to write to someone mid-conversation) but the fact
 * never reached the ranking, which is why the queue kept offering cold
 * prospects above warm ones.
 *
 * This module is the join between the two. It reads only facts the product
 * actually recorded — an inbound reply, a click we believe — and never infers
 * warmth from an absence.
 */

import {
  classifyFetch,
  newId,
  rewriteUrls,
  trackedLinkUrl,
  type AutomatedFetch,
} from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import type { RelationshipInput } from '@outreachgraph/scoring';

// ------------------------------------------------------------------ sending

export interface TrackLinksInput {
  readonly workspaceId: string;
  readonly personId: string;
  readonly campaignId?: string | undefined;
  readonly actionId?: string | undefined;
  readonly body: string;
  /** Origin the redirect is served from, e.g. `https://app.example.com`. */
  readonly origin: string;
}

export interface TrackLinksResult {
  /** The body to actually send. Unchanged when nothing was tracked. */
  readonly body: string;
  readonly tracked: number;
}

/**
 * Rewrites every link in an approved body to a tracked one.
 *
 * Runs at send time, after the §14.2 quality gates have passed, so a rewritten
 * URL can never be the reason a draft fails its grounding checks — the checks
 * read the words the composer wrote, and this only changes where a link
 * points on the way out of the door.
 *
 * A link whose row cannot be written is left as it was rather than dropped.
 * Losing the measurement is a bad day; sending a sentence that references a
 * link which is no longer there is a bad message.
 */
export async function trackLinksInBody(
  db: Client,
  input: TrackLinksInput,
): Promise<TrackLinksResult> {
  const pending: Array<{ token: string; url: string }> = [];

  const rewritten = rewriteUrls(input.body, (url) => {
    // Never track a link that already points at our own redirect: a resend of
    // an already-tracked body would otherwise nest tokens until the URL is
    // longer than the message.
    if (url.startsWith(trackedLinkUrl(input.origin, ''))) return undefined;

    const token = newId('trackedLink');
    pending.push({ token, url });
    return trackedLinkUrl(input.origin, token);
  });

  if (pending.length === 0) return { body: input.body, tracked: 0 };

  const stamp = now();
  const written: string[] = [];

  for (const link of pending) {
    try {
      await db.execute({
        sql: `INSERT INTO tracked_links (id, workspace_id, person_id, campaign_id,
              action_id, target_url, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          link.token,
          input.workspaceId,
          input.personId,
          input.campaignId ?? null,
          input.actionId ?? null,
          link.url,
          stamp,
        ],
      });
      written.push(link.token);
    } catch {
      // Fall through: this link keeps its original destination below.
    }
  }

  if (written.length === pending.length) {
    return { body: rewritten.text, tracked: written.length };
  }

  // Some rows failed. Rebuild from the original body so the untrackable links
  // keep their real destination instead of pointing at a token that resolves
  // to nothing.
  const usable = new Map(pending.filter((l) => written.includes(l.token)).map((l) => [l.url, l]));
  const partial = rewriteUrls(input.body, (url) => {
    const link = usable.get(url);
    return link ? trackedLinkUrl(input.origin, link.token) : undefined;
  });

  return { body: partial.text, tracked: written.length };
}

// ---------------------------------------------------------------- receiving

export interface RecordClickInput {
  readonly token: string;
  readonly userAgent?: string | undefined;
  readonly at?: Date;
}

export interface RecordClickResult {
  readonly targetUrl: string;
  readonly personId: string;
  readonly workspaceId: string;
  readonly campaignId: string | null;
  /** Set when the hit was not counted as a person. */
  readonly automated?: AutomatedFetch;
  /** True when this is the first believed click on any link in this message. */
  readonly firstClick: boolean;
}

/**
 * Records a hit on a tracked link and returns where to send the browser.
 *
 * The destination comes from the stored row and nowhere else. Accepting it
 * from the request would make this an open redirect on our own domain, which
 * is a phishing primitive, and no amount of allow-listing makes publishing one
 * a good idea.
 *
 * Returns `undefined` for an unknown token so the caller can 404 rather than
 * inventing a destination.
 */
export async function recordLinkClick(
  db: Client,
  input: RecordClickInput,
): Promise<RecordClickResult | undefined> {
  const link = await queryOne<{
    id: string;
    workspace_id: string;
    person_id: string;
    campaign_id: string | null;
    target_url: string;
    created_at: string;
  }>(
    db,
    `SELECT id, workspace_id, person_id, campaign_id, target_url, created_at
       FROM tracked_links WHERE id = ?`,
    [input.token],
  );

  if (!link) return undefined;

  const fetchedAt = input.at ?? new Date();
  const automated = classifyFetch({
    userAgent: input.userAgent,
    sentAt: new Date(link.created_at),
    fetchedAt,
  });

  await db.execute({
    sql: `INSERT INTO link_clicks (id, tracked_link_id, workspace_id, person_id,
          automated, user_agent, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('linkClick'),
      link.id,
      link.workspace_id,
      link.person_id,
      automated ?? null,
      input.userAgent?.slice(0, 500) ?? null,
      fetchedAt.toISOString(),
    ],
  });

  let firstClick = false;

  if (!automated) {
    // One interaction per person per campaign, not per click. Someone who
    // opens the same link four times has engaged once, and counting each hit
    // would let a single curious reader outrank a campaign.
    const existing = await queryOne<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM interactions
        WHERE workspace_id = ? AND person_id = ? AND direction = 'inbound' AND state = 'clicked'`,
      [link.workspace_id, link.person_id],
    );

    if (Number(existing?.n ?? 0) === 0) {
      firstClick = true;
      await db.execute({
        sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network,
              direction, state, occurred_at, recorded_at)
              VALUES (?, ?, ?, ?, 'email', 'inbound', 'clicked', ?, ?)`,
        args: [
          newId('interaction'),
          link.workspace_id,
          link.person_id,
          link.campaign_id,
          fetchedAt.toISOString(),
          now(),
        ],
      });
    }
  }

  return {
    targetUrl: link.target_url,
    personId: link.person_id,
    workspaceId: link.workspace_id,
    campaignId: link.campaign_id,
    ...(automated ? { automated } : {}),
    firstClick,
  };
}

// ------------------------------------------------------------------ scoring

export interface EngagementFacts {
  readonly previouslyReplied: boolean;
  readonly clickedLink: boolean;
  /** A mailbox this workspace can actually send from. */
  readonly hasConnectedAccount: boolean;
}

/**
 * What we honestly know about our history with one person.
 *
 * Only two of `RelationshipInput`'s fields have a source in this product
 * today, and the rest are deliberately left undefined rather than defaulted to
 * `false`. `scoreRelationship` treats absent and false identically, so nothing
 * is lost by staying silent, and a field that is silent is one nobody will
 * later mistake for a measurement.
 */
export async function engagementFor(
  db: Client,
  workspaceId: string,
  personId: string,
): Promise<EngagementFacts> {
  const counts = await queryOne<{ replied: number; clicked: number }>(
    db,
    `SELECT
        sum(CASE WHEN state = 'replied' THEN 1 ELSE 0 END) AS replied,
        sum(CASE WHEN state = 'clicked' THEN 1 ELSE 0 END) AS clicked
       FROM interactions
      WHERE workspace_id = ? AND person_id = ? AND direction = 'inbound'`,
    [workspaceId, personId],
  );

  // `integrations.status` is 'connected' while `integration_accounts.status`
  // is 'active' — two different vocabularies for the same fact, set by
  // `connectEmailAccount`. Both are required here because a revoked credential
  // leaves the integration row behind.
  const mailbox = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM integration_accounts ia
       JOIN integrations i ON i.id = ia.integration_id
      WHERE i.workspace_id = ? AND i.kind = 'email'
        AND i.status = 'connected' AND ia.status = 'active'`,
    [workspaceId],
  );

  return {
    previouslyReplied: Number(counts?.replied ?? 0) > 0,
    clickedLink: Number(counts?.clicked ?? 0) > 0,
    hasConnectedAccount: Number(mailbox?.n ?? 0) > 0,
  };
}

/** The subset of `RelationshipInput` this product can currently answer. */
export function relationshipInputFrom(facts: EngagementFacts): RelationshipInput {
  return {
    ...(facts.previouslyReplied ? { previouslyReplied: true } : {}),
    ...(facts.clickedLink ? { clickedLink: true } : {}),
  };
}
