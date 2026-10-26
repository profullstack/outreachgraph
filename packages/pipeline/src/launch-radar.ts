/**
 * Launch radar: the people who just shipped something in your space.
 *
 * A workflow's `launches` source. Every run reads the newest Show HN and
 * Launch HN posts, dev.to articles, GitHub repositories and Bluesky
 * announcements that mention one of its phrases, and turns each maker into a
 * person in the workflow's campaign with the launch itself as evidence. That
 * is how a rival found group.call within two hours of its launch (2026-10-26),
 * and it is the same move pointed the other way: the builders next to us are
 * the likeliest partners, integrations and early users, and a note that cites
 * the thing they shipped this morning is read.
 *
 * Reading only. Whether anyone is written to is still the policy engine's
 * call at send time; this adds people and evidence, nothing else.
 */

import { queryOne, type Client } from '@outreachgraph/db';
import { newId, type Network } from '@outreachgraph/domain';
import {
  BlueskyFeedSource,
  DevToSource,
  FeedRateLimitError,
  GitHubClient,
  GitHubRateLimitError,
  GitHubRepoSource,
  HackerNewsSource,
  stripHtml,
  type FeedPost,
  type FeedSource,
} from '@outreachgraph/providers';
import { ownDomains } from './recipient-guard';
import { intakeSocialPeople, type SocialPersonInput } from './social-intake';

/** Wording that makes a post an announcement rather than a mention. */
export const LAUNCH_WORDING =
  /\b(?:launch(?:ed|ing)?|just shipped|shipped|introducing|show hn|launch hn|(?:i|we) (?:just )?(?:built|made|released)|open[- ]sourc(?:e|ed|ing)|releas(?:ed|ing)|announcing|now live|is live|public beta|v\d+\.\d+)\b/i;

/** A launch seen in a public profile: published by the person, not guessed. */
const PROFILE_EMAIL_CONFIDENCE = 0.75;
const WEBSITE_CONFIDENCE = 0.6;
const LAUNCH_SIGNAL_CONFIDENCE = 0.9;
const LAUNCH_SIGNAL_RELEVANCE = 0.8;
/**
 * GitHub API profile lookups per run: unauthenticated GitHub allows 60 an
 * hour, shared with the rest of enrichment. Past it, makers come in on their
 * bare handle and openprofile reads their github.com page instead.
 */
const MAX_LOOKUPS_PER_RUN = 25;

export interface LaunchRadarOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  /** Raises GitHub from 60 to 5,000 requests an hour. */
  readonly githubToken?: string | undefined;
  readonly hnGapMs?: number | undefined;
}

export function buildLaunchSources(options: LaunchRadarOptions = {}): FeedSource[] {
  const fetchImpl = options.fetchImpl;
  return [
    new HackerNewsSource({
      tags: '(show_hn,launch_hn)',
      ...(options.hnGapMs !== undefined ? { gapMs: options.hnGapMs } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    new DevToSource({ ...(fetchImpl ? { fetchImpl } : {}) }),
    new GitHubRepoSource({
      ...(options.githubToken ? { token: options.githubToken } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    // public.api.bsky.app answers searchPosts with 403; the AppView serves it.
    new BlueskyFeedSource({
      baseUrl: 'https://api.bsky.app',
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
  ];
}

export interface FoundLaunches {
  readonly posts: readonly FeedPost[];
  /** Per source: posts found, or why it found none. */
  readonly bySource: Readonly<Record<string, number | string>>;
}

/**
 * The newest launches across every source, taken in turn so one busy source
 * (GitHub makes a hundred repositories a day for "voice agent") cannot fill
 * the run on its own. A source that fails is reported and skipped.
 */
export async function findLaunches(
  sources: readonly FeedSource[],
  input: { readonly terms: readonly string[]; readonly since: Date; readonly limit: number },
): Promise<FoundLaunches> {
  const bySource: Record<string, number | string> = {};
  const lists: FeedPost[][] = [];
  for (const source of sources) {
    try {
      const found = await source.search({
        terms: input.terms,
        since: input.since,
        limit: input.limit,
      });
      // Anything may mention a phrase on Bluesky; only announcements count.
      const posts = (
        source.slug === 'bluesky'
          ? found.filter((p) => LAUNCH_WORDING.test(`${p.title ?? ''}\n${p.text}`))
          : [...found]
      ).sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
      bySource[source.slug] = posts.length;
      lists.push(posts);
    } catch (error) {
      bySource[source.slug] =
        error instanceof FeedRateLimitError
          ? 'rate limited'
          : error instanceof Error
            ? error.message.slice(0, 120)
            : 'failed';
    }
  }

  const posts: FeedPost[] = [];
  const seen = new Set<string>();
  for (let i = 0; posts.length < input.limit && lists.some((l) => i < l.length); i += 1) {
    for (const list of lists) {
      const post = list[i];
      if (!post || seen.has(post.url) || posts.length >= input.limit) continue;
      seen.add(post.url);
      posts.push(post);
    }
  }
  return { posts, bySource };
}

// ------------------------------------------------------------------ makers

export interface Maker {
  readonly person: SocialPersonInput;
  /** An address the maker published on their own profile. */
  readonly email?: string | undefined;
  /** Their own site, when their profile names one. */
  readonly website?: string | undefined;
}

export interface MakerDeps {
  /** Absent: GitHub makers come in on their handle alone, no API call. */
  readonly github?: GitHubClient | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Who is behind a launch, from what their own profile publishes. Never
 * throws: a profile that cannot be read leaves the bare handle, which the
 * openprofile job and find_email still work from.
 */
export async function resolveMaker(post: FeedPost, deps: MakerDeps): Promise<Maker> {
  if (post.network === 'github') return fromGitHub(post.authorHandle, deps, post);

  if (post.network === 'hackernews') {
    const about = await hnAbout(post.authorHandle, deps.fetchImpl ?? fetch);
    return {
      person: {
        network: 'hackernews',
        handle: post.authorHandle,
        profileUrl: post.authorUrl,
        ...(about ? { bio: about } : {}),
        via: 'launch',
      },
      email: about ? publishedEmail(about) : undefined,
      website: about ? firstSite(about) : undefined,
    };
  }

  if (post.container === 'dev.to') {
    const links = post.authorLinks ?? [];
    const github = links.map((l) => /^https:\/\/github\.com\/([^/]+)$/.exec(l)?.[1]).find(Boolean);
    const website = links.find((l) => !/^https:\/\/(?:github\.com|x\.com)\//.test(l));
    if (github) {
      const maker = await fromGitHub(github, deps, post);
      return { ...maker, website: maker.website ?? website };
    }
    const x = links.map((l) => /^https:\/\/x\.com\/([^/]+)$/.exec(l)?.[1]).find(Boolean);
    return {
      person: x
        ? { network: 'x', handle: x, displayName: post.authorDisplayName, via: 'launch' }
        : {
            network: 'website',
            handle: website
              ? (hostOf(website) ?? `dev.to/${post.authorHandle}`)
              : `dev.to/${post.authorHandle}`,
            profileUrl: website ?? post.authorUrl,
            displayName: post.authorDisplayName,
            via: 'launch',
          },
      website,
    };
  }

  return {
    person: {
      network: post.network,
      handle: post.authorHandle,
      profileUrl: post.authorUrl,
      displayName: post.authorDisplayName,
      via: 'launch',
    },
  };
}

async function fromGitHub(login: string, deps: MakerDeps, post: FeedPost): Promise<Maker> {
  const bare: Maker = {
    person: {
      network: 'github',
      handle: login,
      profileUrl: `https://github.com/${login}`,
      displayName: post.authorDisplayName,
      via: 'launch',
    },
  };
  if (!deps.github) return bare;
  try {
    const user = await deps.github.getUser(login);
    return {
      person: {
        network: 'github',
        handle: user.login,
        platformUserId: String(user.id),
        profileUrl: user.html_url,
        displayName: user.name ?? post.authorDisplayName ?? user.login,
        ...(user.bio ? { bio: user.bio } : {}),
        ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
        via: 'launch',
      },
      email: user.email && usableEmail(user.email) ? user.email.toLowerCase() : undefined,
      website: user.blog ? siteUrl(user.blog) : undefined,
    };
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    return bare;
  }
}

async function hnAbout(user: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetchImpl(
      `https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(user)}.json`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as { about?: string } | null;
    const about = body?.about ? stripHtml(body.about) : '';
    return about.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The address a profile publishes, including `name [at] host [dot] com`. */
export function publishedEmail(text: string): string | undefined {
  const plain = text
    .replace(/\s*[[({<]\s*at\s*[\])}>]\s*/gi, '@')
    .replace(/\s*[[({<]\s*dot\s*[\])}>]\s*/gi, '.');
  for (const match of plain.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    if (usableEmail(match[0])) return match[0].toLowerCase();
  }
  return undefined;
}

function usableEmail(address: string): boolean {
  return !/noreply|no-reply|users\.noreply\.github\.com|example\.(?:com|org)$/i.test(address);
}

function firstSite(text: string): string | undefined {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')]+/gi)) {
    const url = match[0].replace(/[.,;]+$/, '');
    if (!/news\.ycombinator\.com|ycombinator\.com\/companies/i.test(url)) return url;
  }
  return undefined;
}

function siteUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return hostOf(url) ? url : undefined;
}

function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host.includes('.') ? host : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ intake

export interface LaunchIntakeResult {
  readonly launches: number;
  /** Launches handled by an earlier run. */
  readonly known: number;
  /** Our own launches, or makers on our own domains. */
  readonly own: number;
  readonly people: number;
  readonly created: number;
  readonly withEmail: number;
  /**
   * Taken in on their handle alone because GitHub's API budget ran out; the
   * openprofile job reads their profile page instead.
   */
  readonly handleOnly: number;
}

/**
 * Puts each launch's maker in the campaign with the launch as evidence.
 *
 * Idempotent by launch URL: a run that sees the same post again leaves it,
 * so an hourly schedule looking back a day costs one lookup per launch.
 */
export async function intakeLaunches(
  deps: { readonly db: Client; readonly makers: MakerDeps; readonly now?: Date },
  input: {
    readonly workspaceId: string;
    readonly campaignId: string;
    readonly posts: readonly FeedPost[];
  },
): Promise<LaunchIntakeResult> {
  const { db } = deps;
  const stamp = (deps.now ?? new Date()).toISOString();
  const own = await ownDomains(db, input.workspaceId);
  const onOwn = (value: string | undefined) => {
    const host = value?.includes('@') ? value.split('@')[1] : value ? hostOf(value) : undefined;
    if (!host) return false;
    for (const domain of own) if (host === domain || host.endsWith(`.${domain}`)) return true;
    return false;
  };

  let known = 0;
  let ownCount = 0;
  let people = 0;
  let created = 0;
  let withEmail = 0;
  let handleOnly = 0;
  let lookups = 0;
  let githubSpent = false;

  for (const post of input.posts) {
    const seen = await queryOne<{ id: string }>(
      db,
      `SELECT id FROM signals WHERE workspace_id = ? AND signal_type = 'launch' AND source_url = ? LIMIT 1`,
      [input.workspaceId, post.url],
    );
    if (seen) {
      known += 1;
      continue;
    }
    if (onOwn(post.url) || [...own].some((d) => post.text.toLowerCase().includes(d))) {
      ownCount += 1;
      continue;
    }
    // One rate-limited lookup must not stall the run: the first version of
    // this deferred everything after it, and with GitHub's budget shared and
    // spent every hour, nothing was ever taken in (2026-10-26).
    if (lookups >= MAX_LOOKUPS_PER_RUN) githubSpent = true;
    const makers = githubSpent ? { ...deps.makers, github: undefined } : deps.makers;
    let maker: Maker;
    try {
      if (!githubSpent) lookups += 1;
      maker = await resolveMaker(post, makers);
    } catch (error) {
      if (!(error instanceof GitHubRateLimitError)) throw error;
      githubSpent = true;
      maker = await resolveMaker(post, { ...deps.makers, github: undefined });
    }
    if (githubSpent && maker.person.network === 'github' && !maker.person.platformUserId)
      handleOnly += 1;
    if (onOwn(maker.email) || onOwn(maker.website)) {
      ownCount += 1;
      continue;
    }

    const intake = await intakeSocialPeople(
      { db, ...(deps.now ? { now: deps.now } : {}) },
      {
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        people: [maker.person],
        source: 'launch-radar',
      },
    );
    const person = intake.people[0];
    if (!person) continue;
    people += 1;
    if (person.created) created += 1;

    if (maker.email) {
      await addIdentity(db, person.id, 'email', maker.email, null, PROFILE_EMAIL_CONFIDENCE, stamp);
      withEmail += 1;
    }
    const site = maker.website ? hostOf(maker.website) : undefined;
    if (site && maker.website)
      await addIdentity(db, person.id, 'website', site, maker.website, WEBSITE_CONFIDENCE, stamp);

    await db.execute({
      sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, subtype, summary, evidence,
                                 source_url, source_timestamp, observed_at, confidence, relevance, sentiment)
            VALUES (?, ?, ?, ?, 'launch', ?, ?, ?, ?, ?, ?, ?, ?, 'positive')`,
      args: [
        newId('signal'),
        input.workspaceId,
        person.id,
        person.network,
        `launch_${post.container === 'dev.to' ? 'devto' : post.network}`,
        `Launched: ${(post.title ?? post.text).slice(0, 160)} (${post.container ?? post.network})`,
        post.text.slice(0, 2000),
        post.url,
        post.postedAt,
        stamp,
        LAUNCH_SIGNAL_CONFIDENCE,
        LAUNCH_SIGNAL_RELEVANCE,
      ],
    });
  }

  return {
    launches: input.posts.length,
    known,
    own: ownCount,
    people,
    created,
    withEmail,
    handleOnly,
  };
}

async function addIdentity(
  db: Client,
  personId: string,
  network: Network,
  handle: string,
  profileUrl: string | null,
  confidence: number,
  stamp: string,
): Promise<void> {
  const exists = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM social_identities WHERE person_id = ? AND network = ? AND lower(handle) = ?`,
    [personId, network, handle.toLowerCase()],
  );
  if (exists) return;
  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id, profile_url,
                                         confidence, source_type, verified_by, first_seen_at, last_verified_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?, 'public_web', ?, ?, ?)`,
    args: [
      newId('socialIdentity'),
      personId,
      network,
      handle,
      profileUrl,
      confidence,
      JSON.stringify(['launch-profile']),
      stamp,
      stamp,
    ],
  });
}
