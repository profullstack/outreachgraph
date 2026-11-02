/**
 * The Content Radar: `/api/v1/content-radar/*` and the sweep that runs it.
 *
 * For every product, on its own, once a day:
 *
 *   discover  the best performing public posts of the last 30 days for the
 *             product's terms (Hacker News, Bluesky, dev.to, Mastodon) and its
 *             audience subreddits (Reddit, via the archive), plus everything
 *             the accounts it follows (competitors, creators) posted. Each is
 *             stored once as a reference with its likes, reposts and comments.
 *   hooks     the model names each reference's hook from a fixed list, says
 *             why it worked and how the product could use the structure. With
 *             no model, the wording names the hook and the reference says so.
 *   draft     up to RADAR_DRAFTS_PER_DAY references a workspace day, best
 *             first and products taking turns, become posts for every network
 *             on the radar (ordinary link-post cards: Bluesky, Mastodon and
 *             LinkedIn auto-post through myna, X and Reddit wait for a person),
 *             a short-video storyboard and a branded image card.
 *
 * A person can do any of it by hand as well: add a reference by URL, save it
 * to a collection, follow an account, create from a reference now.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  analyzeHooks,
  draftStudio,
  heuristicHook,
  HOOK_LABELS,
  HOOK_TYPES,
  isHookType,
  referenceDirection,
  renderImageCardSvg,
  suggestMonitor,
  type ImageCard,
  type RadarBrand,
  type Storyboard,
  type TextModel,
} from '@outreachgraph/ai';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { LINK_POST_NETWORKS, newId, type LinkPostNetwork } from '@outreachgraph/domain';
import {
  engagementScore,
  FOLLOW_NETWORKS,
  isFollowNetwork,
  isTopPostSource,
  tagFor,
  TOP_POST_SOURCES,
  TopPostReader,
  type FetchLike,
  type FollowNetwork,
  type HostLookup,
  type TopPost,
  type TopPostSource,
} from '@outreachgraph/providers';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import { readLinkPage, storeDraftedBatch, type ReadPage } from './link-posts';
import * as repo from './repository';
import type { Throttles } from './throttle';

/** Hours between two scheduled scans of one product. */
export const RADAR_SCAN_HOURS = 24;
/** References a workspace turns into posts on its own per UTC day. */
export const RADAR_DRAFTS_PER_DAY = 3;
/** Scans one sweep runs, so a workspace with 50 products is spread over ticks. */
const SCANS_PER_SWEEP = 4;
/** References the model reads per scan (10 a call). */
const HOOKS_PER_SCAN = 30;
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
/** `created_by` on link posts the radar drafted, so the daily cap can count them. */
export const RADAR_CREATED_BY = 'content_radar';

export const REFERENCE_STATUSES = ['new', 'saved', 'used', 'dismissed'] as const;
export type ReferenceStatus = (typeof REFERENCE_STATUSES)[number];
export const STUDIO_FORMATS = ['posts', 'storyboard', 'image'] as const;
export type StudioFormat = (typeof STUDIO_FORMATS)[number];

const DEFAULT_NETWORKS: LinkPostNetwork[] = ['linkedin', 'bluesky', 'mastodon', 'x', 'reddit'];

/* ------------------------------------------------------------------ rows */

interface RadarRow {
  workspace_id: string;
  offering_id: string;
  terms: string;
  subreddits: string;
  tags: string;
  sources: string;
  enabled: number;
  auto_draft: number;
  networks: string;
  last_scan_at: string | null;
  last_draft_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ReferenceRow {
  id: string;
  workspace_id: string;
  offering_id: string | null;
  source: string;
  external_id: string;
  url: string;
  author_handle: string | null;
  author_name: string | null;
  title: string | null;
  text: string;
  container: string | null;
  posted_at: string;
  likes: number;
  reposts: number;
  comments: number;
  engagement: number;
  origin: string;
  matched: string | null;
  hook_type: string | null;
  hook_why: string | null;
  hook_angle: string | null;
  hook_judged: number;
  relevant: number | null;
  status: string;
  collection: string | null;
  used_batch_id: string | null;
  created_at: string;
  updated_at: string;
}

interface FollowRow {
  id: string;
  workspace_id: string;
  offering_id: string | null;
  network: string;
  handle: string;
  label: string | null;
  kind: string;
  last_read_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface AssetRow {
  id: string;
  workspace_id: string;
  offering_id: string | null;
  reference_id: string | null;
  kind: string;
  title: string;
  body: string;
  link_batch_id: string | null;
  model: string | null;
  created_at: string;
}

interface OfferingRow {
  id: string;
  name: string;
  category: string | null;
  url: string | null;
  description: string | null;
  value_propositions: string | null;
  competitors: string | null;
}

/* ----------------------------------------------------------------- views */

function list(value: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.map((v) => String(v).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export interface RadarView {
  readonly offeringId: string;
  readonly name: string;
  readonly url?: string;
  readonly terms: string[];
  readonly subreddits: string[];
  readonly tags: string[];
  readonly sources: TopPostSource[];
  readonly networks: LinkPostNetwork[];
  readonly enabled: boolean;
  readonly autoDraft: boolean;
  readonly lastScanAt?: string;
  readonly lastDraftAt?: string;
  readonly lastError?: string;
  readonly references: number;
}

function radarView(row: RadarRow, offering: OfferingRow | undefined, references: number) {
  return {
    offeringId: row.offering_id,
    name: offering?.name ?? row.offering_id,
    ...(offering?.url ? { url: offering.url } : {}),
    terms: list(row.terms),
    subreddits: list(row.subreddits),
    tags: list(row.tags),
    sources: list(row.sources).filter(isTopPostSource),
    networks: list(row.networks).filter((n): n is LinkPostNetwork =>
      (LINK_POST_NETWORKS as readonly string[]).includes(n),
    ),
    enabled: Number(row.enabled) === 1,
    autoDraft: Number(row.auto_draft) === 1,
    ...(row.last_scan_at ? { lastScanAt: row.last_scan_at } : {}),
    ...(row.last_draft_at ? { lastDraftAt: row.last_draft_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    references,
  } satisfies RadarView;
}

export interface ReferenceView {
  readonly id: string;
  readonly offeringId?: string;
  readonly source: string;
  readonly url: string;
  readonly authorHandle?: string;
  readonly authorName?: string;
  readonly title?: string;
  readonly text: string;
  readonly container?: string;
  readonly postedAt: string;
  readonly likes: number;
  readonly reposts: number;
  readonly comments: number;
  readonly engagement: number;
  readonly origin: string;
  readonly matched?: string;
  readonly hook?: {
    readonly type: string;
    readonly label: string;
    readonly why?: string;
    readonly angle?: string;
    /** False when the wording guessed the hook, not the model. */
    readonly judged: boolean;
  };
  /** The model's call on whether the subject matters to the product's audience. */
  readonly relevant?: boolean;
  readonly status: ReferenceStatus;
  readonly collection?: string;
  readonly usedBatchId?: string;
  readonly createdAt: string;
}

export function referenceView(row: ReferenceRow): ReferenceView {
  const hookType = row.hook_type && isHookType(row.hook_type) ? row.hook_type : undefined;
  return {
    id: row.id,
    ...(row.offering_id ? { offeringId: row.offering_id } : {}),
    source: row.source,
    url: row.url,
    ...(row.author_handle ? { authorHandle: row.author_handle } : {}),
    ...(row.author_name ? { authorName: row.author_name } : {}),
    ...(row.title ? { title: row.title } : {}),
    text: row.text,
    ...(row.container ? { container: row.container } : {}),
    postedAt: row.posted_at,
    likes: Number(row.likes),
    reposts: Number(row.reposts),
    comments: Number(row.comments),
    engagement: Number(row.engagement),
    origin: row.origin,
    ...(row.matched ? { matched: row.matched } : {}),
    ...(hookType
      ? {
          hook: {
            type: hookType,
            label: HOOK_LABELS[hookType],
            ...(row.hook_why ? { why: row.hook_why } : {}),
            ...(row.hook_angle ? { angle: row.hook_angle } : {}),
            judged: Number(row.hook_judged) === 1,
          },
        }
      : {}),
    ...(row.relevant === null || row.relevant === undefined
      ? {}
      : { relevant: Number(row.relevant) === 1 }),
    status: row.status as ReferenceStatus,
    ...(row.collection ? { collection: row.collection } : {}),
    ...(row.used_batch_id ? { usedBatchId: row.used_batch_id } : {}),
    createdAt: row.created_at,
  };
}

function followView(row: FollowRow) {
  return {
    id: row.id,
    ...(row.offering_id ? { offeringId: row.offering_id } : {}),
    network: row.network,
    handle: row.handle,
    ...(row.label ? { label: row.label } : {}),
    kind: row.kind,
    ...(row.last_read_at ? { lastReadAt: row.last_read_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
  };
}

export type AssetView =
  | {
      readonly id: string;
      readonly kind: 'storyboard';
      readonly title: string;
      readonly storyboard: Storyboard;
      readonly offeringId?: string;
      readonly referenceId?: string;
      readonly linkBatchId?: string;
      readonly createdAt: string;
    }
  | {
      readonly id: string;
      readonly kind: 'image';
      readonly title: string;
      readonly image: ImageCard;
      /** Relative to `/api/v1`. */
      readonly imagePath: string;
      readonly offeringId?: string;
      readonly referenceId?: string;
      readonly linkBatchId?: string;
      readonly createdAt: string;
    };

function assetView(row: AssetRow): AssetView | undefined {
  let body: unknown;
  try {
    body = JSON.parse(row.body);
  } catch {
    return undefined;
  }
  const common = {
    id: row.id,
    title: row.title,
    ...(row.offering_id ? { offeringId: row.offering_id } : {}),
    ...(row.reference_id ? { referenceId: row.reference_id } : {}),
    ...(row.link_batch_id ? { linkBatchId: row.link_batch_id } : {}),
    createdAt: row.created_at,
  };
  if (row.kind === 'storyboard') {
    return { ...common, kind: 'storyboard', storyboard: body as Storyboard };
  }
  if (row.kind === 'image') {
    return {
      ...common,
      kind: 'image',
      image: body as ImageCard,
      imagePath: `/content-radar/assets/${row.id}/image.svg`,
    };
  }
  return undefined;
}

/* --------------------------------------------------------------- helpers */

async function offering(
  db: Client,
  workspaceId: string,
  offeringId: string,
): Promise<OfferingRow | undefined> {
  return queryOne<OfferingRow>(
    db,
    `SELECT id, name, category, url, description, value_propositions, competitors
       FROM offerings WHERE workspace_id = ? AND id = ?`,
    [workspaceId, offeringId],
  );
}

function brandOf(row: OfferingRow): RadarBrand {
  return {
    name: row.name,
    ...(row.url ? { url: row.url } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(list(row.value_propositions).length
      ? { valuePropositions: list(row.value_propositions) }
      : {}),
  };
}

async function voiceOf(db: Client, workspaceId: string, offeringId: string) {
  const voice = await queryOne<{ style: string; instructions: string | null }>(
    db,
    `SELECT v.style, v.instructions FROM voice_profiles v
       JOIN campaigns c ON c.voice_profile_id = v.id
      WHERE c.workspace_id = ? AND c.offering_id = ?
      ORDER BY c.created_at ASC LIMIT 1`,
    [workspaceId, offeringId],
  );
  return voice
    ? { style: voice.style, ...(voice.instructions ? { instructions: voice.instructions } : {}) }
    : undefined;
}

export interface RadarDeps {
  readonly db: Client;
  readonly model?: TextModel | undefined;
  readonly reader?: TopPostReader | undefined;
  /** Test seams for reading a pasted reference URL. */
  readonly fetchImpl?: FetchLike | undefined;
  readonly lookup?: HostLookup | undefined;
  readonly clock?: () => Date;
}

/**
 * The product's radar, created on first use. Terms and subreddits come from
 * the product's buyer-lead monitor when it has one, else the model's
 * suggestion, else the category and named competitors.
 */
export async function ensureRadar(
  deps: RadarDeps,
  workspaceId: string,
  offeringId: string,
): Promise<RadarRow> {
  const existing = await queryOne<RadarRow>(
    deps.db,
    'SELECT * FROM content_radars WHERE workspace_id = ? AND offering_id = ?',
    [workspaceId, offeringId],
  );
  if (existing) return existing;
  const product = await offering(deps.db, workspaceId, offeringId);
  if (!product) throw ApiError.notFound('product');

  let terms: string[] = [];
  let subreddits: string[] = [];
  const monitor = await queryOne<{ keywords_json: string; subreddits_json: string }>(
    deps.db,
    `SELECT keywords_json, subreddits_json FROM lead_monitors
      WHERE workspace_id = ? AND offering_id = ? ORDER BY created_at ASC LIMIT 1`,
    [workspaceId, offeringId],
  );
  if (monitor) {
    terms = list(monitor.keywords_json);
    subreddits = list(monitor.subreddits_json);
  }
  if (terms.length === 0 && deps.model) {
    const suggestion = await suggestMonitor(deps.model, {
      name: product.name,
      ...(product.url ? { url: product.url } : {}),
      ...(product.description ? { description: product.description } : {}),
    }).catch(() => undefined);
    if (suggestion) {
      terms = [...suggestion.keywords];
      subreddits = [...suggestion.subreddits];
    }
  }
  if (terms.length === 0) {
    terms = [product.category ?? '', ...list(product.competitors)].filter(Boolean);
  }
  terms = [...new Set(terms)].slice(0, 8);
  const tags = [...new Set(terms.map(tagFor).filter((t) => t.length >= 3 && t.length <= 30))].slice(
    0,
    6,
  );
  const at = now();
  await deps.db.execute({
    sql: `INSERT INTO content_radars (workspace_id, offering_id, terms, subreddits, tags,
            created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, offering_id) DO NOTHING`,
    args: [
      workspaceId,
      offeringId,
      JSON.stringify(terms),
      JSON.stringify(subreddits.slice(0, 6)),
      JSON.stringify(tags),
      at,
      at,
    ],
  });
  return (await queryOne<RadarRow>(
    deps.db,
    'SELECT * FROM content_radars WHERE workspace_id = ? AND offering_id = ?',
    [workspaceId, offeringId],
  ))!;
}

/** A top post, or one a person pasted (`source: 'manual'`). */
type StoredPost = Omit<TopPost, 'source'> & { readonly source: TopPostSource | 'manual' };

async function storeReferences(
  db: Client,
  workspaceId: string,
  offeringId: string | null,
  origin: 'keyword' | 'follow' | 'manual',
  posts: readonly StoredPost[],
): Promise<number> {
  let fresh = 0;
  for (const post of posts) {
    const at = now();
    const result = await db.execute({
      sql: `INSERT INTO content_references (id, workspace_id, offering_id, source, external_id, url,
              author_handle, author_name, title, text, container, posted_at, likes, reposts,
              comments, engagement, origin, matched, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (workspace_id, source, external_id) DO NOTHING`,
      args: [
        newId('contentReference'),
        workspaceId,
        offeringId,
        post.source,
        post.externalId,
        post.url,
        post.authorHandle ?? null,
        post.authorName ?? null,
        post.title ?? null,
        post.text,
        post.container ?? null,
        post.postedAt,
        post.likes,
        post.reposts,
        post.comments,
        engagementScore(post),
        origin,
        post.matched ?? null,
        at,
        at,
      ],
    });
    if (Number(result.rowsAffected ?? 0) > 0) {
      fresh += 1;
    } else {
      // Seen before: its numbers grow while it is still circulating.
      await db.execute({
        sql: `UPDATE content_references SET likes = ?, reposts = ?, comments = ?, engagement = ?,
                updated_at = ?
               WHERE workspace_id = ? AND source = ? AND external_id = ?`,
        args: [
          post.likes,
          post.reposts,
          post.comments,
          engagementScore(post),
          at,
          workspaceId,
          post.source,
          post.externalId,
        ],
      });
    }
  }
  return fresh;
}

/**
 * Names the hook of up to `limit` references not yet judged by the model,
 * most engaging first. Without a model the wording names it (judged = 0), so
 * every reference shows a hook either way and the model improves on it later.
 */
export async function analyzeReferences(
  deps: RadarDeps,
  workspaceId: string,
  offeringId: string | null,
  limit = HOOKS_PER_SCAN,
): Promise<number> {
  const at = now();
  // The cheap guess first, for every row that has nothing yet. It costs no
  // model call, so it is not held to the model's per-scan limit: limited to
  // the highest raw engagement, a niche subreddit's posts (tens of points
  // beside Bluesky's thousands) never got a hook, and drafts skip those.
  const unlabelled = await queryAll<Pick<ReferenceRow, 'id' | 'title' | 'text'>>(
    deps.db,
    `SELECT id, title, text FROM content_references
      WHERE workspace_id = ? AND hook_type IS NULL AND status <> 'dismissed'
        ${offeringId ? 'AND offering_id = ?' : ''}`,
    offeringId ? [workspaceId, offeringId] : [workspaceId],
  );
  for (const row of unlabelled) {
    await deps.db.execute({
      sql: 'UPDATE content_references SET hook_type = ?, updated_at = ? WHERE id = ?',
      args: [heuristicHook(`${row.title ?? ''}\n${row.text}`), at, row.id],
    });
  }
  if (!deps.model) return 0;

  const rows = await queryAll<ReferenceRow>(
    deps.db,
    `SELECT * FROM content_references
      WHERE workspace_id = ? AND hook_judged = 0 AND status <> 'dismissed'
        ${offeringId ? 'AND offering_id = ?' : ''}
      ORDER BY engagement DESC LIMIT ?`,
    offeringId ? [workspaceId, offeringId, limit] : [workspaceId, limit],
  );
  if (rows.length === 0) return 0;

  const product = offeringId ? await offering(deps.db, workspaceId, offeringId) : undefined;
  const brand: RadarBrand = product ? brandOf(product) : { name: 'our product' };
  let judged = 0;
  for (let i = 0; i < rows.length; i += 10) {
    const batch = rows.slice(i, i + 10);
    let results;
    try {
      results = await analyzeHooks(
        deps.model,
        brand,
        batch.map((row) => ({
          id: row.id,
          source: row.source,
          ...(row.title ? { title: row.title } : {}),
          text: row.text,
          likes: Number(row.likes),
          reposts: Number(row.reposts),
          comments: Number(row.comments),
        })),
      );
    } catch (error) {
      console.error(`content radar: hook analysis failed for ${workspaceId}`, error);
      break;
    }
    for (const result of results) {
      await deps.db.execute({
        sql: `UPDATE content_references SET hook_type = ?, hook_why = ?, hook_angle = ?,
                hook_judged = 1, relevant = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
        args: [
          result.hookType,
          result.why || null,
          result.angle || null,
          result.relevant ? 1 : 0,
          at,
          result.id,
          workspaceId,
        ],
      });
      judged += 1;
    }
  }
  return judged;
}

export interface ScanResult {
  readonly offeringId: string;
  readonly read: number;
  readonly stored: number;
  readonly judged: number;
  readonly failures: readonly { source: string; reason: string }[];
}

/** One product's radar: every source, every follow, then the hooks. */
export async function scanRadar(
  deps: RadarDeps,
  workspaceId: string,
  offeringId: string,
): Promise<ScanResult> {
  const radar = await ensureRadar(deps, workspaceId, offeringId);
  const reader = deps.reader ?? new TopPostReader();
  const clock = deps.clock ?? (() => new Date());
  const since = new Date(clock().getTime() - WINDOW_DAYS * DAY_MS);
  const query = {
    terms: list(radar.terms),
    subreddits: list(radar.subreddits),
    tags: list(radar.tags),
    since,
    limit: 25,
  };
  const failures: { source: string; reason: string }[] = [];
  let read = 0;
  let stored = 0;

  for (const source of list(radar.sources).filter(isTopPostSource)) {
    if (source === 'reddit' && query.subreddits.length === 0) continue;
    try {
      const posts = await reader.top(source, query);
      read += posts.length;
      stored += await storeReferences(deps.db, workspaceId, offeringId, 'keyword', posts);
    } catch (error) {
      failures.push({ source, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const follows = await queryAll<FollowRow>(
    deps.db,
    `SELECT * FROM content_follows
      WHERE workspace_id = ? AND (offering_id = ? OR offering_id IS NULL)`,
    [workspaceId, offeringId],
  );
  for (const follow of follows) {
    if (!isFollowNetwork(follow.network)) continue;
    let error: string | null = null;
    try {
      const posts = await reader.follow(follow.network, follow.handle, since);
      read += posts.length;
      stored += await storeReferences(
        deps.db,
        workspaceId,
        follow.offering_id ?? offeringId,
        'follow',
        posts.map((post) => ({ ...post, matched: follow.label || `@${follow.handle}` })),
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      failures.push({ source: `${follow.network}:${follow.handle}`, reason: error });
    }
    await deps.db.execute({
      sql: 'UPDATE content_follows SET last_read_at = ?, last_error = ? WHERE id = ?',
      args: [now(), error, follow.id],
    });
  }

  const judged = await analyzeReferences(deps, workspaceId, offeringId);
  await deps.db.execute({
    sql: `UPDATE content_radars SET last_scan_at = ?, last_error = ?, updated_at = ?
           WHERE workspace_id = ? AND offering_id = ?`,
    args: [
      clock().toISOString(),
      failures.length ? failures.map((f) => `${f.source}: ${f.reason}`).join('; ') : null,
      now(),
      workspaceId,
      offeringId,
    ],
  });
  return { offeringId, read, stored, judged, failures };
}

/* ---------------------------------------------------------------- create */

export interface CreateResult {
  readonly batchId?: string;
  readonly posts: number;
  readonly assets: AssetView[];
  readonly skipped: string[];
}

/**
 * Turns a reference into posts for each network (ordinary link-post cards),
 * a storyboard and an image card, all for the reference's product.
 */
export async function createFromReference(
  deps: RadarDeps & { readonly model: TextModel },
  workspaceId: string,
  referenceId: string,
  options: {
    readonly offeringId?: string | undefined;
    readonly networks?: readonly LinkPostNetwork[] | undefined;
    readonly formats?: readonly StudioFormat[] | undefined;
    readonly createdBy: string;
  },
): Promise<CreateResult> {
  const reference = await queryOne<ReferenceRow>(
    deps.db,
    'SELECT * FROM content_references WHERE id = ? AND workspace_id = ?',
    [referenceId, workspaceId],
  );
  if (!reference) throw ApiError.notFound('reference');
  const offeringId = options.offeringId ?? reference.offering_id;
  if (!offeringId) throw ApiError.badRequest('pick the product to write for (offeringId)');
  const product = await offering(deps.db, workspaceId, offeringId);
  if (!product) throw ApiError.badRequest('product is not in this workspace');
  const radar = await ensureRadar(deps, workspaceId, offeringId);
  const formats = new Set<StudioFormat>(options.formats ?? STUDIO_FORMATS);
  const skipped: string[] = [];
  const hookType =
    reference.hook_type && isHookType(reference.hook_type)
      ? HOOK_LABELS[reference.hook_type]
      : undefined;
  const ref = {
    source: reference.source,
    ...(reference.title ? { title: reference.title } : {}),
    text: reference.text,
    ...(hookType ? { hookType } : {}),
    ...(reference.hook_why ? { why: reference.hook_why } : {}),
    ...(reference.hook_angle ? { angle: reference.hook_angle } : {}),
  };

  let batchId: string | undefined;
  let posts = 0;
  if (formats.has('posts')) {
    if (!product.url) {
      skipped.push('posts: the product has no URL to link to');
    } else {
      const networks = (options.networks?.length ? options.networks : list(radar.networks)).filter(
        (n): n is LinkPostNetwork => (LINK_POST_NETWORKS as readonly string[]).includes(n),
      );
      const page: ReadPage = {
        url: product.url,
        read: true,
        title: product.name,
        ...(product.description ? { description: product.description } : {}),
        text: [product.description, ...list(product.value_propositions)].filter(Boolean).join('\n'),
      };
      const stored = await storeDraftedBatch(deps.db, deps.model, {
        workspaceId,
        url: product.url,
        page,
        networks: networks.length ? networks : DEFAULT_NETWORKS,
        offeringId,
        notes: referenceDirection(ref),
        createdBy: options.createdBy,
      });
      batchId = stored.batchId;
      posts = stored.rows.length;
    }
  }

  const assets: AssetView[] = [];
  if (formats.has('storyboard') || formats.has('image')) {
    const studio = await draftStudio(deps.model, {
      brand: brandOf(product),
      ...(await voiceOf(deps.db, workspaceId, offeringId).then((voice) =>
        voice ? { voice } : {},
      )),
      reference: ref,
    });
    const at = now();
    const write = async (kind: 'storyboard' | 'image', title: string, body: unknown) => {
      const row: AssetRow = {
        id: newId('contentAsset'),
        workspace_id: workspaceId,
        offering_id: offeringId,
        reference_id: reference.id,
        kind,
        title,
        body: JSON.stringify(body),
        link_batch_id: batchId ?? null,
        model: studio.model,
        created_at: at,
      };
      await deps.db.execute({
        sql: `INSERT INTO content_assets (id, workspace_id, offering_id, reference_id, kind, title,
                body, link_batch_id, model, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          row.id,
          row.workspace_id,
          row.offering_id,
          row.reference_id,
          row.kind,
          row.title,
          row.body,
          row.link_batch_id,
          row.model,
          row.created_at,
        ],
      });
      const view = assetView(row);
      if (view) assets.push(view);
    };
    if (formats.has('storyboard')) {
      if (studio.storyboard) await write('storyboard', studio.storyboard.title, studio.storyboard);
      else skipped.push('storyboard: the model returned none');
    }
    if (formats.has('image')) {
      if (studio.image) await write('image', studio.image.headline, studio.image);
      else skipped.push('image: the model returned none');
    }
  }

  await deps.db.execute({
    sql: `UPDATE content_references SET status = 'used', used_batch_id = COALESCE(?, used_batch_id),
            updated_at = ? WHERE id = ?`,
    args: [batchId ?? null, now(), reference.id],
  });
  await repo.audit(deps.db, {
    workspaceId,
    actorKind: options.createdBy === RADAR_CREATED_BY ? 'system' : 'user',
    actorId: options.createdBy,
    eventType: 'content.radar_created',
    entityKind: 'content_reference',
    entityId: reference.id,
    detail: { offeringId, posts, assets: assets.map((a) => a.kind), batchId: batchId ?? null },
  });
  return { ...(batchId ? { batchId } : {}), posts, assets, skipped };
}

/* ----------------------------------------------------------------- sweep */

export interface SweepResult {
  readonly scans: ScanResult[];
  readonly drafted: { workspaceId: string; offeringId: string; referenceId: string }[];
}

/**
 * The automation: radars for every product of a running campaign, the due
 * scans (a few a sweep), then each workspace's daily drafts.
 */
export async function runContentRadar(deps: RadarDeps): Promise<SweepResult> {
  const clock = deps.clock ?? (() => new Date());
  const products = await queryAll<{ workspace_id: string; offering_id: string }>(
    deps.db,
    `SELECT DISTINCT c.workspace_id, c.offering_id FROM campaigns c
       JOIN offerings o ON o.id = c.offering_id
      WHERE c.status IN ('active', 'running') AND c.offering_id IS NOT NULL`,
  );
  const scans: ScanResult[] = [];
  const dueBefore = new Date(clock().getTime() - RADAR_SCAN_HOURS * 3_600_000).toISOString();
  for (const product of products) {
    if (scans.length >= SCANS_PER_SWEEP) break;
    const radar = await queryOne<RadarRow>(
      deps.db,
      'SELECT * FROM content_radars WHERE workspace_id = ? AND offering_id = ?',
      [product.workspace_id, product.offering_id],
    );
    if (radar && (Number(radar.enabled) !== 1 || (radar.last_scan_at ?? '') > dueBefore)) continue;
    try {
      scans.push(await scanRadar(deps, product.workspace_id, product.offering_id));
    } catch (error) {
      console.error(`content radar: scan failed for ${product.offering_id}`, error);
    }
  }

  const drafted: SweepResult['drafted'] = [];
  if (deps.model) {
    const workspaces = [...new Set(products.map((p) => p.workspace_id))];
    for (const workspaceId of workspaces) {
      for (const pick of await draftPicks(deps.db, workspaceId, clock())) {
        // Either way the product's turn is spent for today: a model outage
        // must not retry every tick, nor throw away a good reference.
        let failure: string | null = null;
        try {
          await createFromReference({ ...deps, model: deps.model }, workspaceId, pick.referenceId, {
            offeringId: pick.offeringId,
            createdBy: RADAR_CREATED_BY,
          });
          drafted.push({ workspaceId, ...pick });
        } catch (error) {
          failure = `drafting failed: ${error instanceof Error ? error.message : String(error)}`;
          console.error(`content radar: drafting ${pick.referenceId} failed`, error);
        }
        await deps.db.execute({
          sql: `UPDATE content_radars SET last_draft_at = ?, updated_at = ?,
                  last_error = COALESCE(?, last_error)
                 WHERE workspace_id = ? AND offering_id = ?`,
          args: [clock().toISOString(), now(), failure, workspaceId, pick.offeringId],
        });
      }
    }
  }
  return { scans, drafted };
}

/**
 * What a workspace drafts now: room under today's cap, products not drafted
 * today taking turns (longest waiting first), each its best unused reference
 * from the window, judged by the model before guessed by wording.
 */
export async function draftPicks(
  db: Client,
  workspaceId: string,
  at: Date,
): Promise<{ offeringId: string; referenceId: string }[]> {
  const day = `${at.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const autoToday = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(DISTINCT batch_id) AS n FROM link_posts
      WHERE workspace_id = ? AND created_by = ? AND created_at >= ?`,
    [workspaceId, RADAR_CREATED_BY, day],
  );
  const room = RADAR_DRAFTS_PER_DAY - Number(autoToday?.n ?? 0);
  if (room <= 0) return [];
  const radars = await queryAll<RadarRow>(
    db,
    `SELECT * FROM content_radars
      WHERE workspace_id = ? AND enabled = 1 AND auto_draft = 1
        AND (last_draft_at IS NULL OR last_draft_at < ?)
      ORDER BY COALESCE(last_draft_at, '') ASC`,
    [workspaceId, day],
  );
  const since = new Date(at.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const picks: { offeringId: string; referenceId: string }[] = [];
  for (const radar of radars) {
    if (picks.length >= room) break;
    const candidates = await queryAll<ReferenceRow>(
      db,
      `SELECT * FROM content_references
        WHERE workspace_id = ? AND offering_id = ? AND status IN ('new', 'saved')
          AND posted_at >= ? AND hook_type IS NOT NULL AND (relevant IS NULL OR relevant = 1)
        ORDER BY engagement DESC LIMIT 500`,
      [workspaceId, radar.offering_id, since],
    );
    const best = withLift(candidates).sort(pickOrder)[0];
    if (best) picks.push({ offeringId: radar.offering_id, referenceId: best.id });
  }
  return picks;
}

/**
 * How much a post beat its peers: its engagement over the median of posts
 * from the same source and origin. Raw numbers do not compare: a followed
 * account with a million followers gets 10,000 likes on a photo of clouds,
 * and a niche subreddit's best post of the month has 120.
 */
export function withLift<T extends Pick<ReferenceRow, 'source' | 'origin' | 'engagement'>>(
  rows: readonly T[],
): (T & { lift: number })[] {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const key = `${row.source}|${row.origin}`;
    const list = groups.get(key) ?? [];
    list.push(Number(row.engagement));
    groups.set(key, list);
  }
  const medians = new Map<string, number>();
  for (const [key, values] of groups) {
    const sorted = [...values].sort((a, b) => a - b);
    medians.set(key, sorted[Math.floor(sorted.length / 2)] ?? 0);
  }
  return rows.map((row) => {
    const median = medians.get(`${row.source}|${row.origin}`) ?? 0;
    return {
      ...row,
      lift: Math.round((Number(row.engagement) / Math.max(1, median)) * 100) / 100,
    };
  });
}

/**
 * Drafting order: a person's save first, then what the radar found for the
 * product's own terms over what a followed account posted, then the model's
 * judgement over the wording's, then lift.
 */
function pickOrder(a: ReferenceRow & { lift: number }, b: ReferenceRow & { lift: number }): number {
  const rank = (row: ReferenceRow) =>
    (row.status === 'saved' ? 0 : 4) +
    (row.origin === 'follow' ? 2 : 0) +
    (row.hook_judged ? 0 : 1);
  return rank(a) - rank(b) || b.lift - a.lift || Number(b.engagement) - Number(a.engagement);
}

/* ---------------------------------------------------------------- routes */

export interface ContentRadarRouteDeps {
  readonly model?: TextModel | undefined;
  readonly throttles?: Throttles | undefined;
  readonly reader?: TopPostReader | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly lookup?: HostLookup | undefined;
}

const radarSchema = z.object({
  terms: z.array(z.string().trim().min(2).max(80)).max(12).optional(),
  subreddits: z.array(z.string().trim().min(2).max(60)).max(10).optional(),
  tags: z.array(z.string().trim().min(2).max(40)).max(10).optional(),
  sources: z.array(z.enum(TOP_POST_SOURCES)).optional(),
  networks: z.array(z.enum(LINK_POST_NETWORKS)).optional(),
  enabled: z.boolean().optional(),
  autoDraft: z.boolean().optional(),
});

const referenceSchema = z.object({
  url: z.string().trim().url().max(2000),
  offeringId: z.string().max(80).optional(),
  title: z.string().trim().max(300).optional(),
  text: z.string().trim().max(4000).optional(),
  collection: z.string().trim().max(80).optional(),
});

const patchReferenceSchema = z.object({
  status: z.enum(REFERENCE_STATUSES).optional(),
  collection: z.string().trim().max(80).nullable().optional(),
  offeringId: z.string().max(80).optional(),
});

const followSchema = z.object({
  network: z.enum(FOLLOW_NETWORKS),
  handle: z.string().trim().min(1).max(120),
  offeringId: z.string().max(80).optional(),
  label: z.string().trim().max(80).optional(),
  kind: z.enum(['competitor', 'creator', 'audience']).optional(),
});

const createSchema = z.object({
  offeringId: z.string().max(80).optional(),
  networks: z.array(z.enum(LINK_POST_NETWORKS)).max(8).optional(),
  formats: z.array(z.enum(STUDIO_FORMATS)).min(1).optional(),
});

async function parseBody<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw ApiError.badRequest('request body must be valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw ApiError.badRequest('request body failed validation', parsed.error.flatten());
  return parsed.data;
}

function requireWriter(actor: RequestActor): void {
  if (!canApprove(actor)) throw ApiError.forbidden('changing the content radar');
}

function noModel(): ApiError {
  return new ApiError(
    503,
    'no_model',
    'no language model is configured, so nothing can be written',
  );
}

export function contentRadarRoutes(deps: ContentRadarRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const radarDeps = (db: Client): RadarDeps => ({
    db,
    ...(deps.model ? { model: deps.model } : {}),
    ...(deps.reader ? { reader: deps.reader } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.lookup ? { lookup: deps.lookup } : {}),
  });

  /** Every product's radar (created on first look), and what the radar can do. */
  router.get('/', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const offerings = await queryAll<OfferingRow>(
      db,
      `SELECT id, name, category, url, description, value_propositions, competitors
         FROM offerings WHERE workspace_id = ? ORDER BY created_at ASC`,
      [actor.workspaceId],
    );
    const counts = await queryAll<{ offering_id: string | null; n: number }>(
      db,
      `SELECT offering_id, COUNT(*) AS n FROM content_references
        WHERE workspace_id = ? AND status <> 'dismissed' GROUP BY offering_id`,
      [actor.workspaceId],
    );
    const radars = await queryAll<RadarRow>(
      db,
      'SELECT * FROM content_radars WHERE workspace_id = ?',
      [actor.workspaceId],
    );
    const byOffering = new Map(radars.map((r) => [r.offering_id, r]));
    const views: RadarView[] = [];
    for (const product of offerings) {
      const row =
        byOffering.get(product.id) ??
        (canApprove(actor)
          ? await ensureRadar({ db }, actor.workspaceId, product.id).catch(() => undefined)
          : undefined);
      if (!row) continue;
      views.push(
        radarView(
          row,
          product,
          Number(counts.find((count) => count.offering_id === product.id)?.n ?? 0),
        ),
      );
    }
    return c.json({
      radars: views,
      draftingEnabled: Boolean(deps.model),
      sources: TOP_POST_SOURCES,
      followNetworks: FOLLOW_NETWORKS,
      hookTypes: HOOK_TYPES.map((type) => ({ type, label: HOOK_LABELS[type] })),
      draftsPerDay: RADAR_DRAFTS_PER_DAY,
    });
  });

  router.put('/radars/:offeringId', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const input = await parseBody(c.req.raw, radarSchema);
    const db = c.get('db');
    const offeringId = c.req.param('offeringId');
    const row = await ensureRadar(radarDeps(db), actor.workspaceId, offeringId);
    const next = {
      terms: input.terms ? JSON.stringify(input.terms) : row.terms,
      subreddits: input.subreddits
        ? JSON.stringify(input.subreddits.map((s) => s.replace(/^\/?r\//i, '')))
        : row.subreddits,
      tags: input.tags ? JSON.stringify(input.tags.map(tagFor).filter(Boolean)) : row.tags,
      sources: input.sources ? JSON.stringify(input.sources) : row.sources,
      networks: input.networks ? JSON.stringify(input.networks) : row.networks,
      enabled: input.enabled === undefined ? Number(row.enabled) : input.enabled ? 1 : 0,
      auto_draft: input.autoDraft === undefined ? Number(row.auto_draft) : input.autoDraft ? 1 : 0,
    };
    await db.execute({
      sql: `UPDATE content_radars SET terms = ?, subreddits = ?, tags = ?, sources = ?, networks = ?,
              enabled = ?, auto_draft = ?, updated_at = ?
             WHERE workspace_id = ? AND offering_id = ?`,
      args: [
        next.terms,
        next.subreddits,
        next.tags,
        next.sources,
        next.networks,
        next.enabled,
        next.auto_draft,
        now(),
        actor.workspaceId,
        offeringId,
      ],
    });
    const updated = (await queryOne<RadarRow>(
      db,
      'SELECT * FROM content_radars WHERE workspace_id = ? AND offering_id = ?',
      [actor.workspaceId, offeringId],
    ))!;
    return c.json({
      radar: radarView(updated, await offering(db, actor.workspaceId, offeringId), 0),
    });
  });

  router.post('/radars/:offeringId/scan', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    await deps.throttles?.take('contentRadarScan', actor.workspaceId);
    const result = await scanRadar(
      radarDeps(c.get('db')),
      actor.workspaceId,
      c.req.param('offeringId'),
    );
    return c.json({ result });
  });

  /** Discover / Saved: references, filtered, most engaging (or newest) first. */
  router.get('/references', async (c) => {
    const actor = c.get('actor');
    const q = c.req.query();
    const where = ['workspace_id = ?'];
    const args: (string | number)[] = [actor.workspaceId];
    if (q.offeringId) {
      where.push('offering_id = ?');
      args.push(q.offeringId);
    }
    if (q.source && isTopPostSource(q.source)) {
      where.push('source = ?');
      args.push(q.source);
    }
    if (q.hook && isHookType(q.hook)) {
      where.push('hook_type = ?');
      args.push(q.hook);
    }
    if (q.origin === 'keyword' || q.origin === 'follow' || q.origin === 'manual') {
      where.push('origin = ?');
      args.push(q.origin);
    }
    if (q.collection) {
      where.push('collection = ?');
      args.push(q.collection);
    }
    const status = q.status ?? 'feed';
    if (status === 'feed') {
      // The feed leaves out what the model called off-topic; a saved one stays.
      where.push("(status = 'saved' OR (status = 'new' AND (relevant IS NULL OR relevant = 1)))");
    } else if ((REFERENCE_STATUSES as readonly string[]).includes(status)) {
      where.push('status = ?');
      args.push(status);
    }
    const limit = Math.max(1, Math.min(Number(q.limit) || 60, 200));
    const db = c.get('db');
    // `lift` (default) ranks against each source's typical post, so it reads a
    // wider page and sorts here; `engagement` and `recent` sort in SQL.
    const sort = q.sort === 'recent' || q.sort === 'engagement' ? q.sort : 'lift';
    const order = sort === 'recent' ? 'posted_at DESC' : 'engagement DESC, posted_at DESC';
    const fetched = await queryAll<ReferenceRow>(
      db,
      `SELECT * FROM content_references WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
      [...args, sort === 'lift' ? 1000 : limit],
    );
    const lifted = withLift(fetched);
    const rows = (
      sort === 'lift'
        ? lifted.sort((a, b) => b.lift - a.lift || Number(b.engagement) - Number(a.engagement))
        : lifted
    ).slice(0, limit);
    const collections = await queryAll<{ collection: string; n: number }>(
      db,
      `SELECT collection, COUNT(*) AS n FROM content_references
        WHERE workspace_id = ? AND collection IS NOT NULL AND status <> 'dismissed'
        GROUP BY collection ORDER BY collection`,
      [actor.workspaceId],
    );
    return c.json({
      references: rows.map((row) => ({ ...referenceView(row), lift: row.lift })),
      collections: collections.map((row) => ({ name: row.collection, count: Number(row.n) })),
    });
  });

  /** Add reference: a post someone found themselves, by URL. */
  router.post('/references', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const input = await parseBody(c.req.raw, referenceSchema);
    const db = c.get('db');
    if (input.offeringId && !(await offering(db, actor.workspaceId, input.offeringId))) {
      throw ApiError.badRequest('product is not in this workspace');
    }
    let title = input.title;
    let text = input.text;
    if (!text) {
      const page = await readLinkPage(input.url, {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.lookup ? { lookup: deps.lookup } : {}),
      });
      if (!page.read) {
        throw new ApiError(
          422,
          'unreadable',
          `could not read that page (${page.detail}); paste its text`,
        );
      }
      title = title ?? page.title;
      text = [page.description, page.text].filter(Boolean).join('\n\n').slice(0, 4000);
    }
    if (!text?.trim()) throw ApiError.badRequest('paste the post text');
    const host = new URL(input.url).hostname.replace(/^www\./, '');
    const fresh = await storeReferences(db, actor.workspaceId, input.offeringId ?? null, 'manual', [
      {
        source: 'manual',
        externalId: input.url,
        url: input.url,
        ...(title ? { title } : {}),
        text,
        postedAt: now(),
        container: host,
        likes: 0,
        reposts: 0,
        comments: 0,
      },
    ]);
    if (fresh === 0) throw new ApiError(409, 'already_saved', 'that reference is already saved');
    await db.execute({
      sql: `UPDATE content_references SET status = 'saved', collection = ?
             WHERE workspace_id = ? AND source = 'manual' AND external_id = ?`,
      args: [input.collection ?? null, actor.workspaceId, input.url],
    });
    const row = await queryOne<ReferenceRow>(
      db,
      `SELECT * FROM content_references WHERE workspace_id = ? AND source = 'manual' AND external_id = ?`,
      [actor.workspaceId, input.url],
    );
    if (!row) throw ApiError.notFound('reference');
    await analyzeReferences(radarDeps(db), actor.workspaceId, row.offering_id, 1).catch(() => 0);
    const judged = await queryOne<ReferenceRow>(
      db,
      'SELECT * FROM content_references WHERE id = ?',
      [row.id],
    );
    return c.json({ reference: referenceView(judged ?? row) }, 201);
  });

  router.patch('/references/:id', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const input = await parseBody(c.req.raw, patchReferenceSchema);
    const db = c.get('db');
    const row = await queryOne<ReferenceRow>(
      db,
      'SELECT * FROM content_references WHERE id = ? AND workspace_id = ?',
      [c.req.param('id'), actor.workspaceId],
    );
    if (!row) throw ApiError.notFound('reference');
    if (input.offeringId && !(await offering(db, actor.workspaceId, input.offeringId))) {
      throw ApiError.badRequest('product is not in this workspace');
    }
    const status = input.status ?? (input.collection ? 'saved' : row.status);
    const collection =
      input.collection === undefined ? row.collection : input.collection?.trim() || null;
    await db.execute({
      sql: `UPDATE content_references SET status = ?, collection = ?, offering_id = ?, updated_at = ?
             WHERE id = ? AND workspace_id = ?`,
      args: [
        status,
        collection,
        input.offeringId ?? row.offering_id,
        now(),
        row.id,
        actor.workspaceId,
      ],
    });
    return c.json({
      reference: referenceView({
        ...row,
        status,
        collection,
        offering_id: input.offeringId ?? row.offering_id,
      }),
    });
  });

  /** Studio: posts per network, a storyboard and an image card from one reference. */
  router.post('/references/:id/create', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const input = await parseBody(c.req.raw, createSchema);
    if (!deps.model) throw noModel();
    await deps.throttles?.take('contentRadarCreate', actor.workspaceId);
    const result = await createFromReference(
      { ...radarDeps(c.get('db')), model: deps.model },
      actor.workspaceId,
      c.req.param('id'),
      {
        ...(input.offeringId ? { offeringId: input.offeringId } : {}),
        ...(input.networks ? { networks: input.networks } : {}),
        ...(input.formats ? { formats: input.formats } : {}),
        createdBy: actor.userId,
      },
    );
    return c.json(result, 201);
  });

  /* Following */
  router.get('/follows', async (c) => {
    const actor = c.get('actor');
    const rows = await queryAll<FollowRow>(
      c.get('db'),
      'SELECT * FROM content_follows WHERE workspace_id = ? ORDER BY created_at DESC',
      [actor.workspaceId],
    );
    return c.json({ follows: rows.map(followView), networks: FOLLOW_NETWORKS });
  });

  router.post('/follows', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const input = await parseBody(c.req.raw, followSchema);
    const db = c.get('db');
    if (input.offeringId && !(await offering(db, actor.workspaceId, input.offeringId))) {
      throw ApiError.badRequest('product is not in this workspace');
    }
    const handle = normaliseHandle(input.network, input.handle);
    if (!handle) throw ApiError.badRequest('that handle is not valid for the network');
    const row: FollowRow = {
      id: newId('contentFollow'),
      workspace_id: actor.workspaceId,
      offering_id: input.offeringId ?? null,
      network: input.network,
      handle,
      label: input.label || null,
      kind: input.kind ?? 'competitor',
      last_read_at: null,
      last_error: null,
      created_at: now(),
    };
    const result = await db.execute({
      sql: `INSERT INTO content_follows (id, workspace_id, offering_id, network, handle, label, kind,
              created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (workspace_id, network, handle) DO NOTHING`,
      args: [
        row.id,
        row.workspace_id,
        row.offering_id,
        row.network,
        row.handle,
        row.label,
        row.kind,
        row.created_at,
      ],
    });
    if (Number(result.rowsAffected ?? 0) === 0) {
      throw new ApiError(
        409,
        'already_following',
        `already following ${handle} on ${input.network}`,
      );
    }
    return c.json({ follow: followView(row) }, 201);
  });

  router.delete('/follows/:id', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const result = await c.get('db').execute({
      sql: 'DELETE FROM content_follows WHERE id = ? AND workspace_id = ?',
      args: [c.req.param('id'), actor.workspaceId],
    });
    if (Number(result.rowsAffected ?? 0) === 0) throw ApiError.notFound('follow');
    return c.json({ deleted: true });
  });

  /* Studio assets */
  router.get('/assets', async (c) => {
    const actor = c.get('actor');
    const offeringId = c.req.query('offeringId');
    const rows = await queryAll<AssetRow>(
      c.get('db'),
      `SELECT * FROM content_assets WHERE workspace_id = ? ${offeringId ? 'AND offering_id = ?' : ''}
        ORDER BY created_at DESC LIMIT 100`,
      offeringId ? [actor.workspaceId, offeringId] : [actor.workspaceId],
    );
    return c.json({ assets: rows.map(assetView).filter(Boolean) });
  });

  router.get('/assets/:id/image.svg', async (c) => {
    const actor = c.get('actor');
    const row = await queryOne<AssetRow>(
      c.get('db'),
      `SELECT * FROM content_assets WHERE id = ? AND workspace_id = ? AND kind = 'image'`,
      [c.req.param('id'), actor.workspaceId],
    );
    if (!row) throw ApiError.notFound('image');
    const card = JSON.parse(row.body) as ImageCard;
    return c.body(renderImageCardSvg(card), 200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'private, max-age=300',
    });
  });

  router.delete('/assets/:id', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const result = await c.get('db').execute({
      sql: 'DELETE FROM content_assets WHERE id = ? AND workspace_id = ?',
      args: [c.req.param('id'), actor.workspaceId],
    });
    if (Number(result.rowsAffected ?? 0) === 0) throw ApiError.notFound('asset');
    return c.json({ deleted: true });
  });

  return router;
}

/** A handle as the network's API wants it: no @, no profile URL around it. */
export function normaliseHandle(network: FollowNetwork, raw: string): string | undefined {
  let handle = raw.trim();
  try {
    if (/^https?:\/\//i.test(handle)) {
      const url = new URL(handle);
      const parts = url.pathname.split('/').filter(Boolean);
      if (network === 'bluesky') handle = parts[1] ?? '';
      else if (network === 'mastodon')
        handle = `${(parts[0] ?? '').replace(/^@/, '')}@${url.hostname}`;
      else if (network === 'hackernews') handle = url.searchParams.get('id') ?? '';
      else if (network === 'reddit') handle = parts[1] ?? '';
      else handle = parts[0] ?? '';
    }
  } catch {
    return undefined;
  }
  handle = handle.replace(/^@/, '').replace(/^\/?u\//i, '');
  return /^[A-Za-z0-9_.:@-]{1,120}$/.test(handle) ? handle : undefined;
}
