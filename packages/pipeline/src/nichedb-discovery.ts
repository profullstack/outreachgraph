/**
 * The `discover_nichedb` job: nichedb.dev's open items become a queue of
 * sites to read, on a clock.
 *
 * nichedb.dev is Profullstack's open data directory. Some of its collections
 * are lists of people's own sites: webring members (with who makes each
 * site), sites that publish an OpenSite record, and profiles with a home page.
 * Anyone in there is somebody who publishes on the open web and says so in a
 * machine-readable way, which is exactly who an open-standards offering wants
 * to talk to. Its items API is keyless and paged by `since`, so a campaign can
 * follow it the way a feed reader follows a feed: read what changed since last
 * time, queue the new sites, come back later.
 *
 * Each run reads each collection since the cursor it was handed, turns items
 * into candidate site URLs (one per host, platforms and our own hosts
 * skipped), queues a `crawl_site` per new host under this campaign, and then
 * queues itself again with the newest `updated_at` it saw as the next cursor,
 * `everyMs` from now. The crawl does the rest: the site names its person, the
 * pipeline scores them against the offering, and a card appears or does not.
 *
 * A job, not a tick sweep, so a workspace that never asked for it costs
 * nothing, and so stopping it is deleting one pending row.
 */
import { type Client, queryAll } from '@outreachgraph/db';
import { emitEvent } from './events';
import { enqueue, type QueuedJob } from './queue';

export const NICHEDB_URL = 'https://nichedb.dev';

/** Collections whose items are people's own sites. */
export const DEFAULT_COLLECTIONS: readonly string[] = ['webrings', 'sites', 'profiles'];

/** Six hours: nichedb re-reads its sources hourly, and a site is not urgent. */
export const DEFAULT_EVERY_MS = 6 * 60 * 60 * 1000;

/** Sites queued per run, so one run cannot flood the crawl queue. */
export const DEFAULT_LIMIT = 40;

const PAGE = 200;
const MAX_PAGES_PER_COLLECTION = 5;

/**
 * Hosts that are never one person's own site: platforms whose crawl would
 * name the platform, and the hosts this company runs, which name us.
 */
const SKIP_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'medium.com',
  'substack.com',
  'reddit.com',
  'wikipedia.org',
  'nichedb.dev',
  'rssamplifier.com',
  'profullstack.com',
  'logicsrc.com',
  'outreachgraph.com',
  'goviral.wiki',
]);

export interface NichedbItem {
  readonly id?: string | number;
  readonly collection?: string;
  readonly kind?: string;
  readonly url?: string;
  readonly updated_at?: string;
  readonly data?: Record<string, unknown> | null;
}

export interface NichedbDiscoveryDeps {
  readonly db: Client;
  /** The network, for a test to stub. Defaults to fetch of nichedb's items API. */
  readonly fetchJson?: (url: string) => Promise<unknown>;
  /** Cap on sites queued per run. */
  readonly limit?: number;
}

export interface NichedbDiscoveryResult {
  readonly campaignId: string;
  readonly collections: readonly string[];
  readonly read: number;
  readonly candidates: number;
  readonly queued: number;
  readonly since: string | null;
  readonly next: string | null;
  readonly rescheduled: boolean;
}

/** The host a URL is on, without a leading www, or null for anything odd. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host))
      return null;
    return host;
  } catch {
    return null;
  }
}

/** Whether a host is a platform or one of ours, and so never a candidate. */
export function isSkippedHost(host: string): boolean {
  if (SKIP_HOSTS.has(host)) return true;
  for (const skip of SKIP_HOSTS) if (host.endsWith(`.${skip}`)) return true;
  // l.ink is the link shortener behind the sites collection's pages.
  return host.endsWith('.l.ink');
}

/**
 * The site an item is about, or null when the item is not about a site.
 *
 * A webring member's url is the member site. A site item's url is the page
 * on the site. A profile's url is nichedb's own page about the person, so the
 * site has to come from the record: the accounts it lists, or the OpenProfile
 * it was read from.
 */
export function candidateUrl(item: NichedbItem): string | null {
  const data = item.data ?? {};
  if (item.collection === 'profiles') {
    const accounts = Array.isArray(data.accounts)
      ? (data.accounts as Record<string, unknown>[])
      : [];
    for (const account of accounts) {
      const network = String(account.network ?? account.kind ?? '').toLowerCase();
      const url =
        typeof account.url === 'string'
          ? account.url
          : typeof account.value === 'string'
            ? account.value
            : '';
      if (
        (network === 'website' ||
          network === 'site' ||
          network === 'web' ||
          network === 'homepage') &&
        url
      )
        return url;
    }
    const openprofile = data.openprofile;
    if (typeof openprofile === 'string') return openprofile;
    if (
      openprofile &&
      typeof openprofile === 'object' &&
      typeof (openprofile as Record<string, unknown>).url === 'string'
    ) {
      return String((openprofile as Record<string, unknown>).url);
    }
    return null;
  }
  if (item.collection === 'webrings' && item.kind !== 'member') return null;
  return typeof item.url === 'string' ? item.url : null;
}

/** The origin of a URL, which is what the crawl wants: the site, not the page. */
export function originOf(url: string): string | null {
  const host = hostOf(url);
  if (!host) return null;
  try {
    return `${new URL(url).protocol}//${host}`;
  } catch {
    return null;
  }
}

/** The dedupe key for a campaign's first run, which the API uses to start it. */
export function firstDedupeKey(campaignId: string): string {
  return `nichedb:${campaignId}:a`;
}

/** The other of the two keys, so a running job can queue its successor. */
export function nextDedupeKey(campaignId: string, current: string | null): string {
  return current === `nichedb:${campaignId}:a`
    ? `nichedb:${campaignId}:b`
    : `nichedb:${campaignId}:a`;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'outreachgraph-nichedb-discovery/1 (+https://outreachgraph.com)',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`nichedb answered ${response.status} for ${url}`);
  return response.json();
}

/**
 * One collection since a cursor, oldest first, a few pages at most.
 *
 * @returns the items and the newest `updated_at` among them
 */
async function readCollection(
  fetchJson: (url: string) => Promise<unknown>,
  collection: string,
  since: string | null,
): Promise<{ items: NichedbItem[]; newest: string | null }> {
  const items: NichedbItem[] = [];
  let newest: string | null = since;
  let cursor = since;
  for (let page = 0; page < MAX_PAGES_PER_COLLECTION; page += 1) {
    const params = new URLSearchParams({
      collection,
      sort: 'updated',
      order: 'asc',
      limit: String(PAGE),
    });
    if (cursor) params.set('since', cursor);
    const body = (await fetchJson(`${NICHEDB_URL}/api/v1/items?${params}`)) as {
      items?: NichedbItem[];
    } | null;
    const got = Array.isArray(body?.items) ? body.items : [];
    if (got.length === 0) break;
    for (const item of got) {
      items.push(item);
      if (item.updated_at && (!newest || item.updated_at > newest)) newest = item.updated_at;
    }
    const last = got[got.length - 1]?.updated_at ?? null;
    // No progress means the page is one timestamp wide; stop rather than loop.
    if (!last || last === cursor || got.length < PAGE) break;
    cursor = last;
  }
  return { items, newest };
}

/**
 * Where a campaign's discovery stands: the pending or running job, if any.
 */
export async function nichedbDiscoveryStatus(
  db: Client,
  workspaceId: string,
  campaignId: string,
): Promise<{ id: string; status: string; runAfter: string; since: string | null }[]> {
  const rows = await queryAll<{
    id: string;
    status: string;
    run_after: string;
    payload_json: string;
  }>(
    db,
    `SELECT id, status, run_after, payload_json FROM jobs
      WHERE workspace_id = ? AND kind = 'discover_nichedb' AND status IN ('pending', 'running')
        AND payload_json LIKE ?
      ORDER BY run_after ASC`,
    [workspaceId, `%"campaignId":"${campaignId}"%`],
  );
  return rows.map((r) => {
    let since: string | null = null;
    try {
      const payload = JSON.parse(r.payload_json) as { since?: unknown };
      since = typeof payload.since === 'string' ? payload.since : null;
    } catch {
      since = null;
    }
    return { id: r.id, status: r.status, runAfter: r.run_after, since };
  });
}

/**
 * Stop following nichedb for a campaign: the pending run goes; a running one
 * finishes and, finding itself stopped, does not queue the next.
 *
 * @returns how many pending runs were removed
 */
export async function stopNichedbDiscovery(
  db: Client,
  workspaceId: string,
  campaignId: string,
): Promise<number> {
  const result = await db.execute({
    sql: `DELETE FROM jobs
           WHERE workspace_id = ? AND kind = 'discover_nichedb' AND status = 'pending'
             AND payload_json LIKE ?`,
    args: [workspaceId, `%"campaignId":"${campaignId}"%`],
  });
  return Number(result.rowsAffected ?? 0);
}

export async function runNichedbDiscoveryJob(
  deps: NichedbDiscoveryDeps,
  job: QueuedJob,
): Promise<NichedbDiscoveryResult> {
  const payload = job.payload as {
    campaignId?: string;
    collections?: unknown;
    since?: unknown;
    everyMs?: unknown;
    limit?: unknown;
  };
  const campaignId = typeof payload.campaignId === 'string' ? payload.campaignId : '';
  if (!campaignId) throw new Error('discover_nichedb needs a campaignId');
  const collections =
    Array.isArray(payload.collections) && payload.collections.length
      ? payload.collections.map(String)
      : [...DEFAULT_COLLECTIONS];
  const since = typeof payload.since === 'string' && payload.since ? payload.since : null;
  const everyMs =
    typeof payload.everyMs === 'number' && payload.everyMs >= 0
      ? payload.everyMs
      : DEFAULT_EVERY_MS;
  const limit = Math.max(1, Number(payload.limit ?? deps.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT);
  const fetchJson = deps.fetchJson ?? defaultFetchJson;

  await emitEvent(deps.db, {
    workspaceId: job.workspaceId,
    campaignId,
    phase: 'discover',
    message: `Reading nichedb.dev ${collections.join(', ')}${since ? ` since ${since}` : ''}`,
    detail: { collections, since },
  });

  let read = 0;
  let next: string | null = since;
  const hosts = new Map<string, string>();
  for (const collection of collections) {
    const { items, newest } = await readCollection(fetchJson, collection, since);
    read += items.length;
    if (newest && (!next || newest > next)) next = newest;
    for (const item of items) {
      const url = candidateUrl({ ...item, collection: item.collection ?? collection });
      if (!url) continue;
      const host = hostOf(url);
      const origin = originOf(url);
      if (!host || !origin || isSkippedHost(host) || hosts.has(host)) continue;
      hosts.set(host, origin);
    }
  }

  let queued = 0;
  for (const [host, origin] of hosts) {
    if (queued >= limit) break;
    const result = await enqueue(deps.db, {
      workspaceId: job.workspaceId,
      kind: 'crawl_site',
      payload: { url: origin, campaignId },
      // Scored per campaign, so the same site in two campaigns is two crawls;
      // the same site twice in one campaign's queue is not.
      dedupeKey: `crawl:${campaignId}:${host}`,
      batchId: job.id,
    });
    if (result.queued) queued += 1;
  }

  // The next run. Not while the campaign has been stopped under us: a stop
  // deletes the pending row, and a running job that then re-queued itself
  // would be a daemon nobody can turn off. The running row is this job, so
  // "stopped" is "this job's own row is gone".
  let rescheduled = false;
  if (everyMs > 0) {
    const still = await queryAll<{ id: string; dedupe_key: string | null }>(
      deps.db,
      `SELECT id, dedupe_key FROM jobs WHERE id = ?`,
      [job.id],
    );
    if (still.length > 0) {
      const result = await enqueue(deps.db, {
        workspaceId: job.workspaceId,
        kind: 'discover_nichedb',
        payload: { ...payload, campaignId, collections, since: next, everyMs, limit },
        delayMs: everyMs,
        // One outstanding next run per campaign. The dedupe index covers
        // running jobs too, and this job is still running under its own key,
        // so the next run takes the other of two keys: a run under `a`
        // queues `b`, a run under `b` queues `a`, and a second run started by
        // hand while a next is already pending finds the key taken.
        dedupeKey: nextDedupeKey(campaignId, still[0]?.dedupe_key ?? null),
      });
      rescheduled = result.queued;
    }
  }

  await emitEvent(deps.db, {
    workspaceId: job.workspaceId,
    campaignId,
    phase: 'discover',
    level: queued > 0 ? 'success' : 'info',
    message: `nichedb.dev: read ${read} items, ${hosts.size} sites, queued ${queued} to read${rescheduled ? `, again in ${Math.round(everyMs / 3_600_000)}h` : ''}`,
    detail: { read, candidates: hosts.size, queued, since, next, rescheduled },
  });

  return {
    campaignId,
    collections,
    read,
    candidates: hosts.size,
    queued,
    since,
    next,
    rescheduled,
  };
}
