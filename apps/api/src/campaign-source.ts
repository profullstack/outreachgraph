/**
 * The campaign's own URL, read on a schedule and turned into drafted posts.
 *
 * Drafting used to wait for someone to paste a link and press Draft. Every
 * campaign now has a source URL (its product's site unless set otherwise),
 * and the worker reads it every `CHECK_EVERY_MS`:
 *
 *   - a feed, or a page that links one (`<link rel="alternate">`): each item
 *     not seen before becomes one batch of cards, newest first;
 *   - a plain page: a change to its title or description becomes one batch.
 *
 * The first read only learns what is there (a feed's newest item is drafted so
 * the campaign has something to show), so turning this on never floods the
 * queue with a site's back catalogue. Batches are capped per campaign and per
 * workspace per UTC day, because each one is a model call and a card a person
 * has to post. Posts are written in the campaign's voice for its target
 * customer, and nothing is posted by the product.
 */

import type { TextModel } from '@outreachgraph/ai';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import { LINK_POST_NETWORKS, type LinkPostNetwork } from '@outreachgraph/domain';
import {
  assertPublicUrl,
  looksLikeFeed,
  parseFeedItems,
  type FetchLike,
  type HostLookup,
} from '@outreachgraph/providers';
import { extractLinkPage, readLinkPage, storeDraftedBatch } from './link-posts';

export const CHECK_EVERY_MS = 6 * 3_600_000;
export const BATCHES_PER_CAMPAIGN_PER_DAY = 3;
export const BATCHES_PER_WORKSPACE_PER_DAY = 12;
const CAMPAIGNS_PER_RUN = 5;
const ITEMS_READ = 10;

export interface CampaignSourceDeps {
  readonly db: Client;
  readonly model: TextModel;
  readonly fetchImpl?: FetchLike | undefined;
  readonly lookup?: HostLookup | undefined;
  readonly now?: Date;
}

export interface CampaignSourceResult {
  readonly campaignId: string;
  readonly mode: 'feed' | 'page' | 'error';
  readonly newItems: number;
  readonly drafted: number;
  readonly error?: string;
}

interface CampaignRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly offering_id: string;
  readonly voice_profile_id: string | null;
  readonly brief: string | null;
  readonly source: string;
  readonly post_networks: string;
  readonly source_fingerprint: string | null;
}

/** Reads the campaigns that are due, a few per call. */
export async function runCampaignSources(
  deps: CampaignSourceDeps,
): Promise<CampaignSourceResult[]> {
  const at = deps.now ?? new Date();
  const due = await queryAll<CampaignRow>(
    deps.db,
    `SELECT c.id, c.workspace_id, c.offering_id, c.voice_profile_id, c.brief,
            COALESCE(c.source_url, o.url) AS source, c.post_networks, c.source_fingerprint
       FROM campaigns c JOIN offerings o ON o.id = c.offering_id
      WHERE c.status IN ('active', 'running')
        AND COALESCE(c.source_url, o.url) IS NOT NULL
        AND (c.source_checked_at IS NULL OR c.source_checked_at < ?)
      ORDER BY c.source_checked_at IS NOT NULL, c.source_checked_at
      LIMIT ?`,
    [new Date(at.getTime() - CHECK_EVERY_MS).toISOString(), CAMPAIGNS_PER_RUN],
  );

  const results: CampaignSourceResult[] = [];
  for (const campaign of due) {
    results.push(await checkCampaignSource(deps, campaign, at));
  }
  return results;
}

/** One campaign: read its source, remember what is new, draft what the caps allow. */
export async function checkCampaignSource(
  deps: CampaignSourceDeps,
  campaign: CampaignRow,
  at: Date,
): Promise<CampaignSourceResult> {
  const { db } = deps;
  const source = withScheme(campaign.source);
  const stamp = at.toISOString();

  const finish = async (fields: { fingerprint?: string | null; error?: string | null }) => {
    await db.execute({
      sql: `UPDATE campaigns SET source_checked_at = ?,
              source_fingerprint = COALESCE(?, source_fingerprint), source_error = ?
             WHERE id = ?`,
      args: [stamp, fields.fingerprint ?? null, fields.error ?? null, campaign.id],
    });
  };

  let body: string;
  let contentUrl = source;
  try {
    body = await fetchText(source, deps);
  } catch (error) {
    const message = (error as Error).message.slice(0, 300);
    await finish({ error: message });
    return { campaignId: campaign.id, mode: 'error', newItems: 0, drafted: 0, error: message };
  }

  // A page that advertises a feed is read through the feed.
  let feed: string | undefined = looksLikeFeed(body) ? body : undefined;
  if (!feed) {
    const advertised = feedLink(body, source);
    if (advertised) {
      try {
        const text = await fetchText(advertised, deps);
        if (looksLikeFeed(text)) {
          feed = text;
          contentUrl = advertised;
        }
      } catch {
        // The page itself is still worth watching.
      }
    }
  }

  const room = await draftRoom(db, campaign, at);

  if (feed) {
    const items = parseFeedItems(feed).slice(0, ITEMS_READ);
    const seen = await queryOne<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM campaign_source_items WHERE campaign_id = ?',
      [campaign.id],
    );
    const firstRead = Number(seen?.n ?? 0) === 0;

    const fresh: typeof items = [];
    for (const item of items) {
      const inserted = await db.execute({
        sql: `INSERT INTO campaign_source_items (campaign_id, url, title, seen_at)
              VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [campaign.id, item.url, item.title ?? null, stamp],
      });
      if (Number(inserted.rowsAffected ?? 0) > 0) fresh.push(item);
    }

    // First read: the newest item only, never the back catalogue.
    const toDraft = (firstRead ? fresh.slice(0, 1) : fresh).slice(0, room);
    let drafted = 0;
    for (const item of toDraft) {
      const batchId = await draftFor(deps, campaign, item.url);
      if (batchId) {
        drafted += 1;
        await db.execute({
          sql: `UPDATE campaign_source_items SET drafted_batch_id = ?
                 WHERE campaign_id = ? AND url = ?`,
          args: [batchId, campaign.id, item.url],
        });
      }
    }
    await finish({ fingerprint: `feed:${contentUrl}` });
    return { campaignId: campaign.id, mode: 'feed', newItems: fresh.length, drafted };
  }

  // A plain page: its title and description are what "changed" means.
  const page = extractLinkPage(body);
  const fingerprint = `page:${page.title ?? ''}|${page.description ?? ''}`;
  const changed =
    campaign.source_fingerprint !== null && campaign.source_fingerprint !== fingerprint;
  let drafted = 0;
  if (changed && room > 0 && (await draftFor(deps, campaign, source))) drafted = 1;
  await finish({ fingerprint });
  return { campaignId: campaign.id, mode: 'page', newItems: changed ? 1 : 0, drafted };
}

/** Batches this campaign may still draft today, under both caps. */
async function draftRoom(db: Client, campaign: CampaignRow, at: Date): Promise<number> {
  const day = `${at.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const counts = await queryOne<{ mine: number; all: number }>(
    db,
    `SELECT COUNT(DISTINCT CASE WHEN campaign_id = ? THEN batch_id END) AS mine,
            COUNT(DISTINCT batch_id) AS "all"
       FROM link_posts
      WHERE workspace_id = ? AND campaign_id IS NOT NULL AND created_at >= ?`,
    [campaign.id, campaign.workspace_id, day],
  );
  return Math.max(
    0,
    Math.min(
      BATCHES_PER_CAMPAIGN_PER_DAY - Number(counts?.mine ?? 0),
      BATCHES_PER_WORKSPACE_PER_DAY - Number(counts?.all ?? 0),
    ),
  );
}

async function draftFor(
  deps: CampaignSourceDeps,
  campaign: CampaignRow,
  url: string,
): Promise<string | undefined> {
  const page = await readLinkPage(url, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.lookup ? { lookup: deps.lookup } : {}),
  });
  if (!page.read) return undefined;
  try {
    const { batchId } = await storeDraftedBatch(deps.db, deps.model, {
      workspaceId: campaign.workspace_id,
      url,
      page,
      networks: parsePostNetworks(campaign.post_networks),
      offeringId: campaign.offering_id,
      voiceProfileId: campaign.voice_profile_id ?? undefined,
      audience: await audienceFor(deps.db, campaign),
      campaignId: campaign.id,
      createdBy: 'campaign_source',
    });
    return batchId;
  } catch (error) {
    console.error(`campaign source ${campaign.id}: drafting ${url} failed`, error);
    return undefined;
  }
}

/** The campaign's target customer profile, as a sentence a writer can use. */
export async function audienceFor(db: Client, campaign: CampaignRow): Promise<string | undefined> {
  const filters = await queryOne<Record<string, string | number | null>>(
    db,
    `SELECT titles, seniorities, industries, countries, keywords,
            employee_count_min, employee_count_max
       FROM campaign_filters WHERE campaign_id = ?`,
    [campaign.id],
  );
  const list = (value: unknown): string[] => {
    try {
      const parsed = JSON.parse(String(value ?? '[]')) as unknown;
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  };
  const parts: string[] = [];
  const titles = [...list(filters?.seniorities), ...list(filters?.titles)];
  if (titles.length) parts.push(titles.slice(0, 8).join(', '));
  const industries = list(filters?.industries);
  if (industries.length) parts.push(`in ${industries.slice(0, 6).join(', ')}`);
  const min = filters?.employee_count_min;
  const max = filters?.employee_count_max;
  if (min || max) parts.push(`at companies of ${min ?? 1}-${max ?? '∞'} people`);
  const countries = list(filters?.countries);
  if (countries.length) parts.push(`(${countries.slice(0, 5).join(', ')})`);
  const keywords = list(filters?.keywords);
  if (keywords.length) parts.push(`who care about ${keywords.slice(0, 6).join(', ')}`);
  if (campaign.brief?.trim()) parts.push(`Brief: ${campaign.brief.trim().slice(0, 300)}`);
  return parts.length ? parts.join(' ') : undefined;
}

/** The networks a campaign drafts for; LinkedIn when none are valid, unless `fallback` is off. */
export function parsePostNetworks(raw: string, fallback = true): LinkPostNetwork[] {
  let valid: LinkPostNetwork[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    valid = Array.isArray(parsed)
      ? [
          ...new Set(
            parsed.filter((n): n is LinkPostNetwork =>
              (LINK_POST_NETWORKS as readonly string[]).includes(String(n)),
            ),
          ),
        ]
      : [];
  } catch {
    valid = [];
  }
  return valid.length || !fallback ? valid : ['linkedin'];
}

/** A source URL as stored, or undefined when it is not a web address. */
export function normaliseSourceUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const trimmed = raw.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!url.hostname.includes('.')) return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function withScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** The feed a page advertises, absolute. */
export function feedLink(html: string, base: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel\s*=\s*["']alternate["']/i.test(tag)) continue;
    if (!/type\s*=\s*["']application\/(rss|atom)\+xml["']/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try {
      return new URL(href.replace(/&amp;/g, '&'), base).toString();
    } catch {
      continue;
    }
  }
  return undefined;
}

async function fetchText(url: string, deps: CampaignSourceDeps): Promise<string> {
  await assertPublicUrl(url, { allowHttp: true, ...(deps.lookup ? { lookup: deps.lookup } : {}) });
  const response = await (deps.fetchImpl ?? fetch)(url, {
    headers: {
      'user-agent': 'OutreachGraph/1.0 (+https://outreachgraph.com)',
      accept: 'application/rss+xml, application/atom+xml, text/html;q=0.9, */*;q=0.5',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.text()).slice(0, 2_000_000);
}

/** For the campaign page: what the source last said. */
export async function campaignSourceStatus(db: Client, campaignId: string) {
  return queryOne<{
    source_url: string | null;
    post_networks: string;
    source_checked_at: string | null;
    source_error: string | null;
  }>(
    db,
    `SELECT COALESCE(c.source_url, o.url) AS source_url, c.post_networks, c.source_checked_at,
            c.source_error
       FROM campaigns c JOIN offerings o ON o.id = c.offering_id WHERE c.id = ?`,
    [campaignId],
  );
}
