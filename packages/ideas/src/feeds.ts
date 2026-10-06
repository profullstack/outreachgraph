/**
 * Ideas from writing, not only from Reddit: blogs, newsletters, podcasts and
 * Hacker News, read through RSS Amplifier's directory (`/api/feeds/<slug>`).
 *
 * A feed plays one of three parts:
 *
 *   asks      people asking for a tool, like a subreddit (Ask HN, r/bootstrapping).
 *             Read with the same ask patterns as Reddit.
 *   signals   founders and analysts writing about what sells: case studies with
 *             revenue ("built it for one customer, now $25K/month"), essays on
 *             what is worth building, idea lists. Each post that names a pain,
 *             a paying customer or a product to build becomes evidence for an idea.
 *   built     launches (Show HN). Never filed as demand: an idea that matches
 *             recent launches is crowded, and the score says so.
 *
 * Feed text is the directory's summary (about 300-400 characters); the title of
 * a case study usually carries the signal on its own.
 */

import { FEED_BASE, type Fetcher, type FeedPost } from './reddit';
import { extractWants } from './demand';

export type FeedRole = 'asks' | 'signals' | 'built';

export interface IdeaFeed {
  /** The feed's slug in RSS Amplifier. */
  readonly slug: string;
  readonly role: FeedRole;
  readonly name: string;
}

/**
 * Chosen 2026-10-06 by sweeping the directory for writing on what to build and
 * sell, kept to feeds that were `live`. levels.io is listed but failing there.
 */
export const DEFAULT_FEEDS: readonly IdeaFeed[] = [
  { slug: 'hnrss-org-7', role: 'asks', name: 'Ask HN' },
  { slug: 'reddit-com-36269', role: 'asks', name: 'r/bootstrapping' },
  { slug: 'hacker-news-show-hn', role: 'built', name: 'Show HN' },
  { slug: 'microsaasidea-substack-com', role: 'signals', name: 'Micro SaaS Idea' },
  { slug: 'indieniche-substack-com', role: 'signals', name: 'Indieniche' },
  { slug: 'starter-story-2', role: 'signals', name: 'Starter Story' },
  { slug: 'startup-acquisition-stories', role: 'signals', name: 'Startup Acquisition Stories' },
  { slug: 'sidebean', role: 'signals', name: 'Sidebean' },
  { slug: 'faingezicht-com', role: 'signals', name: "Startups I Didn't Start (Avy Faingezicht)" },
  { slug: 'mtlynch-io', role: 'signals', name: 'mtlynch.io' },
  { slug: 'siliconopera-com', role: 'signals', name: 'Silicon Opera' },
  { slug: 'hypolab-org', role: 'signals', name: 'Hypothesis Lab' },
  { slug: 'ashmaurya-com', role: 'signals', name: 'Ash Maurya' },
  { slug: 'metaist-com-blog', role: 'signals', name: 'Metaist' },
  { slug: 'flaviocopes-com', role: 'signals', name: 'Flavio Copes' },
  { slug: 'venturecurator-com', role: 'signals', name: 'Venture Curator' },
  { slug: 'ilusr-com', role: 'signals', name: 'Jeff Riggle' },
  { slug: 'jeangalea-com', role: 'signals', name: 'Jean Galea' },
];

const SLUG = /^[a-z0-9][a-z0-9-]{1,120}$/;

/** Feeds from user input: known slugs keep their role, new ones read as signals. */
export function cleanFeeds(feeds: ReadonlyArray<string | Partial<IdeaFeed>>): IdeaFeed[] {
  const out = new Map<string, IdeaFeed>();
  for (const entry of feeds) {
    const raw = typeof entry === 'string' ? { slug: entry } : entry;
    const slug = String(raw.slug ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?rssamplifier\.com\//, '')
      .replace(/\/.*$/, '');
    if (!SLUG.test(slug)) continue;
    const known = DEFAULT_FEEDS.find((f) => f.slug === slug);
    const role: FeedRole =
      raw.role === 'asks' || raw.role === 'signals' || raw.role === 'built'
        ? raw.role
        : (known?.role ?? 'signals');
    out.set(slug, { slug, role, name: String(raw.name ?? known?.name ?? slug).slice(0, 80) });
  }
  return [...out.values()];
}

const decode = (text: string): string =>
  text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&(rsquo|lsquo);/g, "'")
    .replace(/&(rdquo|ldquo|quot);/g, '"')
    .replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A stable post id: HN items by number, everything else by guid. */
export function feedPostId(slug: string, guid: string): string {
  const hn = /news\.ycombinator\.com\/item\?id=(\d+)/.exec(guid);
  if (hn) return `hn:${hn[1]}`;
  const reddit = /reddit\.com\/r\/[^/]+\/comments\/([a-z0-9]+)/i.exec(guid);
  if (reddit) return reddit[1]!;
  return `feed:${slug}:${guid}`.slice(0, 400);
}

/** One feed's recent posts from the RSS Amplifier directory. */
export async function readFeed(
  feed: IdeaFeed,
  fetchJson: Fetcher,
  base = FEED_BASE,
): Promise<{ posts: FeedPost[]; note?: string }> {
  const reply = (await fetchJson(`${base}/api/feeds/${encodeURIComponent(feed.slug)}`)) as {
    title?: string;
    freshness?: string;
    items?: Array<{
      guid?: string;
      url?: string;
      title?: string;
      summary?: string;
      author?: string;
      publishedAt?: string;
    }>;
  };
  const items = Array.isArray(reply?.items) ? reply.items : [];
  const posts = items
    .map((item) => {
      const guid = String(item.guid ?? item.url ?? '');
      return {
        id: feedPostId(feed.slug, guid),
        sub: feed.slug,
        title: decode(String(item.title ?? '')),
        text: decode(String(item.summary ?? '')),
        url: String(item.url ?? guid),
        // A blog's posts are one voice: the feed, not a crowd, so it counts once.
        author: String(item.author ?? '').trim() || `feed:${feed.slug}`,
        postedAt: item.publishedAt ?? new Date(0).toISOString(),
      } satisfies FeedPost;
    })
    .filter((post) => guidOk(post.id) && post.title);
  const freshness = reply?.freshness;
  return {
    posts,
    ...(!posts.length
      ? { note: `${feed.name}: no items${freshness ? ` (${freshness})` : ''}` }
      : freshness && freshness !== 'live'
        ? { note: `${feed.name} is ${freshness} in RSS Amplifier` }
        : {}),
  };
}

const guidOk = (id: string): boolean => id.length > 3 && !id.endsWith(':');

/* ----------------------------------------------------------- signals -- */

/** Money changing hands: revenue figures, paying customers, an acquisition. */
const REVENUE = [
  /\$\s?\d[\d,.]*\s?[kKmM]?\+?\s*(?:\/\s?(?:mo|month|yr|year)\b|mrr\b|arr\b|a month\b|per month\b|a year\b|per year\b|in (?:revenue|sales)\b|revenue\b)/i,
  /\b\d[\d,.]*\s*[kKmM]?\s*(?:mrr|arr)\b/i,
  /\b\d[\d,]*\+?\s+(?:paying (?:customers|users|teams|subscribers)|teams pay|customers pay)\b/i,
  // "Acquired" alone is everywhere ("customers acquired"): the business itself must be the one sold.
  /\b(?:(?:got|was|were|been|being|is|gets) acquired (?:by|for)|sold (?:it|my|our|the|his|her|their) (?:company|business|saas|app|startup|product)|exit(?:ed)? for \$|acquisition (?:story|of (?:my|our|his|her|their)))\b/i,
  /\bnow (?:makes|earns|generates|brings in)\b/i,
];

/** Someone would pay: the strongest thing an ask can say. */
export const PAYS =
  /\b(?:would|will|happy to|willing to|i'?d|gladly) (?:happily )?pay\b|\bpay (?:good money|for (?:this|it|that|a tool|an app|something))\b|\btake my money\b|\bshut up and take\b/i;

/** A pain or a product someone says should exist. */
const PAIN: Array<[weight: number, pattern: RegExp]> = [
  [0.7, /\bsomeone (?:should|needs to|has to) (?:build|make|create|start)\b/i],
  [0.7, /\bstartups? i didn'?t start\b/i],
  [0.6, /\bi wish (?:there (?:was|were)|someone|i had|i could find)\b/i],
  [0.6, /\bwhy (?:is there no|isn'?t there an?|doesn'?t (?:anyone|anything))\b/i],
  [
    0.6,
    /\b(?:built|made|wrote) (?:it|this|a tool|an app|something) (?:for (?:myself|one customer|my (?:own )?\w+)|because)\b/i,
  ],
  [0.55, /\b(?:couldn'?t|can'?t|could not) find (?:a|an|any) (?:tool|app|service|product|way)\b/i],
  [
    0.5,
    /\b(?:tired of|fed up with|frustrated (?:with|by)|annoyed (?:by|with|at)|hate (?:having to|that))\b/i,
  ],
  [
    0.5,
    /\b(?:idea|ideas) (?:worth building|to build|for (?:a )?(?:saas|startup|side project|micro ?saas))\b/i,
  ],
  [0.45, /\b(?:micro ?saas|side project|one-person business|bootstrapped)\b/i],
];

export interface SignalVerdict {
  /** 0..1, like an ask's confidence. */
  readonly score: number;
  readonly kind: 'revenue' | 'pain' | 'idea' | 'none';
  readonly wants: string[];
  /** The post shows people paying, or saying they would. */
  readonly paid: boolean;
  /** The revenue figure as written, when there is one. */
  readonly revenue?: string;
}

/** A case title as an idea: "He Built X for Y. It Now Makes $25K/Month." -> "X for Y". */
function titleIdea(title: string): string | undefined {
  const built =
    /\b(?:built|building|launched|made|created|started)\s+(?:a|an|this|his|her|their|my)?\s*(.{4,80}?)(?:[.!?,:;]|\s+(?:that|which|and|now|in|after|to)\s|$)/i.exec(
      title,
    );
  const want = built?.[1]?.trim();
  return want && want.split(/\s+/).length >= 2 ? want : undefined;
}

/** Does this post carry evidence for an idea worth building and selling? */
export function classifySignal(title: string, body = ''): SignalVerdict {
  const text = `${title}\n${body}`;
  const money = REVENUE.map((rx) => rx.exec(text)).find(Boolean);
  const pays = PAYS.test(text);
  let best: { weight: number; end: number } | undefined;
  for (const [weight, rx] of PAIN) {
    const m = rx.exec(text);
    if (m && (!best || weight > best.weight)) best = { weight, end: m.index + m[0].length };
  }
  const wants = [
    ...new Set(
      [
        titleIdea(title),
        ...(best && best.weight >= 0.5 ? extractWants(text, best.end, body) : []),
      ].filter((w): w is string => Boolean(w)),
    ),
  ].slice(0, 6);
  if (money) {
    return {
      score: Math.min(0.9, 0.6 + (best ? 0.15 : 0) + (wants.length ? 0.1 : 0)),
      kind: 'revenue',
      wants,
      paid: true,
      revenue: money[0].trim(),
    };
  }
  if (best) {
    return {
      score: Math.min(0.85, best.weight + (pays ? 0.15 : 0) + (wants.length ? 0.05 : 0)),
      kind: best.weight >= 0.5 ? 'pain' : 'idea',
      wants,
      paid: pays,
    };
  }
  return { score: pays ? 0.45 : 0, kind: 'none', wants, paid: pays };
}
