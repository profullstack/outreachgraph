/**
 * Posts from a link: `/api/v1/link-posts/*`.
 *
 * Paste a URL, pick networks, get a hand-off card per network: the post
 * written in the workspace's voice and sized to that network, a button that
 * opens the network's composer prefilled, the steps, Mark done. Regenerate
 * rewrites one card from the page text stored with it.
 *
 * Nothing here posts anywhere. LinkedIn, Reddit, HN and Facebook may not be
 * posted to by the product at all, and the others are posted by the person
 * whose name is on them; every card ends with a human pressing Post.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { draftLinkPosts, type LinkPage, type TextModel } from '@outreachgraph/ai';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  LINK_POST_FORMATS,
  LINK_POST_NETWORKS,
  LINK_POST_STATUSES,
  linkPostBodyFromText,
  linkPostCard,
  newId,
  type LinkPostCardView,
  type LinkPostNetwork,
  type LinkPostStatus,
} from '@outreachgraph/domain';
import {
  assertPublicUrl,
  fetchPage,
  UnsafeUrlError,
  visibleText,
  type FetchLike,
  type HostLookup,
} from '@outreachgraph/providers';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import * as repo from './repository';
import type { Throttles } from './throttle';
import { listProducts, loadWorkspaceProfile } from './workspace-profile';

export interface LinkPostRouteDeps {
  /** Writes the posts. Absent: drafting answers 503, the cards still list. */
  readonly model?: TextModel | undefined;
  /** Test seam: the network the page is read over. */
  readonly fetchImpl?: FetchLike | undefined;
  /** Test seam: DNS for the private-address check. */
  readonly lookup?: HostLookup | undefined;
  readonly throttles?: Throttles | undefined;
}

/** What a card is, as every client sees it. */
export interface LinkPostView extends LinkPostCardView {
  readonly id: string;
  readonly batchId: string;
  readonly url: string;
  readonly pageTitle?: string;
  /** The post without the link, which is what an edit should start from. */
  readonly body: string;
  readonly notes?: string;
  readonly mastodonInstance?: string;
  readonly offeringId?: string;
  readonly status: LinkPostStatus;
  readonly postedUrl?: string;
  readonly model?: string;
  readonly regenerations: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly doneAt?: string;
}

interface LinkPostRow {
  id: string;
  workspace_id: string;
  batch_id: string;
  offering_id: string | null;
  url: string;
  page_title: string | null;
  page_description: string | null;
  page_text: string | null;
  notes: string | null;
  network: string;
  title: string | null;
  body: string;
  subreddit: string | null;
  mastodon_instance: string | null;
  status: string;
  posted_url: string | null;
  model: string | null;
  regenerations: number;
  created_at: string;
  updated_at: string;
  done_at: string | null;
}

export function toLinkPostView(row: LinkPostRow): LinkPostView {
  const network = row.network as LinkPostNetwork;
  const card = linkPostCard({
    network,
    url: row.url,
    body: row.body,
    title: row.title,
    subreddit: row.subreddit,
    mastodonInstance: row.mastodon_instance,
  });
  return {
    ...card,
    id: row.id,
    batchId: row.batch_id,
    url: row.url,
    ...(row.page_title ? { pageTitle: row.page_title } : {}),
    body: row.body,
    ...(row.notes ? { notes: row.notes } : {}),
    ...(row.mastodon_instance ? { mastodonInstance: row.mastodon_instance } : {}),
    ...(row.offering_id ? { offeringId: row.offering_id } : {}),
    status: row.status as LinkPostStatus,
    ...(row.posted_url ? { postedUrl: row.posted_url } : {}),
    ...(row.model ? { model: row.model } : {}),
    regenerations: Number(row.regenerations ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.done_at ? { doneAt: row.done_at } : {}),
  };
}

/* ----------------------------------------------------------- page reading */

export interface ReadPage extends LinkPage {
  /** True when the page itself was read; false means only the URL and notes are known. */
  readonly read: boolean;
  readonly detail?: string;
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function meta(html: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forward = new RegExp(
    `<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    'i',
  );
  const backward = new RegExp(
    `<meta\\b[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${escaped}["']`,
    'i',
  );
  const found = html.match(forward)?.[1] ?? html.match(backward)?.[1];
  return found && found.trim() ? decode(found) : undefined;
}

/**
 * Title, description and main text from a page's HTML. Pure.
 *
 * The main text prefers `<article>`, then `<main>`, then the whole body, so a
 * blog post is read without its navigation, cookie banner and footer.
 */
export function extractLinkPage(html: string): Pick<LinkPage, 'title' | 'description' | 'text'> {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title =
    meta(html, 'og:title') ??
    meta(html, 'twitter:title') ??
    (titleTag && decode(titleTag) ? decode(titleTag) : undefined);
  const description =
    meta(html, 'og:description') ?? meta(html, 'description') ?? meta(html, 'twitter:description');
  const article =
    html.match(/<article\b[\s\S]*<\/article>/i)?.[0] ??
    html.match(/<main\b[\s\S]*<\/main>/i)?.[0] ??
    html;
  const stripped = article
    .replace(/<(nav|header|footer|aside|form|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/h[1-6]|\/li)\b[^>]*>/gi, '$& ');
  const text = visibleText(stripped, 6000);
  return {
    ...(title ? { title: title.slice(0, 300) } : {}),
    ...(description ? { description: description.slice(0, 1000) } : {}),
    ...(text.length > 40 ? { text } : {}),
  };
}

/**
 * Reads the page being shared, like a link unfurler would.
 *
 * Every hop is checked against private addresses: the URL comes from a
 * request body, and an unchecked fetch is a way to read the deployment's own
 * network. robots.txt is not consulted, for the same reason a social
 * network's link preview does not consult it: this is one fetch a person asked
 * for, of a page they are about to share, not a crawl.
 */
export async function readLinkPage(
  url: string,
  options: { readonly fetchImpl?: FetchLike; readonly lookup?: HostLookup } = {},
): Promise<ReadPage> {
  const base = options.fetchImpl ?? fetch;
  const guarded: FetchLike = async (input, init) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    await assertPublicUrl(target, {
      allowHttp: true,
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
    return base(input, init);
  };

  const page = await fetchPage(url, {
    fetchImpl: guarded,
    robots: { disallow: [], allow: [] },
    timeoutMs: 12_000,
  });
  if (page.outcome !== 'ok' || !page.html) {
    return {
      url,
      read: false,
      detail: page.detail ?? (page.status ? `http ${page.status}` : page.outcome),
    };
  }
  return { url, read: true, ...extractLinkPage(page.html) };
}

/* ----------------------------------------------------------------- store */

async function getRow(db: Client, workspaceId: string, id: string) {
  return queryOne<LinkPostRow>(db, 'SELECT * FROM link_posts WHERE id = ? AND workspace_id = ?', [
    id,
    workspaceId,
  ]);
}

export async function listLinkPosts(
  db: Client,
  workspaceId: string,
  options: { readonly status?: LinkPostStatus | 'all'; readonly limit?: number } = {},
): Promise<LinkPostView[]> {
  const status = options.status ?? 'open';
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const rows = await queryAll<LinkPostRow>(
    db,
    status === 'all'
      ? 'SELECT * FROM link_posts WHERE workspace_id = ? ORDER BY created_at DESC, network ASC LIMIT ?'
      : 'SELECT * FROM link_posts WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC, network ASC LIMIT ?',
    status === 'all' ? [workspaceId, limit] : [workspaceId, status, limit],
  );
  // Within a batch, the order the networks were offered in, LinkedIn first.
  const order = (n: string) => (LINK_POST_NETWORKS as readonly string[]).indexOf(n);
  return rows
    .sort((a, b) =>
      a.batch_id === b.batch_id
        ? order(a.network) - order(b.network)
        : b.created_at.localeCompare(a.created_at),
    )
    .map(toLinkPostView);
}

/* ----------------------------------------------------------- saved links */

export interface SavedLinkView {
  readonly url: string;
  readonly title?: string;
  readonly lastUsedAt: string;
}

/** Kept on every draft, so a link used once is one click away next time. */
async function saveLink(
  db: Client,
  workspaceId: string,
  url: string,
  title: string | undefined,
  at: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO saved_links (workspace_id, url, title, last_used_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (workspace_id, url) DO UPDATE
            SET title = COALESCE(excluded.title, saved_links.title),
                last_used_at = excluded.last_used_at`,
    args: [workspaceId, url, title ?? null, at],
  });
}

export async function listSavedLinks(db: Client, workspaceId: string): Promise<SavedLinkView[]> {
  const rows = await queryAll<{ url: string; title: string | null; last_used_at: string }>(
    db,
    `SELECT url, title, last_used_at FROM saved_links WHERE workspace_id = ?
      ORDER BY last_used_at DESC LIMIT 200`,
    [workspaceId],
  );
  return rows.map((row) => ({
    url: row.url,
    ...(row.title ? { title: row.title } : {}),
    lastUsedAt: row.last_used_at,
  }));
}

export interface DraftBatchInput {
  readonly workspaceId: string;
  readonly url: string;
  readonly page: ReadPage;
  readonly networks: readonly LinkPostNetwork[];
  readonly offeringId?: string | undefined;
  /** A campaign's own voice profile, ahead of the product's. */
  readonly voiceProfileId?: string | undefined;
  /** Who the posts are for: a campaign's target customer profile, in words. */
  readonly audience?: string | undefined;
  readonly campaignId?: string | undefined;
  readonly notes?: string | undefined;
  readonly mastodonInstance?: string | undefined;
  /** A user id, or `campaign_source` for the scheduled fetch. */
  readonly createdBy: string;
}

/**
 * Writes one post per network for a page and stores them as open cards.
 *
 * Shared by the Draft button and the campaign source fetch, so a card looks
 * the same whichever wrote it. Throws 502 when the model returns nothing.
 */
export async function storeDraftedBatch(
  db: Client,
  model: TextModel,
  input: DraftBatchInput,
): Promise<{ batchId: string; rows: LinkPostRow[]; at: string }> {
  const base = await voiceFor(db, input.workspaceId, input.offeringId);
  const campaignVoice = input.voiceProfileId
    ? await queryOne<{ style: string; instructions: string | null }>(
        db,
        'SELECT style, instructions FROM voice_profiles WHERE id = ? AND workspace_id = ?',
        [input.voiceProfileId, input.workspaceId],
      )
    : undefined;
  const voice = campaignVoice
    ? {
        style: campaignVoice.style,
        ...(campaignVoice.instructions ? { instructions: campaignVoice.instructions } : {}),
      }
    : base.voice;

  const result = await draftLinkPosts(model, {
    page: input.page,
    networks: input.networks,
    voice,
    brand: base.brand,
    audience: input.audience,
    notes: input.notes,
  });
  if (result.posts.length === 0) {
    throw new ApiError(502, 'draft_failed', 'the model did not return any posts; try again');
  }

  const batchId = newId('linkPost');
  const at = now();
  const rows: LinkPostRow[] = result.posts.map((post) => ({
    id: newId('linkPost'),
    workspace_id: input.workspaceId,
    batch_id: batchId,
    offering_id: base.offeringId ?? null,
    url: input.url,
    page_title: input.page.title ?? null,
    page_description: input.page.description ?? null,
    page_text: input.page.text ?? null,
    notes: input.notes?.trim() || null,
    network: post.network,
    title: post.title ?? null,
    body: post.text,
    subreddit: post.subreddit ?? null,
    mastodon_instance: input.mastodonInstance?.trim() || null,
    status: 'open',
    posted_url: null,
    model: result.model ?? null,
    regenerations: 0,
    created_at: at,
    updated_at: at,
    done_at: null,
  }));

  await db.batch(
    rows.map((row) => ({
      sql: `INSERT INTO link_posts (id, workspace_id, batch_id, offering_id, url, page_title,
              page_description, page_text, notes, network, title, body, subreddit,
              mastodon_instance, status, model, regenerations, created_by, created_at, updated_at,
              campaign_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 0, ?, ?, ?, ?)`,
      args: [
        row.id,
        row.workspace_id,
        row.batch_id,
        row.offering_id,
        row.url,
        row.page_title,
        row.page_description,
        row.page_text,
        row.notes,
        row.network,
        row.title,
        row.body,
        row.subreddit,
        row.mastodon_instance,
        row.model,
        input.createdBy,
        row.created_at,
        row.updated_at,
        input.campaignId ?? null,
      ],
    })),
  );

  return { batchId, rows, at };
}

/* ---------------------------------------------------------------- routes */

const networkEnum = z.enum(LINK_POST_NETWORKS);

const createSchema = z.object({
  url: z.string().min(4).max(2000),
  networks: z.array(networkEnum).min(1).max(LINK_POST_NETWORKS.length).optional(),
  offeringId: z.string().max(80).optional(),
  notes: z.string().max(1000).optional(),
  mastodonInstance: z.string().max(120).optional(),
});

const updateSchema = z.object({
  /** The pasted text as edited; the trailing link is dropped before storing. */
  text: z.string().max(10_000).optional(),
  title: z.string().max(300).nullable().optional(),
  subreddit: z.string().max(40).nullable().optional(),
  mastodonInstance: z.string().max(120).nullable().optional(),
  status: z.enum(LINK_POST_STATUSES).optional(),
});

const regenerateSchema = z.object({ notes: z.string().max(1000).optional() });
const doneSchema = z.object({
  postedUrl: z.string().max(2000).optional(),
  text: z.string().max(10_000).optional(),
  title: z.string().max(300).optional(),
});

async function body<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  try {
    const text = await request.text();
    raw = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    throw ApiError.badRequest('request body must be valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw ApiError.badRequest('request body failed validation', parsed.error.flatten());
  return parsed.data;
}

function requireApprover(actor: RequestActor, doing: string): void {
  if (!canApprove(actor)) throw ApiError.forbidden(doing);
}

function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
    if (!url.hostname.includes('.')) throw new Error('host');
    url.hash = '';
    return url.toString();
  } catch {
    throw ApiError.badRequest('url must be a web address, like https://example.com/post');
  }
}

function bareHost(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Which product is posting when the caller did not say.
 *
 * A workspace can hold dozens of products (Anthony's has 54), and the first
 * one's voice is the wrong voice for most links. A link on a product's own
 * site, or a subdomain of it, is that product talking; anything else falls
 * back to the first product, as every other default here does.
 */
export async function productForLink(
  db: Client,
  workspaceId: string,
  url: string,
): Promise<string | undefined> {
  const host = bareHost(url);
  if (!host) return undefined;
  const products = await listProducts(db, workspaceId);
  const match = products.find((product) => {
    const own = bareHost(product.url);
    return own !== undefined && (host === own || host.endsWith(`.${own}`));
  });
  return match?.offeringId;
}

/** The voice and product a workspace writes in, when setup has been done. */
async function voiceFor(db: Client, workspaceId: string, offeringId: string | undefined) {
  const profile = await loadWorkspaceProfile(db, workspaceId, offeringId).catch(() => undefined);
  if (!profile?.configured || !profile.voice || !profile.offering) {
    return { offeringId: undefined, voice: undefined, brand: undefined };
  }
  return {
    offeringId: profile.offeringId,
    voice: {
      style: profile.voice.style,
      ...(profile.voice.instructions ? { instructions: profile.voice.instructions } : {}),
    },
    brand: {
      name: profile.offering.name,
      ...(profile.url ? { url: profile.url } : {}),
      ...(profile.offering.description ? { description: profile.offering.description } : {}),
    },
  };
}

function noModel(): ApiError {
  return new ApiError(
    503,
    'no_model',
    'no language model is configured on this deployment, so posts cannot be drafted',
  );
}

export function linkPostRoutes(deps: LinkPostRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  /** Cards, newest batch first; `status` is open (default), done, skipped or all. */
  router.get('/', async (c) => {
    const actor = c.get('actor');
    const status = c.req.query('status') ?? 'open';
    if (status !== 'all' && !(LINK_POST_STATUSES as readonly string[]).includes(status)) {
      throw ApiError.badRequest(`status must be one of all, ${LINK_POST_STATUSES.join(', ')}`);
    }
    const limit = Number(c.req.query('limit') ?? 100) || 100;
    const posts = await listLinkPosts(c.get('db'), actor.workspaceId, {
      status: status as LinkPostStatus | 'all',
      limit,
    });
    return c.json({
      posts,
      networks: LINK_POST_NETWORKS.map((network) => {
        const format = LINK_POST_FORMATS[network];
        return {
          network,
          label: format.label,
          ...(format.limit ? { limit: format.limit } : {}),
          titled: format.titled,
        };
      }),
      defaultNetworks: ['linkedin'],
      // Every link drafted from, newest first, for the picker under the URL box.
      links: await listSavedLinks(c.get('db'), actor.workspaceId),
      draftingEnabled: Boolean(deps.model),
      // Stated so every client can say it: a person posts, the product never does.
      posting: 'manual',
    });
  });

  /** Read the page, write a post per network, store each as a card. */
  router.post('/', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'drafting posts');
    const input = await body(c.req.raw, createSchema);
    if (!deps.model) throw noModel();
    await deps.throttles?.take('linkPost', actor.workspaceId);

    const url = normaliseUrl(input.url);
    const networks: LinkPostNetwork[] = input.networks?.length
      ? [...new Set(input.networks)]
      : ['linkedin'];
    const db = c.get('db');

    let page: ReadPage;
    try {
      page = await readLinkPage(url, {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.lookup ? { lookup: deps.lookup } : {}),
      });
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw ApiError.badRequest(error.message);
      throw error;
    }
    if (!page.read && !input.notes?.trim()) {
      throw new ApiError(
        422,
        'page_unreadable',
        `could not read that page (${page.detail ?? 'no content'}). Add a line or two about it in notes and try again`,
      );
    }

    const { batchId, rows, at } = await storeDraftedBatch(db, deps.model, {
      workspaceId: actor.workspaceId,
      url,
      page,
      networks,
      offeringId: input.offeringId ?? (await productForLink(db, actor.workspaceId, url)),
      notes: input.notes,
      mastodonInstance: input.mastodonInstance,
      createdBy: actor.userId,
    });

    await saveLink(db, actor.workspaceId, url, page.title, at);

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'link_posts.drafted',
      entityKind: 'link_post_batch',
      entityId: batchId,
      detail: { url, networks: rows.map((r) => r.network), pageRead: page.read },
    });

    return c.json(
      {
        batchId,
        page: {
          url,
          read: page.read,
          ...(page.title ? { title: page.title } : {}),
          ...(page.description ? { description: page.description } : {}),
          ...(page.detail ? { detail: page.detail } : {}),
        },
        posts: rows.map(toLinkPostView),
        missing: networks.filter((n) => !rows.some((r) => r.network === n)),
      },
      201,
    );
  });

  /** The saved links, newest first. */
  router.get('/links', async (c) => {
    return c.json({ links: await listSavedLinks(c.get('db'), c.get('actor').workspaceId) });
  });

  /** Drops one link from the picker (`?url=`). Its cards are untouched. */
  router.delete('/links', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'removing a saved link');
    const url = c.req.query('url');
    if (!url) throw ApiError.badRequest('url is required');
    await c.get('db').execute({
      sql: 'DELETE FROM saved_links WHERE workspace_id = ? AND url = ?',
      args: [actor.workspaceId, url],
    });
    return c.json({ deleted: true, links: await listSavedLinks(c.get('db'), actor.workspaceId) });
  });

  router.get('/:id', async (c) => {
    const row = await getRow(c.get('db'), c.get('actor').workspaceId, c.req.param('id'));
    if (!row) throw ApiError.notFound('link post');
    return c.json({ post: toLinkPostView(row) });
  });

  /** Save an edit, or move a card between open, done and skipped. */
  router.patch('/:id', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'changing a post');
    const input = await body(c.req.raw, updateSchema);
    const db = c.get('db');
    const row = await getRow(db, actor.workspaceId, c.req.param('id'));
    if (!row) throw ApiError.notFound('link post');

    const network = row.network as LinkPostNetwork;
    const next: LinkPostRow = {
      ...row,
      ...(input.text !== undefined
        ? { body: linkPostBodyFromText(network, input.text, row.url) }
        : {}),
      ...(input.title !== undefined ? { title: input.title?.trim() || null } : {}),
      ...(input.subreddit !== undefined ? { subreddit: input.subreddit?.trim() || null } : {}),
      ...(input.mastodonInstance !== undefined
        ? { mastodon_instance: input.mastodonInstance?.trim() || null }
        : {}),
      ...(input.status ? { status: input.status } : {}),
      updated_at: now(),
    };
    if (input.status) next.done_at = input.status === 'done' ? (row.done_at ?? now()) : null;

    await db.execute({
      sql: `UPDATE link_posts SET body = ?, title = ?, subreddit = ?, mastodon_instance = ?,
              status = ?, done_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
      args: [
        next.body,
        next.title,
        next.subreddit,
        next.mastodon_instance,
        next.status,
        next.done_at,
        next.updated_at,
        row.id,
        actor.workspaceId,
      ],
    });
    return c.json({ post: toLinkPostView(next) });
  });

  /** Write this one card again from the stored page, optionally with new notes. */
  router.post('/:id/regenerate', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'drafting posts');
    const input = await body(c.req.raw, regenerateSchema);
    if (!deps.model) throw noModel();
    const db = c.get('db');
    const row = await getRow(db, actor.workspaceId, c.req.param('id'));
    if (!row) throw ApiError.notFound('link post');
    await deps.throttles?.take('linkPost', actor.workspaceId);

    const network = row.network as LinkPostNetwork;
    const notes = input.notes?.trim() || row.notes || undefined;
    const { voice, brand } = await voiceFor(db, actor.workspaceId, row.offering_id ?? undefined);
    const result = await draftLinkPosts(deps.model, {
      page: {
        url: row.url,
        ...(row.page_title ? { title: row.page_title } : {}),
        ...(row.page_description ? { description: row.page_description } : {}),
        ...(row.page_text ? { text: row.page_text } : {}),
      },
      networks: [network],
      voice,
      brand,
      notes: [
        notes,
        // Without this a regenerate tends to return the same post reworded.
        `Write a different post from this earlier one; a new angle or opening:\n${row.title ? `${row.title}\n` : ''}${row.body}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    const post = result.posts[0];
    if (!post)
      throw new ApiError(502, 'draft_failed', 'the model did not return a post; try again');

    const next: LinkPostRow = {
      ...row,
      body: post.text,
      title: post.title ?? (LINK_POST_FORMATS[network].titled ? row.title : null),
      subreddit: post.subreddit ?? row.subreddit,
      notes: input.notes?.trim() || row.notes,
      model: result.model ?? row.model,
      regenerations: Number(row.regenerations ?? 0) + 1,
      status: 'open',
      done_at: null,
      updated_at: now(),
    };
    await db.execute({
      sql: `UPDATE link_posts SET body = ?, title = ?, subreddit = ?, notes = ?, model = ?,
              regenerations = ?, status = 'open', done_at = NULL, updated_at = ?
             WHERE id = ? AND workspace_id = ?`,
      args: [
        next.body,
        next.title,
        next.subreddit,
        next.notes,
        next.model,
        next.regenerations,
        next.updated_at,
        row.id,
        actor.workspaceId,
      ],
    });
    return c.json({ post: toLinkPostView(next) });
  });

  /** The person posted it. Records the final wording and, if given, where it lives. */
  router.post('/:id/done', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'marking a post done');
    const input = await body(c.req.raw, doneSchema);
    const db = c.get('db');
    const row = await getRow(db, actor.workspaceId, c.req.param('id'));
    if (!row) throw ApiError.notFound('link post');

    const network = row.network as LinkPostNetwork;
    const posted = input.postedUrl?.trim();
    const at = now();
    const next: LinkPostRow = {
      ...row,
      ...(input.text !== undefined
        ? { body: linkPostBodyFromText(network, input.text, row.url) }
        : {}),
      ...(input.title !== undefined ? { title: input.title.trim() || row.title } : {}),
      status: 'done',
      posted_url: posted && /^https?:\/\//i.test(posted) ? posted : row.posted_url,
      done_at: at,
      updated_at: at,
    };
    await db.execute({
      sql: `UPDATE link_posts SET body = ?, title = ?, status = 'done', posted_url = ?, done_at = ?,
              updated_at = ? WHERE id = ? AND workspace_id = ?`,
      args: [next.body, next.title, next.posted_url, at, at, row.id, actor.workspaceId],
    });
    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'link_posts.done',
      entityKind: 'link_post',
      entityId: row.id,
      detail: { network, url: row.url, ...(next.posted_url ? { postedUrl: next.posted_url } : {}) },
    });
    return c.json({ post: toLinkPostView(next) });
  });

  router.post('/:id/skip', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'skipping a post');
    const db = c.get('db');
    const row = await getRow(db, actor.workspaceId, c.req.param('id'));
    if (!row) throw ApiError.notFound('link post');
    const at = now();
    await db.execute({
      sql: `UPDATE link_posts SET status = 'skipped', done_at = NULL, updated_at = ?
             WHERE id = ? AND workspace_id = ?`,
      args: [at, row.id, actor.workspaceId],
    });
    return c.json({
      post: toLinkPostView({ ...row, status: 'skipped', done_at: null, updated_at: at }),
    });
  });

  router.delete('/:id', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'deleting a post');
    const result = await c.get('db').execute({
      sql: 'DELETE FROM link_posts WHERE id = ? AND workspace_id = ?',
      args: [c.req.param('id'), actor.workspaceId],
    });
    if (result.rowsAffected === 0) throw ApiError.notFound('link post');
    return c.json({ deleted: true });
  });

  return router;
}
