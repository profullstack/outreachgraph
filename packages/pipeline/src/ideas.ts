/**
 * The Idea Generator: Reddit demand -> ranked ideas -> "Build it" on chovy.com.
 *
 *   scan     read each subreddit (RSS Amplifier, then the Arctic Shift archive),
 *            keep posts that ask for a tool, let the model throw out pitches,
 *            and file each ask under the idea it matches.
 *   rank     an idea is as strong as the number of different people asking
 *            inside the window, then the attention their posts got.
 *   flag     an idea `build_at` people asked for becomes status 'build'.
 *   build    the API hands the idea's brief to chovy.com; this records it.
 *
 * Storage only and the scan itself; the schedule lives in the server's tick and
 * the hand-off HTTP call in the API, so both can be faked in tests.
 */

import {
  judgeAsks,
  judgeSignals,
  type AskJudgement,
  type SignalJudgement,
  type TextModel,
} from '@outreachgraph/ai';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { newId } from '@outreachgraph/domain';
import {
  archivePosts,
  bestIdea,
  classifyAsk,
  classifySignal,
  cleanFeeds,
  defaultFetch,
  demandScore,
  ideaTermsOf,
  pacedFetch,
  readFeed,
  readSub,
  rivalsFor,
  worthScore,
  DEFAULT_FEEDS,
  DEFAULT_SUBS,
  PAYS,
  type BuildBrief,
  type Fetcher,
  type FeedPost,
  type IdeaFeed,
  type IdeaRef,
  type WorthVerdict,
} from '@outreachgraph/ideas';

export const IDEA_STATUSES = ['watching', 'build', 'building', 'dismissed'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

const DAY_MS = 86_400_000;
const MIN_CONFIDENCE = 0.5;
const JUDGE_LIMIT = 30;
/** Launches kept per idea. */
const MAX_RIVALS = 20;

interface Launch {
  title: string;
  url: string;
  postedAt: string;
}

/* ------------------------------------------------------------- settings -- */

export interface IdeaScanSettings {
  readonly workspaceId: string;
  readonly subs: string[];
  /** RSS Amplifier feeds: Ask HN, case studies, essays, launches. */
  readonly feeds: IdeaFeed[];
  readonly enabled: boolean;
  readonly everyMinutes: number;
  readonly buildAt: number;
  readonly windowDays: number;
  readonly lastScannedAt?: string | undefined;
  readonly lastError?: string | undefined;
  readonly lastResult?: IdeaScanResult | undefined;
}

interface ScanRow {
  workspace_id: string;
  subs_json: string;
  feeds_json: string | null;
  enabled: number;
  every_minutes: number;
  build_at: number;
  window_days: number;
  last_scanned_at: string | null;
  last_error: string | null;
  last_result_json: string | null;
}

const parse = <T>(json: string | null | undefined, fallback: T): T => {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
};

export const cleanSubs = (subs: readonly string[]): string[] => [
  ...new Set(
    subs.map((s) => s.trim().replace(/^\/?r\//i, '')).filter((s) => /^[A-Za-z0-9_]{2,21}$/.test(s)),
  ),
];

export async function getIdeaScan(db: Client, workspaceId: string): Promise<IdeaScanSettings> {
  const row = await queryOne<ScanRow>(db, 'SELECT * FROM idea_scans WHERE workspace_id = ?', [
    workspaceId,
  ]);
  if (!row)
    return {
      workspaceId,
      subs: [...DEFAULT_SUBS],
      feeds: [...DEFAULT_FEEDS],
      enabled: true,
      everyMinutes: 360,
      buildAt: 5,
      windowDays: 60,
    };
  return {
    workspaceId,
    subs: parse<string[]>(row.subs_json, [...DEFAULT_SUBS]),
    feeds: row.feeds_json ? cleanFeeds(parse<IdeaFeed[]>(row.feeds_json, [])) : [...DEFAULT_FEEDS],
    enabled: Number(row.enabled) === 1,
    everyMinutes: Number(row.every_minutes),
    buildAt: Number(row.build_at),
    windowDays: Number(row.window_days),
    ...(row.last_scanned_at ? { lastScannedAt: row.last_scanned_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.last_result_json
      ? { lastResult: parse<IdeaScanResult | undefined>(row.last_result_json, undefined) }
      : {}),
  };
}

export async function saveIdeaScan(
  db: Client,
  workspaceId: string,
  patch: Partial<
    Pick<IdeaScanSettings, 'subs' | 'enabled' | 'everyMinutes' | 'buildAt' | 'windowDays'> & {
      feeds: ReadonlyArray<string | Partial<IdeaFeed>>;
    }
  >,
): Promise<IdeaScanSettings> {
  const cur = await getIdeaScan(db, workspaceId);
  const next = {
    subs: patch.subs ? cleanSubs(patch.subs) : cur.subs,
    feeds: patch.feeds ? cleanFeeds(patch.feeds) : cur.feeds,
    enabled: patch.enabled ?? cur.enabled,
    everyMinutes: Math.min(Math.max(patch.everyMinutes ?? cur.everyMinutes, 30), 10_080),
    buildAt: Math.min(Math.max(patch.buildAt ?? cur.buildAt, 1), 100),
    windowDays: Math.min(Math.max(patch.windowDays ?? cur.windowDays, 1), 365),
  };
  const at = now();
  await db.execute({
    sql: `INSERT INTO idea_scans (workspace_id, subs_json, feeds_json, enabled, every_minutes, build_at, window_days, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id) DO UPDATE SET subs_json = excluded.subs_json, feeds_json = excluded.feeds_json, enabled = excluded.enabled,
            every_minutes = excluded.every_minutes, build_at = excluded.build_at, window_days = excluded.window_days,
            updated_at = excluded.updated_at`,
    args: [
      workspaceId,
      JSON.stringify(next.subs),
      JSON.stringify(next.feeds),
      next.enabled ? 1 : 0,
      next.everyMinutes,
      next.buildAt,
      next.windowDays,
      at,
      at,
    ],
  });
  return getIdeaScan(db, workspaceId);
}

/** Workspaces with scanning on whose last scan is older than their interval. */
export async function workspacesDueForIdeaScan(db: Client, at = new Date()): Promise<string[]> {
  const rows = await queryAll<{
    workspace_id: string;
    every_minutes: number;
    last_scanned_at: string | null;
  }>(
    db,
    'SELECT workspace_id, every_minutes, last_scanned_at FROM idea_scans WHERE enabled = 1',
    [],
  );
  return rows
    .filter(
      (r) =>
        !r.last_scanned_at ||
        at.getTime() - Date.parse(r.last_scanned_at) >= Number(r.every_minutes) * 60_000,
    )
    .map((r) => r.workspace_id);
}

/* -------------------------------------------------------------------- scan -- */

export interface IdeaScanDeps {
  readonly db: Client;
  /** The judge. Absent: pattern verdicts only, and the result says so. */
  readonly model?: TextModel | undefined;
  readonly fetchJson?: Fetcher | undefined;
  /** Least time between two archive requests. Tests pass 0. */
  readonly archiveGapMs?: number | undefined;
  readonly now?: Date | undefined;
}

export interface IdeaScanResult {
  readonly at: string;
  readonly read: number;
  readonly found: number;
  readonly rejected: number;
  readonly deferred: number;
  readonly judged: boolean;
  readonly flagged: string[];
  readonly sources: Array<{ sub: string; via: string; posts: number; note?: string }>;
  readonly skipped: string[];
}

async function seenIds(db: Client, workspaceId: string, ids: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const page = ids.slice(i, i + 200);
    if (!page.length) continue;
    const rows = await queryAll<{ post_id: string }>(
      db,
      `SELECT post_id FROM idea_seen WHERE workspace_id = ? AND post_id IN (${page.map(() => '?').join(',')})`,
      [workspaceId, ...page],
    );
    for (const r of rows) seen.add(r.post_id);
  }
  return seen;
}

async function markSeen(db: Client, workspaceId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const at = now();
  await db.batch(
    ids.map((id) => ({
      sql: 'INSERT INTO idea_seen (workspace_id, post_id, seen_at) VALUES (?, ?, ?) ON CONFLICT (workspace_id, post_id) DO NOTHING',
      args: [workspaceId, id, at],
    })),
  );
}

interface IdeaRow {
  id: string;
  workspace_id: string;
  label: string;
  named: number;
  terms_json: string;
  rivals_json: string | null;
  status: IdeaStatus;
  first_at: string;
  last_at: string;
  flagged_at: string | null;
  handoff_url: string | null;
  handoff_at: string | null;
  handoff_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface AskRow {
  id: string;
  idea_id: string;
  post_id: string;
  sub: string;
  title: string;
  body: string | null;
  url: string;
  author: string;
  posted_at: string;
  confidence: number;
  kind: string;
  wants_json: string;
  label: string | null;
  judged: number;
  post_score: number | null;
  comments: number | null;
  source: string | null;
  paid: number | null;
  revenue: string | null;
}

/** File one ask: into the idea it matches, or a new one. Returns the idea id. */
async function fileAsk(
  db: Client,
  workspaceId: string,
  ideas: IdeaRef[],
  ask: { title: string; wants: string[]; label: string | null; postedAt: string },
): Promise<string> {
  const match = bestIdea(ideas, ask);
  if (match) return match.id;
  const id = newId('idea');
  const at = now();
  const terms = ideaTermsOf([ask]);
  await db.execute({
    sql: `INSERT INTO ideas (id, workspace_id, label, named, terms_json, status, first_at, last_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'watching', ?, ?, ?, ?)`,
    args: [
      id,
      workspaceId,
      (ask.label || ask.wants[0] || ask.title).slice(0, 80),
      ask.label ? 1 : 0,
      JSON.stringify(terms),
      ask.postedAt,
      ask.postedAt,
      at,
      at,
    ],
  });
  ideas.push({
    id,
    label: ask.label || ask.wants[0] || ask.title,
    named: Boolean(ask.label),
    terms,
  });
  return id;
}

/** Recompute an idea's shared terms and date range from its asks. */
async function refreshIdea(db: Client, ideaId: string, ideas: IdeaRef[]): Promise<void> {
  const asks = await queryAll<{
    title: string;
    wants_json: string;
    label: string | null;
    posted_at: string;
  }>(db, 'SELECT title, wants_json, label, posted_at FROM idea_asks WHERE idea_id = ?', [ideaId]);
  if (!asks.length) return;
  const terms = ideaTermsOf(
    asks.map((a) => ({ title: a.title, wants: parse<string[]>(a.wants_json, []), label: a.label })),
  );
  const dates = asks.map((a) => a.posted_at).sort();
  await db.execute({
    sql: 'UPDATE ideas SET terms_json = ?, first_at = ?, last_at = ?, updated_at = ? WHERE id = ?',
    args: [JSON.stringify(terms), dates[0]!, dates[dates.length - 1]!, now(), ideaId],
  });
  const ref = ideas.find((i) => i.id === ideaId);
  if (ref) ref.terms = terms;
}

/** A post that may be evidence for an idea, from a subreddit or a feed. */
interface Candidate {
  post: FeedPost;
  source: 'reddit' | 'feed';
  role: 'asks' | 'signals';
  verdict: { score: number; kind: string; wants: string[] };
  body: string;
  score?: number | undefined;
  comments?: number | undefined;
  paid: boolean;
  revenue?: string | undefined;
}

interface Judgement {
  keep: boolean;
  wants: readonly string[];
  label: string;
  paid?: boolean;
}

/**
 * Read every subreddit and feed, keep the asks and signals, file them under
 * ideas, note matching launches, flag the ones enough people asked for. Every
 * post read is marked seen, kept or not, except the candidates the judge had
 * no time for, which wait for the next scan. Launches are never marked seen:
 * they are re-read each scan to keep the rival counts current.
 *
 * Naming only subreddits (or only feeds) scans just those.
 */
export async function scanIdeas(
  deps: IdeaScanDeps,
  input: {
    workspaceId: string;
    subs?: string[];
    feeds?: ReadonlyArray<string | Partial<IdeaFeed>>;
  },
): Promise<IdeaScanResult> {
  const { db } = deps;
  const ws = input.workspaceId;
  const settings = await getIdeaScan(db, ws);
  const at = deps.now ?? new Date();
  const oldest = at.getTime() - settings.windowDays * DAY_MS;
  const fetchJson = pacedFetch(deps.fetchJson ?? defaultFetch, deps.archiveGapMs ?? 2_500);
  const named = Boolean(input.subs || input.feeds);
  const subs = input.subs ? cleanSubs(input.subs) : named ? [] : settings.subs;
  const feeds = input.feeds ? cleanFeeds(input.feeds) : named ? [] : settings.feeds;
  const sources: IdeaScanResult['sources'] = [];
  const skipped: string[] = [];
  let read = 0;

  // 1. Candidates: unseen, recent, and shaped like an ask or a signal.
  const candidates: Candidate[] = [];
  const toMark: string[] = [];
  const launches: Launch[] = [];
  const consider = async (
    posts: FeedPost[],
    source: Candidate['source'],
    role: Candidate['role'],
  ) => {
    const seen = await seenIds(
      db,
      ws,
      posts.map((p) => p.id),
    );
    for (const post of posts) {
      if (seen.has(post.id) || toMark.includes(post.id)) continue;
      toMark.push(post.id);
      if (Date.parse(post.postedAt) < oldest) continue;
      if (role === 'signals') {
        const verdict = classifySignal(post.title, post.text);
        if (verdict.score >= MIN_CONFIDENCE)
          candidates.push({
            post,
            source,
            role,
            verdict,
            body: post.text,
            paid: verdict.paid,
            revenue: verdict.revenue,
          });
        continue;
      }
      const verdict = classifyAsk(post.title, post.text);
      // The mirror's text is cut short: give near misses a look at the full text.
      if (verdict.score >= MIN_CONFIDENCE - 0.1)
        candidates.push({
          post,
          source,
          role,
          verdict,
          body: post.text,
          score: post.score,
          comments: post.comments,
          paid: PAYS.test(`${post.title}\n${post.text}`),
        });
    }
  };

  for (const sub of subs) {
    let got: Awaited<ReturnType<typeof readSub>>;
    try {
      got = await readSub(sub, fetchJson);
    } catch (error) {
      skipped.push(`r/${sub}: ${(error as Error).message}`);
      continue;
    }
    sources.push({
      sub,
      via: got.via,
      posts: got.posts.length,
      ...(got.note ? { note: got.note } : {}),
    });
    read += got.posts.length;
    await consider(got.posts, 'reddit', 'asks');
  }

  for (const feed of feeds) {
    let got: Awaited<ReturnType<typeof readFeed>>;
    try {
      got = await readFeed(feed, fetchJson);
    } catch (error) {
      skipped.push(`${feed.name}: ${(error as Error).message}`);
      continue;
    }
    sources.push({
      sub: feed.slug,
      via: `feed:${feed.role}`,
      posts: got.posts.length,
      ...(got.note ? { note: got.note } : {}),
    });
    read += got.posts.length;
    if (feed.role === 'built') {
      for (const post of got.posts)
        if (Date.parse(post.postedAt) >= oldest)
          launches.push({ title: post.title, url: post.url, postedAt: post.postedAt });
      continue;
    }
    await consider(got.posts, 'feed', feed.role);
  }

  // 2. Full text and numbers from the archive, in one batch, for Reddit posts.
  let full = new Map<string, { selftext?: string; score?: number; num_comments?: number }>();
  const fromReddit = candidates.filter((c) => c.source === 'reddit').map((c) => c.post.id);
  if (fromReddit.length) {
    try {
      full = await archivePosts(fromReddit, fetchJson);
    } catch (error) {
      skipped.push(`archive: ${(error as Error).message}`);
    }
  }
  const kept = candidates
    .map((c): Candidate => {
      if (c.source !== 'reddit') return c;
      const record = full.get(c.post.id);
      const body =
        record?.selftext &&
        record.selftext.length > c.post.text.length &&
        record.selftext !== '[removed]'
          ? record.selftext
          : c.post.text;
      return {
        ...c,
        body,
        verdict: body === c.post.text ? c.verdict : classifyAsk(c.post.title, body),
        score: record?.score ?? c.post.score,
        comments: record?.num_comments ?? c.post.comments,
        paid: c.paid || PAYS.test(body),
      };
    })
    .filter((c) => c.verdict.score >= MIN_CONFIDENCE);

  // 3. The judges, ten at a time: one for asks, one for signals. What they
  //    have not got to waits for the next scan.
  const judgements = new Map<string, Judgement>();
  const judgedRoles = new Set<Candidate['role']>();
  let deferred = 0;
  const later = new Set<string>();
  const model = deps.model;
  if (model && kept.length) {
    const run = async (
      role: Candidate['role'],
      judge: (
        page: Array<{ id: string; title: string; text: string }>,
      ) => Promise<Array<Judgement & { id: string }>>,
    ) => {
      const list = kept.filter((k) => k.role === role);
      if (!list.length) return;
      for (const k of list.slice(JUDGE_LIMIT)) later.add(k.post.id);
      const before = judgements.size;
      try {
        for (let i = 0; i < Math.min(list.length, JUDGE_LIMIT); i += 10) {
          const page = list.slice(i, Math.min(i + 10, JUDGE_LIMIT));
          for (const j of await judge(
            page.map((k) => ({ id: k.post.id, title: k.post.title, text: k.body })),
          ))
            judgements.set(j.id, j);
        }
        if (judgements.size > before) judgedRoles.add(role);
        else skipped.push(`judge (${role}): no usable answer; kept the pattern verdicts`);
      } catch (error) {
        skipped.push(`judge (${role}): ${(error as Error).message}; kept the pattern verdicts`);
      }
    };
    await run('asks', async (page) =>
      (await judgeAsks(model, page)).map((j: AskJudgement) => ({
        id: j.id,
        keep: j.ask,
        wants: j.wants,
        label: j.label,
      })),
    );
    await run('signals', async (page) =>
      (await judgeSignals(model, page)).map((j: SignalJudgement) => ({
        id: j.id,
        keep: j.idea,
        wants: j.wants,
        label: j.label,
        paid: j.paid,
      })),
    );
    deferred += later.size;
  }
  const judged = judgedRoles.size > 0;

  // 4. File them.
  const ideas: IdeaRef[] = (
    await queryAll<IdeaRow>(db, 'SELECT * FROM ideas WHERE workspace_id = ?', [ws])
  ).map((r) => ({
    id: r.id,
    label: r.label,
    named: Number(r.named) === 1,
    terms: parse<string[]>(r.terms_json, []),
  }));
  let found = 0;
  let rejected = 0;
  const touched = new Set<string>();
  for (const k of kept) {
    if (later.has(k.post.id)) continue;
    const j = judgements.get(k.post.id);
    if (j && !j.keep) {
      rejected++;
      continue;
    }
    if (judgedRoles.has(k.role) && !j) {
      // The judge ran but skipped this one: judge it next time, not now.
      later.add(k.post.id);
      deferred++;
      continue;
    }
    const wants = j?.wants.length ? [...j.wants] : k.verdict.wants;
    const label = j?.label || null;
    const paid = k.paid || j?.paid === true;
    const ideaId = await fileAsk(db, ws, ideas, {
      title: k.post.title,
      wants,
      label,
      postedAt: k.post.postedAt,
    });
    await db.execute({
      sql: `INSERT INTO idea_asks (id, workspace_id, idea_id, post_id, sub, title, body, url, author, posted_at, confidence, kind,
              wants_json, label, judged, post_score, comments, source, paid, revenue, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (workspace_id, post_id) DO NOTHING`,
      args: [
        newId('ideaAsk'),
        ws,
        ideaId,
        k.post.id,
        k.post.sub,
        k.post.title.slice(0, 300),
        k.body.slice(0, 4000),
        k.post.url,
        k.post.author || '[unknown]',
        k.post.postedAt,
        k.verdict.score,
        k.verdict.kind,
        JSON.stringify(wants),
        label,
        j ? 1 : 0,
        k.score ?? null,
        k.comments ?? null,
        k.source,
        paid ? 1 : 0,
        k.revenue ?? null,
        now(),
      ],
    });
    touched.add(ideaId);
    found++;
  }
  for (const id of touched) await refreshIdea(db, id, ideas);
  await markSeen(
    db,
    ws,
    toMark.filter((id) => !later.has(id)),
  );

  // 4b. Launches that match an idea are its competition.
  if (launches.length) {
    const rows = await queryAll<{ id: string; rivals_json: string }>(
      db,
      "SELECT id, rivals_json FROM ideas WHERE workspace_id = ? AND status <> 'dismissed'",
      [ws],
    );
    for (const row of rows) {
      const ref = ideas.find((i) => i.id === row.id);
      if (!ref) continue;
      const matched = rivalsFor(ref, launches) as Launch[];
      if (!matched.length) continue;
      const current = parse<Launch[]>(row.rivals_json, []);
      const merged = [
        ...new Map([...current, ...matched].map((l) => [l.url, l] as const)).values(),
      ].slice(-MAX_RIVALS);
      if (
        merged.length === current.length &&
        matched.every((m) => current.some((c) => c.url === m.url))
      )
        continue;
      await db.execute({
        sql: 'UPDATE ideas SET rivals_json = ?, updated_at = ? WHERE id = ?',
        args: [JSON.stringify(merged), now(), row.id],
      });
    }
  }

  // 5. Flag what enough different people asked for.
  const flagged: string[] = [];
  for (const summary of await listIdeas(db, ws, {
    status: 'watching',
    windowDays: settings.windowDays,
    now: at,
  })) {
    if (summary.askers < settings.buildAt) continue;
    await db.execute({
      sql: "UPDATE ideas SET status = 'build', flagged_at = ?, updated_at = ? WHERE id = ? AND status = 'watching'",
      args: [now(), now(), summary.id],
    });
    flagged.push(summary.id);
  }

  const result: IdeaScanResult = {
    at: at.toISOString(),
    read,
    found,
    rejected,
    deferred,
    judged,
    flagged,
    sources,
    skipped,
  };
  await db.execute({
    sql: `INSERT INTO idea_scans (workspace_id, subs_json, created_at, updated_at, last_scanned_at, last_result_json, last_error)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id) DO UPDATE SET last_scanned_at = excluded.last_scanned_at,
            last_result_json = excluded.last_result_json, last_error = excluded.last_error, updated_at = excluded.updated_at`,
    args: [
      ws,
      JSON.stringify(settings.subs),
      now(),
      now(),
      at.toISOString(),
      JSON.stringify(result),
      sources.length ? null : skipped.join('; ').slice(0, 500) || null,
    ],
  });
  return result;
}

/* -------------------------------------------------------------------- read -- */

export interface IdeaAsk {
  readonly id: string;
  readonly postId: string;
  readonly sub: string;
  readonly title: string;
  readonly body?: string | undefined;
  readonly url: string;
  readonly author: string;
  readonly postedAt: string;
  readonly confidence: number;
  readonly kind: string;
  readonly wants: string[];
  readonly label?: string | undefined;
  readonly judged: boolean;
  readonly postScore?: number | undefined;
  readonly comments?: number | undefined;
  /** 'reddit' or 'feed'. */
  readonly source: string;
  /** The post shows people paying, or saying they would. */
  readonly paid: boolean;
  readonly revenue?: string | undefined;
}

export interface IdeaSummary {
  readonly id: string;
  readonly label: string;
  readonly status: IdeaStatus;
  readonly askers: number;
  readonly asks: number;
  readonly demand: number;
  /** Demand plus proof of payment, reach across sources, and competition. */
  readonly worth: number;
  readonly verdict: WorthVerdict;
  /** Distinct sources showing money changing hands, or people saying they would pay. */
  readonly paid: number;
  /** Revenue figures quoted by its sources ("$25K/month"). */
  readonly revenue: string[];
  /** Subreddits it was asked about in. */
  readonly subs: string[];
  /** Feeds (Ask HN, newsletters, blogs) it came up in, by name. */
  readonly feeds: string[];
  /** Recent launches that match it. */
  readonly rivals: Array<{ title: string; url: string; postedAt: string }>;
  readonly wants: string[];
  readonly firstAt: string;
  readonly lastAt: string;
  readonly flaggedAt?: string | undefined;
  readonly handoffUrl?: string | undefined;
  readonly handoffAt?: string | undefined;
  readonly notes?: string | undefined;
}

const askFrom = (r: AskRow, withBody = false): IdeaAsk => ({
  id: r.id,
  postId: r.post_id,
  sub: r.sub,
  title: r.title,
  ...(withBody && r.body ? { body: r.body } : {}),
  url: r.url,
  author: r.author,
  postedAt: r.posted_at,
  confidence: Number(r.confidence),
  kind: r.kind,
  wants: parse<string[]>(r.wants_json, []),
  ...(r.label ? { label: r.label } : {}),
  judged: Number(r.judged) === 1,
  ...(r.post_score != null ? { postScore: Number(r.post_score) } : {}),
  ...(r.comments != null ? { comments: Number(r.comments) } : {}),
  source: r.source ?? 'reddit',
  paid: Number(r.paid ?? 0) === 1,
  ...(r.revenue ? { revenue: r.revenue } : {}),
});

/** A feed's display name: the default list's, else its slug. */
const feedName = (slug: string): string => DEFAULT_FEEDS.find((f) => f.slug === slug)?.name ?? slug;

/** The wants most often asked for across an idea's asks. */
function topWants(asks: IdeaAsk[], n = 8): string[] {
  const counts = new Map<string, { text: string; n: number }>();
  for (const a of asks)
    for (const w of a.wants) {
      const key = w.toLowerCase();
      const cur = counts.get(key) ?? { text: w, n: 0 };
      cur.n++;
      counts.set(key, cur);
    }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, n)
    .map((c) => c.text);
}

function summarize(row: IdeaRow, asks: IdeaAsk[], windowDays: number, at: Date): IdeaSummary {
  const since = at.getTime() - windowDays * DAY_MS;
  const inWindow = asks.filter((a) => Date.parse(a.postedAt) >= since);
  const { askers, demand } = demandScore(
    inWindow.map((a) => ({
      author: a.author,
      score: a.postScore ?? null,
      comments: a.comments ?? null,
    })),
  );
  const rivals = parse<Launch[]>(row.rivals_json, []).filter(
    (l) => Date.parse(l.postedAt) >= since,
  );
  const worth = worthScore({
    demand: inWindow.length ? demand : 0,
    askers: inWindow.length ? askers : 0,
    sources: inWindow.map((a) => a.sub),
    paidSources: inWindow.filter((a) => a.paid).map((a) => a.sub),
    rivals: rivals.length,
  });
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    askers: inWindow.length ? askers : 0,
    asks: asks.length,
    demand: inWindow.length ? demand : 0,
    worth: worth.worth,
    verdict: worth.verdict,
    paid: worth.paid,
    revenue: [...new Set(asks.flatMap((a) => (a.revenue ? [a.revenue] : [])))].slice(0, 5),
    subs: [...new Set(asks.filter((a) => a.source === 'reddit').map((a) => a.sub))],
    feeds: [...new Set(asks.filter((a) => a.source === 'feed').map((a) => feedName(a.sub)))],
    rivals,
    wants: topWants(asks),
    firstAt: row.first_at,
    lastAt: row.last_at,
    ...(row.flagged_at ? { flaggedAt: row.flagged_at } : {}),
    ...(row.handoff_url ? { handoffUrl: row.handoff_url } : {}),
    ...(row.handoff_at ? { handoffAt: row.handoff_at } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
  };
}

async function asksFor(
  db: Client,
  ideaIds: string[],
  withBody = false,
): Promise<Map<string, IdeaAsk[]>> {
  const out = new Map<string, IdeaAsk[]>();
  for (let i = 0; i < ideaIds.length; i += 200) {
    const page = ideaIds.slice(i, i + 200);
    if (!page.length) continue;
    const rows = await queryAll<AskRow>(
      db,
      `SELECT * FROM idea_asks WHERE idea_id IN (${page.map(() => '?').join(',')}) ORDER BY posted_at DESC`,
      page,
    );
    for (const r of rows) {
      const list = out.get(r.idea_id) ?? [];
      list.push(askFrom(r, withBody));
      out.set(r.idea_id, list);
    }
  }
  return out;
}

/** Ideas, most worth building first. */
export async function listIdeas(
  db: Client,
  workspaceId: string,
  options: {
    status?: IdeaStatus | undefined;
    windowDays?: number | undefined;
    limit?: number | undefined;
    now?: Date | undefined;
  } = {},
): Promise<IdeaSummary[]> {
  const windowDays = options.windowDays ?? (await getIdeaScan(db, workspaceId)).windowDays;
  const where = ['workspace_id = ?'];
  const args: string[] = [workspaceId];
  if (options.status) {
    where.push('status = ?');
    args.push(options.status);
  } else {
    where.push("status <> 'dismissed'");
  }
  const rows = await queryAll<IdeaRow>(
    db,
    `SELECT * FROM ideas WHERE ${where.join(' AND ')} ORDER BY last_at DESC LIMIT 1000`,
    args,
  );
  const asks = await asksFor(
    db,
    rows.map((r) => r.id),
  );
  const at = options.now ?? new Date();
  return rows
    .map((r) => summarize(r, asks.get(r.id) ?? [], windowDays, at))
    .sort((a, b) => b.worth - a.worth || b.lastAt.localeCompare(a.lastAt))
    .slice(0, Math.min(Math.max(options.limit ?? 100, 1), 500));
}

export async function getIdea(
  db: Client,
  workspaceId: string,
  id: string,
): Promise<(IdeaSummary & { asksList: IdeaAsk[] }) | null> {
  const row = await queryOne<IdeaRow>(db, 'SELECT * FROM ideas WHERE workspace_id = ? AND id = ?', [
    workspaceId,
    id,
  ]);
  if (!row) return null;
  const asks = (await asksFor(db, [id], true)).get(id) ?? [];
  const { windowDays } = await getIdeaScan(db, workspaceId);
  return { ...summarize(row, asks, windowDays, new Date()), asksList: asks };
}

export async function updateIdea(
  db: Client,
  workspaceId: string,
  id: string,
  patch: {
    status?: IdeaStatus | undefined;
    label?: string | undefined;
    notes?: string | null | undefined;
  },
): Promise<boolean> {
  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (patch.status) {
    sets.push('status = ?');
    args.push(patch.status);
  }
  if (patch.label?.trim()) {
    sets.push('label = ?', 'named = 1');
    args.push(patch.label.trim().slice(0, 80));
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?');
    args.push(patch.notes?.slice(0, 5000) ?? null);
  }
  if (!sets.length)
    return Boolean(
      await queryOne(db, 'SELECT id FROM ideas WHERE workspace_id = ? AND id = ?', [
        workspaceId,
        id,
      ]),
    );
  sets.push('updated_at = ?');
  args.push(now());
  const res = await db.execute({
    sql: `UPDATE ideas SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`,
    args: [...args, workspaceId, id],
  });
  return res.rowsAffected > 0;
}

/** What chovy.com is told to build. */
export function briefFor(idea: IdeaSummary & { asksList: IdeaAsk[] }): BuildBrief {
  return {
    label: idea.label,
    wants: idea.wants,
    askers: Math.max(idea.askers, 1),
    subs: idea.subs,
    feeds: idea.feeds,
    revenue: idea.revenue,
    rivals: idea.rivals.length,
    examples: idea.asksList.slice(0, 3).map((a) => ({ title: a.title, url: a.url })),
  };
}

export async function recordHandoff(
  db: Client,
  workspaceId: string,
  id: string,
  input: { url: string; by: string },
): Promise<void> {
  await db.execute({
    sql: "UPDATE ideas SET status = 'building', handoff_url = ?, handoff_at = ?, handoff_by = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    args: [input.url, now(), input.by, now(), workspaceId, id],
  });
}
