/**
 * Buyer leads: public communities searched for one brand, posts scored for
 * buyer intent, a quoted excerpt and a link for each, a reply drafted on
 * request, and a daily digest of the new ones.
 *
 *   monitor  a brand (optionally one of the workspace's products) with its
 *            keywords, the subreddits to read and the sources to search.
 *            Created from a name and a URL alone: the model suggests the rest.
 *   scan     each source is searched for the keywords since the last scan.
 *            Reddit blocks servers, so subreddits are read from the Arctic
 *            Shift archive; Hacker News through Algolia; Bluesky's AppView.
 *            Every matched post is stored once, scored or not, so nothing is
 *            scored twice and the same thread never reaches a digest again.
 *   score    the model scores intent 0-100 with a reason. Without one, the
 *            wording classifier does, and the lead says it was not judged.
 *   reply    drafted for a human to post. The product never posts to a
 *            community: the capability matrix forbids Reddit DMs and comment
 *            automation, and a brand found spamming threads loses the channel.
 *   digest   once a UTC day, after the workspace's digest hour, the new leads
 *            above each monitor's floor, to the workspace's notify address.
 */

import {
  draftLeadReply,
  judgeLeads,
  suggestMonitor,
  type LeadBrand,
  type LeadJudgement,
  type TextModel,
} from '@outreachgraph/ai';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { newId, type SignalType } from '@outreachgraph/domain';
import { communityLeadDigestEmail, type Mailer } from '@outreachgraph/email';
import {
  BlueskyFeedSource,
  classifyPost,
  FeedRateLimitError,
  HackerNewsSource,
  RedditSource,
  WebDiscussionSource,
  type WebSearcher,
  type FeedPost,
  type FeedSource,
} from '@outreachgraph/providers';
import { loadNotifySettings, notifyAddress } from './notify';

export const LEAD_SOURCES = ['reddit', 'hackernews', 'bluesky', 'web'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_STATUSES = ['new', 'replied', 'dismissed'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Least time between two scheduled scans of one monitor: the polling throttle. */
export const MIN_SCAN_MINUTES = 60;
const MAX_SCAN_MINUTES = 10_080;
/** How far back the first scan looks, and the most any scan looks back. */
const FIRST_WINDOW_DAYS = 7;
/** Overlap with the previous scan, for posts indexed late. */
const OVERLAP_MS = 2 * 3_600_000;
/** Posts the model scores per scan; the rest get the wording classifier. */
const JUDGE_LIMIT = 60;
const JUDGE_BATCH = 10;
/** Leads per digest. */
const DIGEST_LIMIT = 15;
const DAY_MS = 86_400_000;

/**
 * The wording classifier's guess at intent, when there is no model. Only a
 * request for recommendations clears the default floor of 60 on wording
 * alone: "demo" or "evaluating" in a post is as often a game demo as a buyer.
 */
const PATTERN_INTENT: Partial<Record<SignalType, number>> = {
  recommendation_request: 70,
  competitor_mention: 60,
  purchase_intent: 55,
  public_complaint: 50,
  pain: 50,
  public_question: 35,
  content_topic: 15,
  hiring: 5,
};

/**
 * Where an unjudged post sits while it waits for the model: below any sensible
 * floor, so a wording guess never reaches the digest when a model is there to
 * be asked. The next scan judges the backlog first.
 */
const PENDING_INTENT_CAP = 45;
/** Least time between two web (ValueSERP) searches for one monitor. */
const WEB_EVERY_MS = 20 * 3_600_000;
/** How far back the backlog of unjudged posts is still worth judging. */
const BACKLOG_DAYS = 7;

export function patternIntent(text: string): number {
  return PATTERN_INTENT[classifyPost(text).type] ?? 15;
}

/**
 * Picks what the model judges this scan: best wording first within each
 * source, then round-robin across sources, so one chatty source (Bluesky)
 * cannot spend the whole budget while Reddit's few real asks wait.
 */
export function judgeOrder<T extends { source: string; pattern: number; postedAt: string }>(
  rows: readonly T[],
  limit: number,
): T[] {
  const bySource = new Map<string, T[]>();
  for (const row of rows) {
    const queue = bySource.get(row.source) ?? [];
    queue.push(row);
    bySource.set(row.source, queue);
  }
  for (const queue of bySource.values()) {
    queue.sort((a, b) => b.pattern - a.pattern || Date.parse(b.postedAt) - Date.parse(a.postedAt));
  }
  const out: T[] = [];
  const queues = [...bySource.values()];
  while (out.length < limit && queues.some((q) => q.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) out.push(next);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- types -- */

export interface LeadMonitor {
  readonly id: string;
  readonly workspaceId: string;
  readonly offeringId?: string | undefined;
  readonly name: string;
  readonly url?: string | undefined;
  readonly description?: string | undefined;
  readonly keywords: readonly string[];
  readonly subreddits: readonly string[];
  readonly exclude: readonly string[];
  readonly sources: readonly LeadSource[];
  readonly enabled: boolean;
  readonly everyMinutes: number;
  readonly minIntent: number;
  readonly digest: boolean;
  readonly lastScannedAt?: string | undefined;
  readonly lastError?: string | undefined;
  readonly lastResult?: LeadScanResult | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CommunityLead {
  readonly id: string;
  readonly monitorId: string;
  readonly monitorName: string;
  /** Where the post lives: 'reddit' | 'hackernews' | 'bluesky' | 'website'. */
  readonly source: string;
  readonly externalId: string;
  readonly url: string;
  readonly title?: string | undefined;
  readonly excerpt: string;
  readonly author: string;
  readonly authorUrl?: string | undefined;
  readonly container?: string | undefined;
  readonly postedAt: string;
  readonly matchedTerm?: string | undefined;
  readonly intent: number;
  readonly reason?: string | undefined;
  readonly judged: boolean;
  readonly status: LeadStatus;
  readonly replyDraft?: string | undefined;
  readonly replyDraftedAt?: string | undefined;
  readonly digestedAt?: string | undefined;
  readonly createdAt: string;
}

export interface LeadScanResult {
  readonly monitorId: string;
  /** Posts the sources returned. */
  readonly read: number;
  /** Posts not seen before, now stored. */
  readonly stored: number;
  /** Of those, how many the model scored. */
  readonly judged: number;
  /** Of those, how many are at or above the monitor's floor. */
  readonly leads: number;
  readonly bySource: Readonly<Record<string, number>>;
  readonly failures: readonly { readonly source: string; readonly reason: string }[];
  readonly at: string;
  /** When the web search (ValueSERP) last ran for this monitor; it runs at most daily. */
  readonly webAt?: string | undefined;
}

interface MonitorRow {
  id: string;
  workspace_id: string;
  offering_id: string | null;
  name: string;
  url: string | null;
  description: string | null;
  keywords_json: string;
  subreddits_json: string;
  exclude_json: string;
  sources_json: string;
  enabled: number;
  every_minutes: number;
  min_intent: number;
  digest: number;
  last_scanned_at: string | null;
  last_error: string | null;
  last_result_json: string | null;
  created_at: string;
  updated_at: string;
}

interface LeadRow {
  id: string;
  monitor_id: string;
  monitor_name: string;
  source: string;
  external_id: string;
  url: string;
  title: string | null;
  excerpt: string;
  author: string;
  author_url: string | null;
  container: string | null;
  posted_at: string;
  matched_term: string | null;
  intent: number;
  reason: string | null;
  judged: number;
  status: string;
  reply_draft: string | null;
  reply_drafted_at: string | null;
  digested_at: string | null;
  created_at: string;
}

const parse = <T>(json: string | null | undefined, fallback: T): T => {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
};

function toMonitor(row: MonitorRow): LeadMonitor {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.offering_id ? { offeringId: row.offering_id } : {}),
    name: row.name,
    ...(row.url ? { url: row.url } : {}),
    ...(row.description ? { description: row.description } : {}),
    keywords: parse<string[]>(row.keywords_json, []),
    subreddits: parse<string[]>(row.subreddits_json, []),
    exclude: parse<string[]>(row.exclude_json, []),
    sources: cleanSources(parse<string[]>(row.sources_json, [...LEAD_SOURCES])),
    enabled: Number(row.enabled) === 1,
    everyMinutes: Number(row.every_minutes),
    minIntent: Number(row.min_intent),
    digest: Number(row.digest) === 1,
    ...(row.last_scanned_at ? { lastScannedAt: row.last_scanned_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.last_result_json
      ? { lastResult: parse<LeadScanResult | undefined>(row.last_result_json, undefined) }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLead(row: LeadRow): CommunityLead {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    monitorName: row.monitor_name,
    source: row.source,
    externalId: row.external_id,
    url: row.url,
    ...(row.title ? { title: row.title } : {}),
    excerpt: row.excerpt,
    author: row.author,
    ...(row.author_url ? { authorUrl: row.author_url } : {}),
    ...(row.container ? { container: row.container } : {}),
    postedAt: row.posted_at,
    ...(row.matched_term ? { matchedTerm: row.matched_term } : {}),
    intent: Number(row.intent),
    ...(row.reason ? { reason: row.reason } : {}),
    judged: Number(row.judged) === 1,
    status: row.status as LeadStatus,
    ...(row.reply_draft ? { replyDraft: row.reply_draft } : {}),
    ...(row.reply_drafted_at ? { replyDraftedAt: row.reply_drafted_at } : {}),
    ...(row.digested_at ? { digestedAt: row.digested_at } : {}),
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------- cleaning -- */

export const cleanSources = (sources: readonly string[]): LeadSource[] => [
  ...new Set(
    sources
      .map((s) => s.trim().toLowerCase())
      .map((s) => (s === 'hn' ? 'hackernews' : s))
      .filter((s): s is LeadSource => (LEAD_SOURCES as readonly string[]).includes(s)),
  ),
];

export const cleanKeywords = (keywords: readonly string[]): string[] =>
  [
    ...new Set(
      keywords
        .map((k) => k.replace(/\s+/g, ' ').trim().toLowerCase())
        .filter((k) => k.length >= 2 && k.length <= 60),
    ),
  ].slice(0, 25);

export const cleanSubreddits = (subs: readonly string[]): string[] =>
  [
    ...new Set(
      subs
        .map((s) => s.trim().replace(/^\/?r\//i, ''))
        .filter((s) => /^[A-Za-z0-9_]{2,21}$/.test(s)),
    ),
  ].slice(0, 25);

const clampMinutes = (n: number) =>
  Math.min(Math.max(Math.round(n), MIN_SCAN_MINUTES), MAX_SCAN_MINUTES);
const clampIntent = (n: number) => Math.min(Math.max(Math.round(n), 0), 100);

/* ------------------------------------------------------------- monitors -- */

export interface MonitorInput {
  readonly name?: string | undefined;
  readonly url?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly offeringId?: string | null | undefined;
  readonly keywords?: readonly string[] | undefined;
  readonly subreddits?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly sources?: readonly string[] | undefined;
  readonly enabled?: boolean | undefined;
  readonly everyMinutes?: number | undefined;
  readonly minIntent?: number | undefined;
  readonly digest?: boolean | undefined;
}

export class MonitorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MonitorInputError';
  }
}

export async function listLeadMonitors(db: Client, workspaceId: string): Promise<LeadMonitor[]> {
  const rows = await queryAll<MonitorRow>(
    db,
    'SELECT * FROM lead_monitors WHERE workspace_id = ? ORDER BY created_at ASC',
    [workspaceId],
  );
  return rows.map(toMonitor);
}

export async function getLeadMonitor(
  db: Client,
  workspaceId: string,
  id: string,
): Promise<LeadMonitor | undefined> {
  const row = await queryOne<MonitorRow>(
    db,
    'SELECT * FROM lead_monitors WHERE workspace_id = ? AND id = ?',
    [workspaceId, id],
  );
  return row ? toMonitor(row) : undefined;
}

/**
 * Creates a monitor. A name is the only requirement: a product id fills the
 * URL and description from the product, and the model suggests keywords and
 * subreddits when none were given. Without a model and without keywords, the
 * brand name and host are the keywords, which still finds mentions.
 */
export async function createLeadMonitor(
  deps: { readonly db: Client; readonly model?: TextModel | undefined },
  workspaceId: string,
  input: MonitorInput,
): Promise<LeadMonitor> {
  const { db } = deps;
  let name = input.name?.trim() ?? '';
  let url = input.url?.trim() || undefined;
  let description = input.description?.trim() || undefined;
  let offeringId: string | undefined;

  if (input.offeringId) {
    const offering = await queryOne<{
      id: string;
      name: string;
      url: string | null;
      description: string | null;
    }>(db, 'SELECT id, name, url, description FROM offerings WHERE workspace_id = ? AND id = ?', [
      workspaceId,
      input.offeringId,
    ]);
    if (!offering) throw new MonitorInputError('no such product in this workspace');
    offeringId = offering.id;
    name ||= offering.name;
    url ??= offering.url ?? undefined;
    description ??= offering.description ?? undefined;
  }

  if (!name && url) name = hostOf(url) ?? '';
  if (!name) throw new MonitorInputError('a monitor needs a name, a URL or a product');

  let keywords = cleanKeywords(input.keywords ?? []);
  let subreddits = cleanSubreddits(input.subreddits ?? []);

  if ((keywords.length === 0 || (subreddits.length === 0 && !input.subreddits)) && deps.model) {
    try {
      const suggestion = await suggestMonitor(deps.model, { name, url, description });
      if (suggestion) {
        if (keywords.length === 0) keywords = cleanKeywords(suggestion.keywords);
        if (subreddits.length === 0 && !input.subreddits)
          subreddits = cleanSubreddits(suggestion.subreddits);
      }
    } catch (error) {
      console.log(`lead monitor: suggestion failed for ${name}: ${(error as Error).message}`);
    }
  }

  if (keywords.length === 0) {
    keywords = cleanKeywords([name, ...(url && hostOf(url) ? [hostOf(url)!] : [])]);
  }

  const sources = input.sources ? cleanSources(input.sources) : [...LEAD_SOURCES];
  if (sources.length === 0)
    throw new MonitorInputError(`sources must be some of ${LEAD_SOURCES.join(', ')}`);

  const id = newId('leadMonitor');
  const at = now();
  await db.execute({
    sql: `INSERT INTO lead_monitors (id, workspace_id, offering_id, name, url, description, keywords_json,
            subreddits_json, exclude_json, sources_json, enabled, every_minutes, min_intent, digest,
            created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      workspaceId,
      offeringId ?? null,
      name.slice(0, 120),
      url ?? null,
      description?.slice(0, 2000) ?? null,
      JSON.stringify(keywords),
      JSON.stringify(subreddits),
      JSON.stringify(cleanKeywords(input.exclude ?? [])),
      JSON.stringify(sources),
      input.enabled === false ? 0 : 1,
      clampMinutes(input.everyMinutes ?? 360),
      clampIntent(input.minIntent ?? 60),
      input.digest === false ? 0 : 1,
      at,
      at,
    ],
  });
  return (await getLeadMonitor(db, workspaceId, id))!;
}

export async function updateLeadMonitor(
  db: Client,
  workspaceId: string,
  id: string,
  patch: MonitorInput,
): Promise<LeadMonitor | undefined> {
  const cur = await getLeadMonitor(db, workspaceId, id);
  if (!cur) return undefined;
  const sources = patch.sources ? cleanSources(patch.sources) : cur.sources;
  if (sources.length === 0)
    throw new MonitorInputError(`sources must be some of ${LEAD_SOURCES.join(', ')}`);
  const keywords = patch.keywords ? cleanKeywords(patch.keywords) : cur.keywords;
  if (keywords.length === 0) throw new MonitorInputError('a monitor needs at least one keyword');

  await db.execute({
    sql: `UPDATE lead_monitors SET name = ?, url = ?, description = ?, keywords_json = ?, subreddits_json = ?,
            exclude_json = ?, sources_json = ?, enabled = ?, every_minutes = ?, min_intent = ?, digest = ?,
            updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
    args: [
      (patch.name?.trim() || cur.name).slice(0, 120),
      patch.url === undefined ? (cur.url ?? null) : patch.url?.trim() || null,
      patch.description === undefined
        ? (cur.description ?? null)
        : patch.description?.trim().slice(0, 2000) || null,
      JSON.stringify(keywords),
      JSON.stringify(patch.subreddits ? cleanSubreddits(patch.subreddits) : cur.subreddits),
      JSON.stringify(patch.exclude ? cleanKeywords(patch.exclude) : cur.exclude),
      JSON.stringify(sources),
      (patch.enabled ?? cur.enabled) ? 1 : 0,
      clampMinutes(patch.everyMinutes ?? cur.everyMinutes),
      clampIntent(patch.minIntent ?? cur.minIntent),
      (patch.digest ?? cur.digest) ? 1 : 0,
      now(),
      workspaceId,
      id,
    ],
  });
  return getLeadMonitor(db, workspaceId, id);
}

export async function deleteLeadMonitor(
  db: Client,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  // Leads first: the foreign key cascades on Postgres, but not on a SQLite
  // file opened without foreign_keys.
  await db.execute({
    sql: 'DELETE FROM community_leads WHERE workspace_id = ? AND monitor_id = ?',
    args: [workspaceId, id],
  });
  const result = await db.execute({
    sql: 'DELETE FROM lead_monitors WHERE workspace_id = ? AND id = ?',
    args: [workspaceId, id],
  });
  return result.rowsAffected > 0;
}

/** Enabled monitors whose last scan is older than their interval. */
export async function monitorsDueForScan(
  db: Client,
  at = new Date(),
): Promise<{ workspaceId: string; monitorId: string }[]> {
  const rows = await queryAll<{
    id: string;
    workspace_id: string;
    every_minutes: number;
    last_scanned_at: string | null;
  }>(
    db,
    'SELECT id, workspace_id, every_minutes, last_scanned_at FROM lead_monitors WHERE enabled = 1 ORDER BY last_scanned_at ASC',
    [],
  );
  return rows
    .filter(
      (r) =>
        !r.last_scanned_at ||
        at.getTime() - Date.parse(r.last_scanned_at) >=
          Math.max(Number(r.every_minutes), MIN_SCAN_MINUTES) * 60_000,
    )
    .map((r) => ({ workspaceId: r.workspace_id, monitorId: r.id }));
}

/* ----------------------------------------------------------------- scan -- */

export interface LeadSourceOptions {
  /** Test seam: every source fetches through this. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Pacing for the Reddit archive; it answers 422 to anything faster than ~2s. */
  readonly archiveGapMs?: number | undefined;
  readonly hnGapMs?: number | undefined;
  /** Google search (ValueSERP) for the `web` source; without it `web` reads nothing. */
  readonly searcher?: WebSearcher | undefined;
}

/**
 * The sources a monitor reads. Reddit only with subreddits: the archive cannot
 * search all of Reddit, and reddit.com itself refuses servers.
 */
export function buildLeadSources(
  monitor: Pick<LeadMonitor, 'sources' | 'subreddits'>,
  options: LeadSourceOptions = {},
): FeedSource[] {
  const fetchImpl = options.fetchImpl;
  const sources: FeedSource[] = [];
  for (const source of monitor.sources) {
    if (source === 'reddit' && monitor.subreddits.length > 0) {
      sources.push(
        new RedditSource({
          subreddits: monitor.subreddits,
          archiveFirst: true,
          // A busy subreddit posts more than a hundred a day; five pages
          // cover a week of most of them.
          archivePages: 5,
          archiveGapMs: options.archiveGapMs ?? 2_500,
          timeoutMs: 30_000,
          ...(fetchImpl ? { fetchImpl } : {}),
        }),
      );
    }
    if (source === 'hackernews') {
      sources.push(
        new HackerNewsSource({
          ...(options.hnGapMs !== undefined ? { gapMs: options.hnGapMs } : {}),
          ...(fetchImpl ? { fetchImpl } : {}),
        }),
      );
    }
    if (source === 'web' && options.searcher) {
      sources.push(
        new WebDiscussionSource({
          searcher: options.searcher,
          ...(fetchImpl ? { fetchImpl } : {}),
        }),
      );
    }
    if (source === 'bluesky') {
      // public.api.bsky.app answers searchPosts with 403 to anonymous callers;
      // the AppView itself still serves it.
      sources.push(
        new BlueskyFeedSource({
          baseUrl: 'https://api.bsky.app',
          ...(fetchImpl ? { fetchImpl } : {}),
        }),
      );
    }
  }
  return sources;
}

export interface LeadScanDeps {
  readonly db: Client;
  readonly model?: TextModel | undefined;
  /** Builds the sources for a monitor. Defaults to {@link buildLeadSources}. */
  readonly sources?: ((monitor: LeadMonitor) => readonly FeedSource[]) | undefined;
  /** Google search for the default `web` source. */
  readonly searcher?: WebSearcher | undefined;
  readonly now?: Date | undefined;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(
      /^www\./,
      '',
    );
  } catch {
    return undefined;
  }
}

function brandOf(monitor: LeadMonitor): LeadBrand {
  return { name: monitor.name, url: monitor.url, description: monitor.description };
}

/**
 * True when the keyword appears as whole words. Sources match substrings, so
 * "siem" alone would match inside unrelated words in other languages.
 */
export function containsKeyword(text: string, keyword: string): boolean {
  const escaped = keyword
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  if (!escaped) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

/** The first keyword a post contains as whole words. */
function matchedTerm(post: FeedPost, keywords: readonly string[]): string | undefined {
  const hay = `${post.title ?? ''}\n${post.text}`;
  return keywords.find((k) => containsKeyword(hay, k));
}

function excluded(post: FeedPost, exclude: readonly string[]): boolean {
  if (exclude.length === 0) return false;
  const hay = `${post.title ?? ''}\n${post.text}\n${post.authorHandle}`.toLowerCase();
  return exclude.some((word) => hay.includes(word.toLowerCase()));
}

export async function scanLeadMonitor(
  deps: LeadScanDeps,
  workspaceId: string,
  monitorId: string,
): Promise<LeadScanResult> {
  const { db } = deps;
  const monitor = await getLeadMonitor(db, workspaceId, monitorId);
  if (!monitor) throw new MonitorInputError('no such monitor');

  const at = deps.now ?? new Date();
  const earliest = at.getTime() - FIRST_WINDOW_DAYS * DAY_MS;
  const since = new Date(
    monitor.lastScannedAt
      ? Math.max(Date.parse(monitor.lastScannedAt) - OVERLAP_MS, earliest)
      : earliest,
  );

  // The web search is paid per query, so it runs once a day however often the
  // monitor scans; the free sources run every time.
  const lastWeb = monitor.lastResult?.webAt ? Date.parse(monitor.lastResult.webAt) : 0;
  const webDue = at.getTime() - lastWeb >= WEB_EVERY_MS;
  const sources = (
    deps.sources ?? ((m) => buildLeadSources(m, deps.searcher ? { searcher: deps.searcher } : {}))
  )(monitor).filter((source) => webDue || source.slug !== 'web');
  const webRan = sources.some((source) => source.slug === 'web');
  const bySource: Record<string, number> = {};
  const failures: { source: string; reason: string }[] = [];
  const fresh: { post: FeedPost; term: string | undefined }[] = [];
  const seenNow = new Set<string>();
  let read = 0;

  for (const source of sources) {
    let posts: readonly FeedPost[];
    try {
      // The web search runs daily, so its window starts at its own last run,
      // not at the last scan of the free sources a few hours ago.
      const sourceSince =
        source.slug === 'web'
          ? new Date(lastWeb ? Math.max(lastWeb - OVERLAP_MS, earliest) : earliest)
          : since;
      posts = await source.search({ terms: monitor.keywords, since: sourceSince, limit: 100 });
    } catch (error) {
      failures.push({
        source: source.slug,
        reason:
          error instanceof FeedRateLimitError
            ? 'rate limited'
            : error instanceof Error
              ? error.message
              : String(error),
      });
      continue;
    }
    read += posts.length;
    bySource[source.slug] = posts.length;

    for (const post of posts) {
      const key = `${post.network}:${post.externalId}`;
      if (seenNow.has(key)) continue;
      seenNow.add(key);
      if (excluded(post, monitor.exclude)) continue;
      const known = await queryOne<{ id: string }>(
        db,
        'SELECT id FROM community_leads WHERE monitor_id = ? AND source = ? AND external_id = ?',
        [monitor.id, post.network, post.externalId],
      );
      if (known) continue;
      const term = matchedTerm(post, monitor.keywords);
      if (!term) continue;
      fresh.push({ post, term });
    }
  }

  const createdAt = at.toISOString();
  let leads = 0;

  // Every new post is stored first. With a model, its wording guess is capped
  // below the floor until the model has looked at it; without one, the guess
  // is the score.
  for (const { post, term } of fresh) {
    const guess = patternIntent(post.text);
    const intent = deps.model ? Math.min(guess, PENDING_INTENT_CAP) : guess;
    if (!deps.model && intent >= monitor.minIntent) leads += 1;
    await db.execute({
      sql: `INSERT INTO community_leads (id, workspace_id, monitor_id, source, external_id, url, title, excerpt,
              author, author_url, container, posted_at, matched_term, intent, reason, judged, status,
              created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'new', ?, ?)
            ON CONFLICT (monitor_id, source, external_id) DO NOTHING`,
      args: [
        newId('communityLead'),
        workspaceId,
        monitor.id,
        post.network,
        post.externalId,
        post.url,
        post.title?.slice(0, 300) ?? null,
        post.text.slice(0, 1200),
        post.authorHandle,
        post.authorUrl ?? null,
        post.container ?? null,
        post.postedAt,
        term ?? null,
        intent,
        createdAt,
        createdAt,
      ],
    });
  }

  // Then the model judges the backlog: this scan's posts and any earlier ones
  // a previous scan had no budget (or no working model) for.
  let judged = 0;
  if (deps.model) {
    const backlog = await queryAll<{
      id: string;
      source: string;
      title: string | null;
      excerpt: string;
      posted_at: string;
    }>(
      db,
      `SELECT id, source, title, excerpt, posted_at FROM community_leads
        WHERE monitor_id = ? AND judged = 0 AND posted_at >= ?
        ORDER BY posted_at DESC LIMIT 1000`,
      [monitor.id, new Date(at.getTime() - BACKLOG_DAYS * DAY_MS).toISOString()],
    );
    const chosen = judgeOrder(
      backlog.map((row) => ({
        ...row,
        postedAt: row.posted_at,
        pattern: patternIntent(`${row.title ?? ''}\n${row.excerpt}`),
      })),
      JUDGE_LIMIT,
    );
    for (let i = 0; i < chosen.length; i += JUDGE_BATCH) {
      const batch = chosen.slice(i, i + JUDGE_BATCH);
      let verdicts: LeadJudgement[];
      try {
        verdicts = await judgeLeads(
          deps.model,
          brandOf(monitor),
          batch.map((row, j) => ({
            id: String(j),
            source: row.source,
            title: row.title ?? undefined,
            text: row.excerpt,
          })),
        );
      } catch (error) {
        failures.push({ source: 'judge', reason: (error as Error).message });
        break;
      }
      for (const verdict of verdicts) {
        const row = batch[Number(verdict.id)];
        if (!row) continue;
        await db.execute({
          sql: `UPDATE community_leads SET intent = ?, reason = ?, judged = 1, updated_at = ?
                WHERE id = ? AND judged = 0`,
          args: [verdict.intent, verdict.reason || null, createdAt, row.id],
        });
        judged += 1;
        if (verdict.intent >= monitor.minIntent) leads += 1;
      }
    }
  }

  const result: LeadScanResult = {
    monitorId: monitor.id,
    read,
    stored: fresh.length,
    judged,
    leads,
    bySource,
    failures,
    at: createdAt,
    ...(webRan && !failures.some((f) => f.source === 'web')
      ? { webAt: createdAt }
      : monitor.lastResult?.webAt
        ? { webAt: monitor.lastResult.webAt }
        : {}),
  };
  const allFailed = sources.length > 0 && failures.length >= sources.length;
  await db.execute({
    sql: `UPDATE lead_monitors SET last_scanned_at = ?, last_error = ?, last_result_json = ?, updated_at = ?
          WHERE id = ?`,
    args: [
      createdAt,
      allFailed ? failures.map((f) => `${f.source}: ${f.reason}`).join('; ') : null,
      JSON.stringify(result),
      createdAt,
      monitor.id,
    ],
  });
  return result;
}

/* ---------------------------------------------------------------- leads -- */

export interface LeadQuery {
  readonly monitorId?: string | undefined;
  readonly status?: LeadStatus | undefined;
  /** Floor on intent. Defaults to each monitor's own floor. */
  readonly minIntent?: number | undefined;
  readonly limit?: number | undefined;
}

export async function listCommunityLeads(
  db: Client,
  workspaceId: string,
  query: LeadQuery = {},
): Promise<CommunityLead[]> {
  const where = ['l.workspace_id = ?'];
  const args: (string | number)[] = [workspaceId];
  if (query.monitorId) {
    where.push('l.monitor_id = ?');
    args.push(query.monitorId);
  }
  if (query.status) {
    where.push('l.status = ?');
    args.push(query.status);
  } else {
    where.push("l.status <> 'dismissed'");
  }
  if (query.minIntent !== undefined) {
    where.push('l.intent >= ?');
    args.push(clampIntent(query.minIntent));
  } else {
    where.push('l.intent >= m.min_intent');
  }
  args.push(Math.min(Math.max(query.limit ?? 100, 1), 500));
  const rows = await queryAll<LeadRow>(
    db,
    `SELECT l.*, m.name AS monitor_name
       FROM community_leads l JOIN lead_monitors m ON m.id = l.monitor_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.posted_at DESC, l.intent DESC
      LIMIT ?`,
    args,
  );
  return rows.map(toLead);
}

export async function getCommunityLead(
  db: Client,
  workspaceId: string,
  id: string,
): Promise<CommunityLead | undefined> {
  const row = await queryOne<LeadRow>(
    db,
    `SELECT l.*, m.name AS monitor_name
       FROM community_leads l JOIN lead_monitors m ON m.id = l.monitor_id
      WHERE l.workspace_id = ? AND l.id = ?`,
    [workspaceId, id],
  );
  return row ? toLead(row) : undefined;
}

export async function updateCommunityLead(
  db: Client,
  workspaceId: string,
  id: string,
  patch: {
    readonly status?: LeadStatus | undefined;
    readonly replyDraft?: string | null | undefined;
  },
): Promise<CommunityLead | undefined> {
  const cur = await getCommunityLead(db, workspaceId, id);
  if (!cur) return undefined;
  const at = now();
  await db.execute({
    sql: `UPDATE community_leads SET status = ?, reply_draft = ?, reply_drafted_at = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
    args: [
      patch.status ?? cur.status,
      patch.replyDraft === undefined
        ? (cur.replyDraft ?? null)
        : patch.replyDraft?.slice(0, 4000) || null,
      patch.replyDraft === undefined ? (cur.replyDraftedAt ?? null) : at,
      at,
      workspaceId,
      id,
    ],
  });
  return getCommunityLead(db, workspaceId, id);
}

export class NoModelError extends Error {
  constructor() {
    super('no model is configured on this server, so replies cannot be drafted');
    this.name = 'NoModelError';
  }
}

/**
 * Drafts a reply for a lead and stores it. Never posts it: the reply is for a
 * human to read, edit and post in their own name.
 */
export async function draftCommunityLeadReply(
  deps: { readonly db: Client; readonly model?: TextModel | undefined },
  workspaceId: string,
  id: string,
): Promise<CommunityLead | undefined> {
  if (!deps.model) throw new NoModelError();
  const lead = await getCommunityLead(deps.db, workspaceId, id);
  if (!lead) return undefined;
  const monitor = await getLeadMonitor(deps.db, workspaceId, lead.monitorId);
  if (!monitor) return undefined;
  const draft = await draftLeadReply(deps.model, brandOf(monitor), {
    source: lead.source,
    container: lead.container,
    title: lead.title,
    text: lead.excerpt,
  });
  if (!draft) throw new Error('the model declined to draft a reply for this post');
  return updateCommunityLead(deps.db, workspaceId, id, { replyDraft: draft });
}

/* --------------------------------------------------------------- digest -- */

export interface LeadDigestDeps {
  readonly db: Client;
  readonly mailer?: Mailer | undefined;
  readonly appUrl: string;
  readonly now?: Date | undefined;
}

/** Workspaces with at least one monitor that mails a digest. */
export async function workspacesWithLeadDigests(db: Client): Promise<string[]> {
  const rows = await queryAll<{ workspace_id: string }>(
    db,
    'SELECT DISTINCT workspace_id FROM lead_monitors WHERE enabled = 1 AND digest = 1',
    [],
  );
  return rows.map((r) => r.workspace_id);
}

/**
 * Sends the day's buyer-lead digest, once per UTC day, after the workspace's
 * digest hour, and only when there is something in it: unlike the activity
 * digest, an empty lead digest tells the reader nothing the next full one
 * will not. Returns how many leads it carried (0: not sent).
 */
export async function sendCommunityLeadDigest(
  deps: LeadDigestDeps,
  workspaceId: string,
): Promise<number> {
  const at = deps.now ?? new Date();
  const settings = await loadNotifySettings(deps.db, workspaceId);
  if (at.getUTCHours() < settings.digest_hour_utc) return 0;
  const today = at.toISOString().slice(0, 10);

  const rows = await queryAll<LeadRow>(
    deps.db,
    `SELECT l.*, m.name AS monitor_name
       FROM community_leads l JOIN lead_monitors m ON m.id = l.monitor_id
      WHERE l.workspace_id = ? AND m.enabled = 1 AND m.digest = 1
        AND l.digested_at IS NULL AND l.status = 'new'
        AND l.intent >= m.min_intent AND l.posted_at >= ?
      ORDER BY l.intent DESC, l.posted_at DESC
      LIMIT ?`,
    [workspaceId, new Date(at.getTime() - 3 * DAY_MS).toISOString(), DIGEST_LIMIT],
  );
  if (rows.length === 0) return 0;
  if (!deps.mailer) return 0;

  const to = await notifyAddress(deps.db, workspaceId, settings);
  if (!to) return 0;

  // The insert is the lock: one digest per workspace per day.
  const claimed = await deps.db.execute({
    sql: `INSERT INTO notifications (id, workspace_id, kind, subject_key, to_email, sent_at)
          VALUES (?, ?, 'community_leads_digest', ?, ?, ?)
          ON CONFLICT(workspace_id, kind, subject_key) DO NOTHING`,
    args: [newId('notification'), workspaceId, today, to, now()],
  });
  if (claimed.rowsAffected === 0) return 0;

  const leads = rows.map(toLead);
  const brands = [...new Set(leads.map((l) => l.monitorName))];
  try {
    await deps.mailer.send(
      communityLeadDigestEmail(
        to,
        {
          date: today,
          brands,
          leads: leads.map((l) => ({
            id: l.id,
            source: l.source,
            container: l.container,
            title: l.title,
            excerpt: l.excerpt,
            url: l.url,
            intent: l.intent,
            reason: l.reason,
          })),
        },
        deps.appUrl,
      ),
    );
  } catch (error) {
    await deps.db.execute({
      sql: `DELETE FROM notifications WHERE workspace_id = ? AND kind = 'community_leads_digest' AND subject_key = ?`,
      args: [workspaceId, today],
    });
    throw error;
  }

  const stamp = now();
  for (const lead of leads) {
    await deps.db.execute({
      sql: 'UPDATE community_leads SET digested_at = ? WHERE id = ?',
      args: [stamp, lead.id],
    });
  }
  return leads.length;
}
