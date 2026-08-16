/**
 * Where one campaign listens (PRD §8, §11).
 *
 * Listening's keywords have always been per-campaign — they come from the ICP
 * filters and the offering's competitors. Its *targets* were not: the
 * subreddits and feeds came from process environment variables, so every
 * workspace on a deployment listened to the same places. Terms scoped to the
 * campaign and locations scoped to the container is a mismatch that cannot be
 * configured around, only moved, which is what this module does.
 *
 * Everything here is stored on `campaign_filters` beside the keywords, so a
 * campaign's targeting is one row and stays inspectable.
 */

import { queryOne, type Client } from '@outreachgraph/db';

/** The feeds a campaign can search. */
export const LISTEN_SOURCE_SLUGS = ['reddit', 'rss', 'bluesky', 'nostr'] as const;

export type ListenSourceSlug = (typeof LISTEN_SOURCE_SLUGS)[number];

export interface ListeningTargets {
  /** Empty means this campaign does not listen. */
  readonly sources: readonly ListenSourceSlug[];
  /** Bare names, without `r/`. Empty means site-wide. */
  readonly subreddits: readonly string[];
  /** Absolute http(s) feed URLs. */
  readonly feeds: readonly string[];
}

export const NO_LISTENING: ListeningTargets = { sources: [], subreddits: [], feeds: [] };

export interface ListeningTargetsInput {
  readonly sources?: readonly string[];
  readonly subreddits?: readonly string[];
  readonly feeds?: readonly string[];
}

/**
 * Reddit's own limits: 3-21 characters, letters, digits and underscores.
 *
 * Worth enforcing rather than passing through, because an invalid name does
 * not fail loudly — the search endpoint returns an empty listing, which is
 * indistinguishable from a real community that happened to be quiet.
 */
const SUBREDDIT_NAME = /^[A-Za-z0-9_]{3,21}$/;

/**
 * Accepts what someone actually pastes.
 *
 * People copy `r/plumbing`, `/r/plumbing`, or the full URL from the address
 * bar. Rejecting those in favour of a bare name teaches a rule for no reason.
 */
export function normaliseSubreddit(value: string): string | undefined {
  let name = value.trim();
  if (name === '') return undefined;

  const url = name.match(/^https?:\/\/(?:[a-z0-9-]+\.)?reddit\.com\/r\/([^/?#]+)/i);
  if (url?.[1]) name = url[1];

  name = name.replace(/^\/?r\//i, '').replace(/\/+$/, '');

  return SUBREDDIT_NAME.test(name) ? name : undefined;
}

/** Feed URLs must be absolute and http(s); anything else cannot be fetched. */
export function normaliseFeedUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function isSourceSlug(value: string): value is ListenSourceSlug {
  return (LISTEN_SOURCE_SLUGS as readonly string[]).includes(value);
}

/**
 * Cleans user input into storable targets, dropping what cannot work.
 *
 * Silently dropping an unknown source would let a typo read as "listening is
 * on" while nothing polls, so `unknown` is returned for the caller to reject.
 */
export function normaliseTargets(input: ListeningTargetsInput): {
  readonly targets: ListeningTargets;
  readonly unknown: readonly string[];
} {
  const unknown: string[] = [];
  const sources: ListenSourceSlug[] = [];

  for (const raw of input.sources ?? []) {
    const slug = raw.trim().toLowerCase();
    if (slug === '') continue;
    if (isSourceSlug(slug)) sources.push(slug);
    else unknown.push(raw.trim());
  }

  const subreddits = (input.subreddits ?? [])
    .map(normaliseSubreddit)
    .filter((name): name is string => name !== undefined);

  const feeds = (input.feeds ?? [])
    .map(normaliseFeedUrl)
    .filter((url): url is string => url !== undefined);

  return {
    targets: {
      sources: [...new Set(sources)],
      // Case-insensitively unique: r/Plumbing and r/plumbing are one community.
      subreddits: dedupe(subreddits, (name) => name.toLowerCase()),
      feeds: dedupe(feeds, (url) => url),
    },
    unknown,
  };
}

function dedupe(values: readonly string[], key: (value: string) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const k = key(value);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(value);
  }

  return out;
}

function parseList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * What this campaign listens to, or nothing if it is archived or unknown.
 *
 * An archived campaign returning no targets is what stops a paused campaign
 * quietly continuing to poll and bank signals nobody asked for.
 */
export async function loadListeningTargets(
  db: Client,
  workspaceId: string,
  campaignId: string,
): Promise<ListeningTargets> {
  const row = await queryOne<{
    listen_sources: string | null;
    listen_subreddits: string | null;
    listen_feeds: string | null;
  }>(
    db,
    `SELECT f.listen_sources, f.listen_subreddits, f.listen_feeds
       FROM campaigns c
       LEFT JOIN campaign_filters f ON f.campaign_id = c.id
      WHERE c.id = ? AND c.workspace_id = ? AND c.status != 'archived'`,
    [campaignId, workspaceId],
  );

  if (!row) return NO_LISTENING;

  return normaliseTargets({
    sources: parseList(row.listen_sources),
    subreddits: parseList(row.listen_subreddits),
    feeds: parseList(row.listen_feeds),
  }).targets;
}

/**
 * Stores targeting for a campaign.
 *
 * Upserts `campaign_filters` because a campaign created before its ICP was
 * generated has no filters row yet, and choosing where to listen should not
 * depend on that having happened first.
 */
export async function saveListeningTargets(
  db: Client,
  workspaceId: string,
  campaignId: string,
  targets: ListeningTargets,
  now = new Date(),
): Promise<boolean> {
  const campaign = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM campaigns WHERE id = ? AND workspace_id = ?',
    [campaignId, workspaceId],
  );

  if (!campaign) return false;

  await db.execute({
    sql: `INSERT INTO campaign_filters (campaign_id, listen_sources, listen_subreddits,
          listen_feeds, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(campaign_id) DO UPDATE SET
            listen_sources    = excluded.listen_sources,
            listen_subreddits = excluded.listen_subreddits,
            listen_feeds      = excluded.listen_feeds,
            updated_at        = excluded.updated_at`,
    args: [
      campaignId,
      JSON.stringify(targets.sources),
      JSON.stringify(targets.subreddits),
      JSON.stringify(targets.feeds),
      now.toISOString(),
    ],
  });

  return true;
}
