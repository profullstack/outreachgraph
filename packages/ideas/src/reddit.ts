/**
 * Reading subreddits without Reddit: Reddit 403s every datacenter address, so
 * posts come from RSS Amplifier's subreddit mirror (`/r/<sub>.json`) and fall
 * back to the Arctic Shift archive, which answers anonymously but asks callers
 * to slow down (HTTP 422 "Timeout. Maybe slow down a bit") on back-to-back calls.
 */

export type Fetcher = (url: string) => Promise<unknown>;

export const FEED_BASE = 'https://rssamplifier.com';
export const ARCHIVE_BASE = 'https://arctic-shift.photon-reddit.com';

/** The subreddits where people ask for tools (business subs have almost none). */
export const DEFAULT_SUBS = [
  'SomebodyMakeThis',
  'AppIdeas',
  'AskTechnology',
  'software',
  'webapps',
  'androidapps',
  'iosapps',
  'macapps',
  'selfhosted',
  'productivity',
  'AskProgramming',
  'Lightbulb',
  'nocode',
  'SaaS',
  'SideProject',
  'smallbusiness',
];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const defaultFetch: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'outreachgraph-ideas/0.1' },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `${res.status}: ${text.slice(0, 120)}`);
  const body = text ? JSON.parse(text) : {};
  if (
    (body as { error?: string }).error &&
    /slow down/i.test(String((body as { error?: string }).error))
  )
    throw new HttpError(422, String((body as { error?: string }).error));
  return body;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every archive request waits `gapMs` since the last; told to slow down, it waits longer and retries once. */
export function pacedFetch(fetchJson: Fetcher, gapMs: number, archiveBase = ARCHIVE_BASE): Fetcher {
  let last = 0;
  const wait = async () => {
    const due = last + gapMs - Date.now();
    if (due > 0) await sleep(due);
    last = Date.now();
  };
  return async (url) => {
    if (!url.startsWith(archiveBase) || gapMs <= 0) return fetchJson(url);
    await wait();
    try {
      return await fetchJson(url);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 422 && status !== 429 && !/slow down/i.test((error as Error).message))
        throw error;
      await sleep(gapMs * 4);
      await wait();
      return fetchJson(url);
    }
  };
}

export interface FeedPost {
  id: string;
  sub: string;
  title: string;
  text: string;
  url: string;
  author: string;
  postedAt: string;
  score?: number;
  comments?: number;
}

interface ArchivePost {
  id?: string;
  title?: string;
  selftext?: string;
  author?: string;
  subreddit?: string;
  created_utc?: number;
  permalink?: string;
  score?: number;
  num_comments?: number;
}

const bareId = (id: unknown): string => String(id ?? '').replace(/^t3_/, '');
const bareUser = (name: unknown): string =>
  String(name ?? '')
    .replace(/^\/?u\//, '')
    .trim();
const dataOf = <T>(reply: unknown): T[] => {
  const data = (reply as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as T[]) : [];
};

const fromArchive = (post: ArchivePost, sub: string): FeedPost => ({
  id: bareId(post.id),
  sub: post.subreddit ?? sub,
  title: String(post.title ?? ''),
  text:
    post.selftext && post.selftext !== '[removed]' && post.selftext !== '[deleted]'
      ? post.selftext
      : '',
  url: post.permalink
    ? `https://www.reddit.com${post.permalink}`
    : `https://www.reddit.com/r/${sub}/comments/${bareId(post.id)}/`,
  author: bareUser(post.author),
  postedAt: new Date((post.created_utc ?? 0) * 1000).toISOString(),
  ...(typeof post.score === 'number' ? { score: post.score } : {}),
  ...(typeof post.num_comments === 'number' ? { comments: post.num_comments } : {}),
});

/** One subreddit's newest posts: RSS Amplifier first, the archive when it has nothing. */
export async function readSub(
  sub: string,
  fetchJson: Fetcher,
  bases = { feed: FEED_BASE, archive: ARCHIVE_BASE },
): Promise<{ posts: FeedPost[]; via: string; note?: string }> {
  let note: string | undefined;
  try {
    const feed = (await fetchJson(`${bases.feed}/r/${encodeURIComponent(sub)}.json?limit=100`)) as {
      items?: Array<{
        id?: string;
        title?: string;
        url?: string;
        summary?: string;
        content_text?: string;
        date_published?: string;
        authors?: Array<{ name?: string }>;
      }>;
    };
    const items = Array.isArray(feed?.items) ? feed.items : [];
    if (items.length)
      return {
        via: 'rssamplifier',
        posts: items
          .map((item) => ({
            id: bareId(item.id ?? /\/comments\/([a-z0-9]+)/i.exec(item.url ?? '')?.[1]),
            sub: /\/r\/([^/]+)\//.exec(item.url ?? '')?.[1] ?? sub,
            title: String(item.title ?? ''),
            text: String(item.content_text ?? item.summary ?? ''),
            url: String(item.url ?? ''),
            author: bareUser(item.authors?.[0]?.name),
            postedAt: item.date_published ?? new Date(0).toISOString(),
          }))
          .filter((post) => post.id && post.title),
      };
    note = `RSS Amplifier has not read r/${sub} yet`;
  } catch (error) {
    note =
      (error as { status?: number }).status === 404
        ? `r/${sub} is not in RSS Amplifier`
        : `RSS Amplifier: ${(error as Error).message}`;
  }
  const reply = await fetchJson(
    `${bases.archive}/api/posts/search?subreddit=${encodeURIComponent(sub)}&limit=100&sort=desc`,
  );
  return {
    posts: dataOf<ArchivePost>(reply)
      .map((post) => fromArchive(post, sub))
      .filter((post) => post.id && post.title),
    via: 'archive',
    note,
  };
}

/** Full archive records (full text, score, comments) for these post ids, 100 per request. */
export async function archivePosts(
  ids: string[],
  fetchJson: Fetcher,
  archiveBase = ARCHIVE_BASE,
): Promise<Map<string, ArchivePost>> {
  const found = new Map<string, ArchivePost>();
  for (let index = 0; index < ids.length; index += 100) {
    const page = ids.slice(index, index + 100);
    const reply = await fetchJson(
      `${archiveBase}/api/posts/ids?ids=${page.map(encodeURIComponent).join(',')}`,
    );
    for (const post of dataOf<ArchivePost>(reply)) if (post.id) found.set(bareId(post.id), post);
  }
  return found;
}

export type { ArchivePost };
