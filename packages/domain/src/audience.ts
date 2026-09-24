/**
 * The audience as an intake source.
 *
 * Every other intake this product has starts from a stranger: a keyword names
 * companies, a crawl names people, a feed search finds someone complaining
 * about a category. This one starts from people who already put a hand up —
 * they followed the workspace's own account, liked its post, reposted it or
 * replied to it. Nothing about them was inferred; the engagement *is* the
 * evidence, it happened in public, and it names both parties.
 *
 * That makes it the cheapest grounded claim the product can make ("you
 * reposted the thing we wrote about X") and the one with the shortest shelf
 * life, which is why `audience_engagement` decays fast. Somebody who liked a
 * post an hour ago remembers it. Three weeks later they do not, and a message
 * that opens by reminding them reads worse than a cold one.
 *
 * Everything here is arithmetic and naming so the same rules run in the
 * watcher, in the API validating what a client sends, and in tests, with no
 * network and no clock between them.
 */

import type { Network } from './networks';

/**
 * Networks whose audience we can read.
 *
 * Deliberately three. Bluesky's API is public and unauthenticated, so a watch
 * there needs nothing but a handle. X's needs the workspace's own connected
 * account and a plan that permits the read. LinkedIn is here for the hand-off
 * route only — see `AUDIENCE_MODES` — because reading reactions would mean
 * automating the member's session for something the opt-in never covered.
 */
export const AUDIENCE_NETWORKS = ['bluesky', 'x', 'linkedin'] as const satisfies readonly Network[];

export type AudienceNetwork = (typeof AUDIENCE_NETWORKS)[number];

export function isAudienceNetwork(value: unknown): value is AudienceNetwork {
  return typeof value === 'string' && (AUDIENCE_NETWORKS as readonly string[]).includes(value);
}

/**
 * How a watch gets its engagements.
 *
 * `poll` reads the network on a schedule. `handoff` is filled by a human or a
 * client posting what they saw — the same route the product already uses
 * wherever automating a network would break its terms. The two produce
 * identical rows downstream; only the provenance differs, and it is recorded.
 */
export const AUDIENCE_MODES = ['poll', 'handoff'] as const;
export type AudienceMode = (typeof AUDIENCE_MODES)[number];

export function isAudienceMode(value: unknown): value is AudienceMode {
  return typeof value === 'string' && (AUDIENCE_MODES as readonly string[]).includes(value);
}

/** The mode a network supports. LinkedIn has no readable audience for us. */
export function modesFor(network: AudienceNetwork): readonly AudienceMode[] {
  return network === 'linkedin' ? ['handoff'] : ['poll', 'handoff'];
}

/**
 * What somebody did.
 *
 * Ordered weakest to strongest on purpose: `AUDIENCE_KIND_WEIGHTS` reads the
 * same way, and a reviewer comparing the two lists should not have to hold an
 * ordering in their head.
 */
export const AUDIENCE_KINDS = ['follow', 'like', 'repost', 'reply', 'mention'] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

export function isAudienceKind(value: unknown): value is AudienceKind {
  return typeof value === 'string' && (AUDIENCE_KINDS as readonly string[]).includes(value);
}

/**
 * Relevance, by how much effort the act took.
 *
 * A follow is a bookmark — it often says "this account posts things I like"
 * and nothing about a purchase. A reply is somebody spending words on you.
 * The numbers are the signal's `relevance`, and they matter because the
 * recommendation engine ranks on it and because a rule can be written as
 * "enrol anyone whose engagement scores above 0.6", which is a legible way of
 * saying "repliers and reposters, not every passing follower".
 */
export const AUDIENCE_KIND_WEIGHTS = {
  follow: 0.35,
  like: 0.45,
  repost: 0.65,
  reply: 0.8,
  mention: 0.8,
} as const satisfies Record<AudienceKind, number>;

export function relevanceFor(kind: AudienceKind): number {
  return AUDIENCE_KIND_WEIGHTS[kind];
}

/**
 * Confidence that the classification is right.
 *
 * High and flat, unlike the feed classifier's, because there is nothing to
 * classify: the network told us who liked what. The only way this is wrong is
 * if the API lied. It is not 1 because a like can be a misclick and because
 * nothing in this product is ever certain about a person's intent.
 */
export const AUDIENCE_SIGNAL_CONFIDENCE = 0.95;

/** Past tense, for a sentence a human will read on a card. */
const KIND_VERBS = {
  follow: 'followed',
  like: 'liked',
  repost: 'reposted',
  reply: 'replied to',
  mention: 'mentioned',
} as const satisfies Record<AudienceKind, string>;

export function verbFor(kind: AudienceKind): string {
  return KIND_VERBS[kind];
}

export interface EngagementSummaryInput {
  readonly kind: AudienceKind;
  /** The handle that engaged, without a leading `@`. */
  readonly actor: string;
  /** The watched account they engaged with, without a leading `@`. */
  readonly account: string;
  /** The post's own text, when the act had one. A follow does not. */
  readonly subjectText?: string | undefined;
}

/** How long a quoted post stays a quote rather than a wall. */
const EXCERPT_LIMIT = 160;

/**
 * One line naming who did what to which post.
 *
 * The post's own words are in it, trimmed, because the summary is what a
 * drafting model is given and "liked a post" is not something you can write a
 * first sentence from. What it never contains is an interpretation: not
 * "is interested in", not "is evaluating". They liked a post. That is all
 * that happened, and the draft has to start from the same fact the human
 * reviewer can check.
 */
export function engagementSummary(input: EngagementSummaryInput): string {
  const actor = input.actor.replace(/^@/, '');
  const account = input.account.replace(/^@/, '');
  const verb = verbFor(input.kind);

  if (input.kind === 'follow') return `@${actor} followed @${account}`;

  const excerpt = excerptOf(input.subjectText ?? '');
  const what = excerpt ? `@${account}'s post: "${excerpt}"` : `a post by @${account}`;
  return `@${actor} ${verb} ${what}`;
}

/** Collapses whitespace and cuts on a word boundary, so a quote reads as one. */
export function excerptOf(text: string, limit = EXCERPT_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;

  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The key that makes an engagement idempotent.
 *
 * A poll re-reads the same window every time it runs, so the same like is
 * seen on every tick for as long as it is in the window. Keyed on the act
 * rather than on when we saw it: `(watch, kind, actor, subject)`. Somebody who
 * likes a post, unlikes it and likes it again is not a second signal — the
 * product cannot tell that apart from a re-read, and inventing a second
 * signal would be inventing warmth.
 */
export function engagementKey(input: {
  readonly kind: AudienceKind;
  readonly actor: string;
  /** Post id or URI; empty for a follow, which has no subject. */
  readonly subject?: string | undefined;
}): string {
  const actor = input.actor.replace(/^@/, '').toLowerCase();
  return `${input.kind}:${actor}:${(input.subject ?? '').toLowerCase()}`;
}

/** How often a watch is worth re-reading. */
export const DEFAULT_POLL_MINUTES = 30;
export const MIN_POLL_MINUTES = 5;

/** How far back a poll looks for posts to read engagement on. */
export const DEFAULT_LOOKBACK_POSTS = 10;
export const MAX_LOOKBACK_POSTS = 50;

/** Most engagements one run may turn into people, so a viral post cannot flood a campaign. */
export const DEFAULT_PER_RUN_CAP = 100;
export const MAX_PER_RUN_CAP = 500;

export interface AudienceWatchInput {
  readonly network?: unknown;
  readonly account?: unknown;
  readonly campaignId?: unknown;
  readonly kinds?: unknown;
  readonly mode?: unknown;
  readonly pollMinutes?: unknown;
  readonly lookbackPosts?: unknown;
  readonly perRunCap?: unknown;
  readonly enabled?: unknown;
}

export interface AudienceWatchSpec {
  readonly network: AudienceNetwork;
  /** Handle or DID, normalised: no `@`, no URL, lower-cased. */
  readonly account: string;
  readonly campaignId: string;
  readonly kinds: readonly AudienceKind[];
  readonly mode: AudienceMode;
  readonly pollMinutes: number;
  readonly lookbackPosts: number;
  readonly perRunCap: number;
  readonly enabled: boolean;
}

/**
 * Accepts what somebody actually pastes and refuses the rest.
 *
 * People paste `@acme.bsky.social`, `https://x.com/acme` or a bare handle, and
 * all three mean the same account. Rejecting two of the three in favour of the
 * one this module prefers teaches a rule for no reason — the same argument
 * `normaliseSubreddit` makes about `r/`.
 */
export function parseAudienceWatch(
  input: AudienceWatchInput,
): AudienceWatchSpec | { reason: string } {
  const network = String(input.network ?? '')
    .trim()
    .toLowerCase();
  if (!isAudienceNetwork(network)) {
    return { reason: `network must be one of ${AUDIENCE_NETWORKS.join(', ')}` };
  }

  const account = normaliseAccount(network, String(input.account ?? ''));
  if (!account) return { reason: 'account is not a handle' };

  const campaignId = String(input.campaignId ?? '').trim();
  if (!campaignId) return { reason: 'campaignId is required' };

  const kinds = parseKinds(input.kinds);
  if (kinds.length === 0) return { reason: 'no recognised engagement kinds' };

  const mode = isAudienceMode(input.mode) ? input.mode : (modesFor(network)[0] as AudienceMode);
  if (!modesFor(network).includes(mode)) {
    return { reason: `${network} watches can only be ${modesFor(network).join(' or ')}` };
  }

  return {
    network,
    account,
    campaignId,
    kinds,
    mode,
    pollMinutes: clamp(input.pollMinutes, DEFAULT_POLL_MINUTES, MIN_POLL_MINUTES, 24 * 60),
    lookbackPosts: clamp(input.lookbackPosts, DEFAULT_LOOKBACK_POSTS, 1, MAX_LOOKBACK_POSTS),
    perRunCap: clamp(input.perRunCap, DEFAULT_PER_RUN_CAP, 1, MAX_PER_RUN_CAP),
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
  };
}

/** Handles as each network writes them, from whatever form was pasted. */
export function normaliseAccount(network: AudienceNetwork, raw: string): string | undefined {
  let value = raw.trim();
  if (value === '') return undefined;

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
      // `bsky.app/profile/<handle>`, `x.com/<handle>`, `linkedin.com/in/<slug>`.
      const parts = path.split('/');
      value = (parts[0] === 'profile' || parts[0] === 'in' ? parts[1] : parts[0]) ?? '';
    } catch {
      return undefined;
    }
  }

  value = value.replace(/^@/, '').trim().toLowerCase();
  if (value === '' || value.length > 200) return undefined;
  // A DID is legal on Bluesky and contains colons; everything else is a handle.
  if (value.startsWith('did:')) return network === 'bluesky' ? value : undefined;
  return /^[a-z0-9][a-z0-9._-]*$/.test(value) ? value : undefined;
}

function parseKinds(raw: unknown): readonly AudienceKind[] {
  if (raw === undefined || raw === null) return AUDIENCE_KINDS;
  const list = Array.isArray(raw) ? raw : [raw];
  const kinds = list
    .map((value) => String(value).trim().toLowerCase())
    .filter((value): value is AudienceKind => isAudienceKind(value));
  return [...new Set(kinds)];
}

function clamp(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** True when a watch polled at `lastPolledAt` is due again at `at`. */
export function isDue(
  watch: { readonly pollMinutes: number; readonly enabled: boolean; readonly mode: AudienceMode },
  lastPolledAt: string | null | undefined,
  at: Date,
): boolean {
  if (!watch.enabled || watch.mode !== 'poll') return false;
  if (!lastPolledAt) return true;

  const last = Date.parse(lastPolledAt);
  // An unparseable stamp is a corrupt row, not a licence to hammer the API.
  if (!Number.isFinite(last)) return false;
  return at.getTime() - last >= watch.pollMinutes * 60_000;
}
