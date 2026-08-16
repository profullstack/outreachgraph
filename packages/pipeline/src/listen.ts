/**
 * Listening: a campaign's keywords against public feeds (PRD §8, §11).
 *
 * The existing intake works company-first — a keyword names domains, the
 * domains are crawled, the pages name people. That finds the buyers of
 * developer tooling and almost nobody else. The people a trade supplier or a
 * local services business needs are not on a company About page; they are
 * posting "can anyone recommend…" in a subreddit, a forum or a trade
 * publication's comments.
 *
 * This stage runs the other way round. It searches feeds for the campaign's
 * own keywords, and every matching post becomes two rows: the person who wrote
 * it, and the signal that made them worth noticing.
 *
 * **What it does not do is promote a stranger to a send.** A social handle is
 * a weak identity — a Reddit username is not a name, a company or an address —
 * so people found this way are written with low identity confidence, below the
 * workspace's `min_outreach_confidence` floor. The policy engine then refuses
 * outbound actions against them until something else raises that confidence.
 * That is the intended behaviour and not a limitation to route around: the
 * honest path from a public post to a message is to work out who the person
 * actually is first, and the queue is where that decision belongs.
 */

import { newId, type SignalType } from '@outreachgraph/domain';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  classifyPost,
  FeedRateLimitError,
  type FeedPost,
  type FeedSource,
} from '@outreachgraph/providers';
import { recordDiscovered } from './stages';

export interface ListenDeps {
  readonly db: Client;
  /** The feeds to search. An empty list is a no-op, not an error. */
  readonly sources: readonly FeedSource[];
  readonly now?: Date;
}

export interface ListenInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  /** How far back to look. Defaults to a week. */
  readonly since?: Date;
  /** Posts to take per source. */
  readonly limit?: number;
}

export interface ListenResult {
  readonly campaignId: string;
  readonly terms: readonly string[];
  /** Posts returned by the sources, before de-duplication. */
  readonly found: number;
  /** Signals actually written — posts not already seen. */
  readonly kept: number;
  readonly peopleCreated: number;
  readonly bySource: Readonly<Record<string, number>>;
  /** Sources that failed, and why. A dead relay is not a failed run. */
  readonly failures: readonly { readonly slug: string; readonly reason: string }[];
}

/** A week is long enough to catch a weekend post, short enough to stay intent. */
const DEFAULT_WINDOW_DAYS = 7;

/**
 * A handle is not an identity.
 *
 * Deliberately far below the 0.85 outreach floor: the product knows a username
 * said something, and nothing else. Raising this to make listening-sourced
 * people contactable would be defeating the identity gate rather than passing
 * it.
 */
const HANDLE_ONLY_CONFIDENCE = 0.35;

export async function runListening(deps: ListenDeps, input: ListenInput): Promise<ListenResult> {
  const { db } = deps;
  const at = deps.now ?? new Date();

  const terms = await campaignTerms(db, input.workspaceId, input.campaignId);
  const bySource: Record<string, number> = {};
  const failures: { slug: string; reason: string }[] = [];

  const empty: ListenResult = {
    campaignId: input.campaignId,
    terms,
    found: 0,
    kept: 0,
    peopleCreated: 0,
    bySource,
    failures,
  };

  if (terms.length === 0 || deps.sources.length === 0) return empty;

  const since = input.since ?? new Date(at.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);

  let found = 0;
  let kept = 0;
  let peopleCreated = 0;

  for (const source of deps.sources) {
    let posts: readonly FeedPost[];

    try {
      posts = await source.search({
        terms,
        since,
        ...(input.limit ? { limit: input.limit } : {}),
      });
    } catch (error) {
      // A rate limit or an unreachable relay costs that source, not the run.
      // Reported rather than swallowed, because "listening found nothing" and
      // "listening could not look" are different problems.
      failures.push({
        slug: source.slug,
        reason:
          error instanceof FeedRateLimitError
            ? 'rate limited'
            : error instanceof Error
              ? error.message
              : String(error),
      });
      continue;
    }

    found += posts.length;
    bySource[source.slug] = posts.length;

    for (const post of posts) {
      // The same post reached twice — two overlapping terms, two relays, or
      // simply the next run an hour later — must not become a second signal.
      const seen = await queryOne<{ id: string }>(
        db,
        'SELECT id FROM signals WHERE workspace_id = ? AND source_url = ? LIMIT 1',
        [input.workspaceId, post.url],
      );
      if (seen) continue;

      const person = await findOrCreatePerson(db, post, at);
      if (person.created) peopleCreated += 1;

      await writeSignal(db, {
        workspaceId: input.workspaceId,
        personId: person.id,
        post,
        at,
      });

      await linkToCampaign(db, {
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        personId: person.id,
        created: person.created,
        at,
      });

      kept += 1;
    }
  }

  return { campaignId: input.campaignId, terms, found, kept, peopleCreated, bySource, failures };
}

/**
 * The phrases this campaign is listening for.
 *
 * Its ICP keywords, plus the competitor names from the offering — someone
 * complaining about a competitor by name is the strongest listening signal
 * there is, and it is already written down during setup.
 */
async function campaignTerms(
  db: Client,
  workspaceId: string,
  campaignId: string,
): Promise<string[]> {
  const row = await queryOne<{ keywords: string | null; competitors: string | null }>(
    db,
    `SELECT f.keywords, o.competitors
       FROM campaigns c
       LEFT JOIN campaign_filters f ON f.campaign_id = c.id
       LEFT JOIN offerings o ON o.id = c.offering_id
      WHERE c.id = ? AND c.workspace_id = ? AND c.status != 'archived'`,
    [campaignId, workspaceId],
  );

  if (!row) return [];

  const terms = [...parseList(row.keywords), ...parseList(row.competitors)]
    .map((term) => term.trim())
    // Single characters and stray punctuation match everything.
    .filter((term) => term.length >= 3);

  return [...new Set(terms)];
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The person behind a post, by their handle on that network.
 *
 * Matched on `social_identities`, which is the same table the identity
 * resolver uses — so if this person is later resolved to a real name and
 * company through any other path, the signals collected here attach to that
 * same person rather than to a duplicate.
 */
async function findOrCreatePerson(
  db: Client,
  post: FeedPost,
  at: Date,
): Promise<{ id: string; created: boolean }> {
  const existing = await queryOne<{ person_id: string }>(
    db,
    `SELECT person_id FROM social_identities
      WHERE network = ? AND handle = ? ORDER BY confidence DESC LIMIT 1`,
    [post.network, post.authorHandle],
  );

  if (existing) return { id: existing.person_id, created: false };

  const personId = newId('person');
  const stamp = at.toISOString();

  await db.execute({
    sql: `INSERT INTO people (id, display_name, identity_confidence, status,
          outreach_eligible, believed_minor, created_at, updated_at)
          VALUES (?, ?, ?, 'active', 1, 0, ?, ?)`,
    args: [
      personId,
      post.authorDisplayName?.trim() || post.authorHandle,
      HANDLE_ONLY_CONFIDENCE,
      stamp,
      stamp,
    ],
  });

  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, profile_url,
          confidence, source_type, verified_by, first_seen_at, last_verified_at)
          VALUES (?, ?, ?, ?, ?, ?, 'public_web', '[]', ?, ?)`,
    args: [
      newId('socialIdentity'),
      personId,
      post.network,
      post.authorHandle,
      post.authorUrl ?? null,
      HANDLE_ONLY_CONFIDENCE,
      stamp,
      stamp,
    ],
  });

  return { id: personId, created: true };
}

async function writeSignal(
  db: Client,
  input: { workspaceId: string; personId: string; post: FeedPost; at: Date },
): Promise<void> {
  const { post } = input;
  const classification = classifyPost(post.text);
  const stamp = input.at.toISOString();

  await db.execute({
    sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, subtype,
          summary, evidence, source_url, source_timestamp, observed_at, confidence,
          relevance, sentiment)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('signal'),
      input.workspaceId,
      input.personId,
      post.network,
      classification.type satisfies SignalType,
      post.container ?? null,
      summarise(post),
      // The verbatim post. Without it the composer has nothing it may quote,
      // and a draft with no grounding is withheld rather than invented.
      post.text,
      post.url,
      post.postedAt,
      stamp,
      classification.confidence,
      // Relevance is left mid-scale: the post matched the campaign's own
      // terms, which is evidence of topic and not of fit.
      0.5,
      sentimentFor(classification.type),
    ],
  });
}

function summarise(post: FeedPost): string {
  const where = post.container ? ` in ${post.container}` : '';
  const headline = post.title?.trim() || post.text;
  return `${post.authorHandle}${where}: ${headline.slice(0, 180)}`;
}

function sentimentFor(type: SignalType): 'positive' | 'neutral' | 'negative' {
  if (type === 'public_complaint' || type === 'pain') return 'negative';
  if (type === 'purchase_intent') return 'positive';
  return 'neutral';
}

/**
 * Puts the person in the campaign so they appear in the funnel.
 *
 * `INSERT OR IGNORE`: a person found twice by two campaigns, or twice by the
 * same one, is one row. The stage event is only recorded for a genuinely new
 * person, so the funnel's discovered count stays a count of people rather than
 * of posts.
 */
async function linkToCampaign(
  db: Client,
  input: {
    workspaceId: string;
    campaignId: string;
    personId: string;
    created: boolean;
    at: Date;
  },
): Promise<void> {
  const stamp = input.at.toISOString();

  await db.execute({
    sql: `INSERT OR IGNORE INTO campaign_people (campaign_id, person_id, workspace_id, status,
          interaction_state, discovered_at, updated_at)
          VALUES (?, ?, ?, 'discovered', 'never_contacted', ?, ?)`,
    args: [input.campaignId, input.personId, input.workspaceId, stamp, stamp],
  });

  if (input.created) {
    await recordDiscovered(db, {
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      personId: input.personId,
      at: stamp,
    });
  }
}

/** Every campaign a listening pass should run for. */
export async function listeningCampaigns(
  db: Client,
  workspaceId: string,
): Promise<{ id: string; name: string }[]> {
  return queryAll<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM campaigns
      WHERE workspace_id = ? AND status != 'archived'
      ORDER BY created_at ASC`,
    [workspaceId],
  );
}
