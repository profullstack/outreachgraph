/**
 * Campaign hubs: the handful of accounts a campaign's leads follow and reply to.
 *
 * On a conversational network (X, Bluesky, LinkedIn) the audience does not
 * gather in a group with a name. It gathers in the replies under a few
 * accounts everybody in it follows and answers, so those accounts are where a
 * reply reaches the leads. This reads, for each lead with a public handle:
 *
 *   Bluesky   who they follow (app.bsky.graph.getFollows) and whose posts
 *             they replied to in their recent feed. Both public, keyless.
 *   Mastodon  who they follow, through their own instance.
 *   X, LinkedIn  nothing can be read without an account. The leads' own
 *             handles are listed as hubs to watch by hand.
 *
 * A hub needs at least `minLeads` different leads behind it, so one lead's
 * favourite account is not a hub. Score = leads following + 2 x leads that
 * replied (a reply is the stronger signal). The ranking is stored whole per
 * campaign and recomputed on request; myna (`myna outreachgraph hubs`) reads
 * it, watches the hubs and drafts replies a person approves. Nothing here
 * posts or follows anyone.
 */

import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';

const BSKY = 'https://api.bsky.app';
/** The default follow of every Bluesky account says nothing about the audience. */
const IGNORED = new Set(['bsky.app']);
const READABLE = new Set(['bluesky', 'mastodon']);

export interface CampaignHub {
  readonly network: string;
  readonly handle: string;
  readonly displayName?: string | undefined;
  readonly url?: string | undefined;
  readonly score: number;
  readonly followedBy: number;
  readonly repliedBy: number;
  /** A lead's own handle on a network whose graph cannot be read: watch it by hand. */
  readonly leadHub?: boolean | undefined;
  readonly why: string;
}

export interface CampaignHubs {
  readonly campaign: { readonly id: string; readonly name: string };
  readonly product?:
    | { readonly name: string; readonly url?: string | null; readonly about?: string | null }
    | undefined;
  /** People in the campaign. */
  readonly leads: number;
  /** Of them, with a handle on X, Bluesky, Mastodon or LinkedIn. */
  readonly handles: number;
  /** Of those, whose follows or replies were read. */
  readonly read: number;
  readonly hubs: readonly CampaignHub[];
  readonly failures: readonly { readonly handle: string; readonly reason: string }[];
  readonly computedAt: string | null;
}

export interface HubOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  /** Leads whose graphs are read, at most. */
  readonly maxLeads?: number | undefined;
  /** Different leads a hub needs behind it. */
  readonly minLeads?: number | undefined;
  /** Hubs kept. */
  readonly limit?: number | undefined;
  /** Pause between two requests to one network. Tests pass 0. */
  readonly gapMs?: number | undefined;
}

export class CampaignNotFoundError extends Error {
  constructor() {
    super('no such campaign in this workspace');
    this.name = 'CampaignNotFoundError';
  }
}

interface Lead {
  readonly personId: string;
  readonly network: string;
  readonly handle: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'OutreachGraph/1 (+https://outreachgraph.com)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
  return response.json();
}

interface Seen {
  network: string;
  handle: string;
  displayName?: string | undefined;
  url?: string | undefined;
  followers: Set<string>;
  repliers: Set<string>;
}

/** Who one Bluesky lead follows, and whose posts they answered. */
async function readBluesky(fetchImpl: typeof fetch, handle: string, gapMs: number) {
  const follows: { handle: string; displayName?: string | undefined }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page += 1) {
    const reply = (await getJson(
      fetchImpl,
      `${BSKY}/xrpc/app.bsky.graph.getFollows?actor=${encodeURIComponent(handle)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    )) as { follows?: { handle?: string; displayName?: string }[]; cursor?: string };
    for (const f of reply.follows ?? [])
      if (f.handle) follows.push({ handle: f.handle, displayName: f.displayName || undefined });
    cursor = reply.cursor;
    if (!cursor) break;
    if (gapMs) await sleep(gapMs);
  }
  if (gapMs) await sleep(gapMs);
  const feed = (await getJson(
    fetchImpl,
    `${BSKY}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&filter=posts_with_replies&limit=50`,
  )) as {
    feed?: { reply?: { parent?: { author?: { handle?: string; displayName?: string } } } }[];
  };
  const replied: { handle: string; displayName?: string | undefined }[] = [];
  for (const item of feed.feed ?? []) {
    const author = item.reply?.parent?.author;
    if (author?.handle)
      replied.push({ handle: author.handle, displayName: author.displayName || undefined });
  }
  return { follows, replied };
}

/** Who one Mastodon lead follows, read from their own instance. */
async function readMastodon(fetchImpl: typeof fetch, handle: string) {
  const [user, host] = handle.replace(/^@/, '').split('@');
  if (!user || !host) throw new Error('needs user@host');
  const account = (await getJson(
    fetchImpl,
    `https://${host}/api/v1/accounts/lookup?acct=${encodeURIComponent(user)}`,
  )) as { id?: string };
  if (!account.id) throw new Error('not found');
  const following = (await getJson(
    fetchImpl,
    `https://${host}/api/v1/accounts/${encodeURIComponent(account.id)}/following?limit=80`,
  )) as { acct?: string; display_name?: string; url?: string }[];
  return (Array.isArray(following) ? following : [])
    .filter((a) => a.acct)
    .map((a) => ({
      // A local account's acct has no host; theirs is the lead's instance.
      handle: a.acct!.includes('@') ? a.acct! : `${a.acct}@${host}`,
      displayName: a.display_name || undefined,
      url: a.url,
    }));
}

const profileUrl = (network: string, handle: string): string | undefined => {
  if (network === 'bluesky') return `https://bsky.app/profile/${handle}`;
  if (network === 'x') return `https://x.com/${handle}`;
  if (network === 'linkedin') return `https://www.linkedin.com/in/${handle}`;
  const [user, host] = handle.split('@');
  return network === 'mastodon' && user && host ? `https://${host}/@${user}` : undefined;
};

/** Rank the hubs from what was read. Pure, exported for the test. */
export function rankHubs(
  seen: Iterable<Seen>,
  options: { minLeads: number; readCount: number; limit: number },
): CampaignHub[] {
  const out: CampaignHub[] = [];
  for (const hub of seen) {
    const behind = new Set([...hub.followers, ...hub.repliers]).size;
    if (behind < options.minLeads) continue;
    const followedBy = hub.followers.size;
    const repliedBy = hub.repliers.size;
    const parts = [
      followedBy ? `followed by ${followedBy} of ${options.readCount} leads` : '',
      repliedBy ? `${repliedBy} replied to it` : '',
    ].filter(Boolean);
    out.push({
      network: hub.network,
      handle: hub.handle,
      ...(hub.displayName ? { displayName: hub.displayName } : {}),
      url: hub.url ?? profileUrl(hub.network, hub.handle),
      score: followedBy + 2 * repliedBy,
      followedBy,
      repliedBy,
      why: parts.join(', '),
    });
  }
  return out
    .sort(
      (a, b) => b.score - a.score || b.repliedBy - a.repliedBy || a.handle.localeCompare(b.handle),
    )
    .slice(0, options.limit);
}

async function campaignOf(db: Client, workspaceId: string, campaignId: string) {
  const row = await queryOne<{ id: string; name: string; offering_id: string | null }>(
    db,
    'SELECT id, name, offering_id FROM campaigns WHERE workspace_id = ? AND id = ?',
    [workspaceId, campaignId],
  );
  if (!row) throw new CampaignNotFoundError();
  const product = row.offering_id
    ? await queryOne<{ name: string; url: string | null; description: string | null }>(
        db,
        'SELECT name, url, description FROM offerings WHERE workspace_id = ? AND id = ?',
        [workspaceId, row.offering_id],
      )
    : undefined;
  return {
    campaign: { id: row.id, name: row.name },
    product: product
      ? { name: product.name, url: product.url, about: product.description }
      : undefined,
  };
}

/** The last stored ranking, or an empty one with computedAt null. */
export async function getCampaignHubs(
  db: Client,
  workspaceId: string,
  campaignId: string,
): Promise<CampaignHubs> {
  const { campaign, product } = await campaignOf(db, workspaceId, campaignId);
  const row = await queryOne<{ result_json: string }>(
    db,
    'SELECT result_json FROM campaign_hubs WHERE workspace_id = ? AND campaign_id = ?',
    [workspaceId, campaignId],
  );
  if (row) {
    const stored = JSON.parse(row.result_json) as CampaignHubs;
    return { ...stored, campaign, product };
  }
  return {
    campaign,
    product,
    leads: 0,
    handles: 0,
    read: 0,
    hubs: [],
    failures: [],
    computedAt: null,
  };
}

/**
 * Read the leads' public graphs, rank the hubs and store the ranking. Takes
 * about a second per Bluesky lead.
 */
export async function computeCampaignHubs(
  db: Client,
  workspaceId: string,
  campaignId: string,
  options: HubOptions = {},
): Promise<CampaignHubs> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const gapMs = options.gapMs ?? 250;
  const maxLeads = options.maxLeads ?? 60;
  const { campaign, product } = await campaignOf(db, workspaceId, campaignId);

  const total = await queryOne<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM campaign_people WHERE workspace_id = ? AND campaign_id = ?',
    [workspaceId, campaignId],
  );
  const rows = await queryAll<{
    person_id: string;
    network: string;
    handle: string | null;
    confidence: number;
  }>(
    db,
    `SELECT s.person_id, s.network, s.handle, s.confidence
       FROM campaign_people cp JOIN social_identities s ON s.person_id = cp.person_id
      WHERE cp.workspace_id = ? AND cp.campaign_id = ?
        AND s.network IN ('bluesky', 'mastodon', 'x', 'linkedin') AND s.confidence >= 0.6
        AND s.handle IS NOT NULL AND s.handle <> ''
      ORDER BY s.confidence DESC`,
    [workspaceId, campaignId],
  );
  const leads: Lead[] = [];
  const keys = new Set<string>();
  for (const row of rows) {
    const handle = row.handle!.trim().replace(/^@/, '');
    // A LinkedIn "company" slug is a page, not a person whose feed anyone follows.
    if (row.network === 'linkedin' && handle === 'company') continue;
    const key = `${row.network}:${handle.toLowerCase()}`;
    if (keys.has(key)) continue;
    keys.add(key);
    leads.push({ personId: row.person_id, network: row.network, handle });
  }

  const seen = new Map<string, Seen>();
  const note = (network: string, handle: string, displayName?: string, url?: string): Seen => {
    const key = `${network}:${handle.toLowerCase()}`;
    let hub = seen.get(key);
    if (!hub) {
      hub = { network, handle, displayName, url, followers: new Set(), repliers: new Set() };
      seen.set(key, hub);
    }
    hub.displayName ??= displayName;
    return hub;
  };

  const failures: { handle: string; reason: string }[] = [];
  let read = 0;
  for (const lead of leads.filter((l) => READABLE.has(l.network)).slice(0, maxLeads)) {
    const self = lead.handle.toLowerCase();
    try {
      if (lead.network === 'bluesky') {
        const { follows, replied } = await readBluesky(fetchImpl, lead.handle, gapMs);
        for (const f of follows)
          if (!IGNORED.has(f.handle) && f.handle.toLowerCase() !== self)
            note('bluesky', f.handle, f.displayName).followers.add(lead.personId);
        for (const r of replied)
          if (!IGNORED.has(r.handle) && r.handle.toLowerCase() !== self)
            note('bluesky', r.handle, r.displayName).repliers.add(lead.personId);
      } else {
        for (const f of await readMastodon(fetchImpl, lead.handle)) {
          if (f.handle.toLowerCase() !== self)
            note('mastodon', f.handle, f.displayName, f.url).followers.add(lead.personId);
        }
      }
      read += 1;
    } catch (error) {
      failures.push({
        handle: `${lead.network}:${lead.handle}`,
        reason: (error as Error).message.slice(0, 160),
      });
    }
    if (gapMs) await sleep(gapMs);
  }

  const limit = options.limit ?? 25;
  const ranked = rankHubs(seen.values(), {
    minLeads: options.minLeads ?? 2,
    readCount: read,
    limit,
  });
  // X and LinkedIn leads cannot be read, so they are the room themselves: listed after the ranked hubs.
  const manual: CampaignHub[] = leads
    .filter((l) => !READABLE.has(l.network))
    .map((l) => ({
      network: l.network,
      handle: l.handle,
      url: profileUrl(l.network, l.handle),
      score: 0.5,
      followedBy: 0,
      repliedBy: 0,
      leadHub: true,
      why: `a lead on ${l.network === 'x' ? 'X' : 'LinkedIn'}; follows cannot be read without an account, watch by hand`,
    }));

  const result: CampaignHubs = {
    campaign,
    product,
    leads: Number(total?.n ?? 0),
    handles: leads.length,
    read,
    hubs: [...ranked, ...manual].slice(0, limit + manual.length),
    failures,
    computedAt: now(),
  };
  await db.execute({ sql: 'DELETE FROM campaign_hubs WHERE campaign_id = ?', args: [campaignId] });
  await db.execute({
    sql: 'INSERT INTO campaign_hubs (campaign_id, workspace_id, computed_at, result_json) VALUES (?, ?, ?, ?)',
    args: [campaignId, workspaceId, result.computedAt, JSON.stringify(result)],
  });
  return result;
}
