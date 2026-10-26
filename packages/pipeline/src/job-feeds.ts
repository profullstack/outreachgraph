/**
 * Companies hiring right now, from the public job feeds, into a campaign.
 *
 * The workflow's "Search job boards" step. Until 2026-10-26 it asked ValueSERP
 * for `site:jobs.lever.co "keyword"`, which by then returned the open web
 * instead, so every run found 0 postings and the Engineering Contracts
 * campaign stayed at the 28 companies its first crawls had named. This reads
 * the feeds in `@outreachgraph/providers` (`buildJobFeeds`) instead.
 *
 * Breadth over depth: every posting is one company, and a company already in
 * the campaign is passed over, so a run adds new companies rather than more
 * people at the same ones. For each new company:
 *
 *   1. its domain: from the post, the companies table, or one search;
 *   2. a company-level `hiring` signal citing the posting, which the composer
 *      can quote to everyone found there;
 *   3. a `crawl_site` of the domain into the campaign, the path every other
 *      company takes — the team page names the people, `find_email` finds
 *      their addresses, and the per-company cap keeps the best few;
 *   4. an address the post itself publishes for a named person (an HN
 *      "email me at jane@acme.com") becomes that person, with the post as
 *      evidence. Role addresses (jobs@, hiring@) are kept on the company.
 *
 * Reading only. Nothing here sends; the policy engine still decides that.
 */

import { queryOne, type Client } from '@outreachgraph/db';
import { isAgencyPosting, isLikelyRoleAccount, newId } from '@outreachgraph/domain';
import type { JobFeed, JobFeedPost, WebSearcher } from '@outreachgraph/providers';
import { findCompanyDomain } from './job-posts';
import { enqueue } from './queue';
import { ownDomains } from './recipient-guard';
import { intakeSocialPeople } from './social-intake';

/** Domain searches in flight at once. */
const LOOKUP_CONCURRENCY = 20;

/** Searches for a company's domain per run; each one is a ValueSERP credit. */
export const DEFAULT_DOMAIN_LOOKUPS = 120;

const HIRING_SIGNAL_CONFIDENCE = 0.9;
const HIRING_SIGNAL_RELEVANCE = 0.8;
/** An address the hiring post itself publishes for a named person. */
const POSTED_EMAIL_CONFIDENCE = 0.8;

/** Names that are placement firms or job marketplaces, not employers. */
const AGENCY_NAME =
  /\b(?:staffing|recruit(?:ing|ment|ers?)?|talent|placement|headhunt\w*|jobs?|careers|hiring|outsourc\w*|nearshore|offshore)\b|\blemon\.io\b|\bturing\b|\btoptal\b|\bandela\b|\bpavago\b/i;

/** Local parts that are a desk, never a person. */
const ROLE_LOCAL =
  /^(?:jobs?|careers?|hiring|hire|talent|recruit\w*|people|hr|team|hello|hi|info|contact|work|apply|applications?|eng|engineering|founders?|admin|support|join|resumes?|cv)$/i;

export interface JobFeedIntakeDeps {
  readonly db: Client;
  readonly feeds: readonly JobFeed[];
  /** For companies the post names without a domain. Absent: those are skipped. */
  readonly searcher?: WebSearcher | undefined;
  readonly now?: Date;
}

export interface JobFeedIntakeInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly keyword: string;
  /** New companies taken per run. */
  readonly limit: number;
  readonly domainLookups?: number;
}

export interface JobFeedIntakeResult {
  /** Postings read, per feed, or why a feed read none. */
  readonly byFeed: Readonly<Record<string, number | string>>;
  readonly postings: number;
  /** New companies queued for a crawl. */
  readonly companies: number;
  /** Companies the campaign already had, or postings seen by an earlier run. */
  readonly known: number;
  readonly agencies: number;
  /** Named, but no domain could be found within the lookup budget. */
  readonly noDomain: number;
  /** People taken in on an address their posting published. */
  readonly postedPeople: number;
}

/** Reads every feed, interleaved so one deep feed cannot fill the run alone. */
export async function readJobFeeds(
  feeds: readonly JobFeed[],
  keyword: string,
  limit: number,
): Promise<{ posts: JobFeedPost[]; byFeed: Record<string, number | string> }> {
  const byFeed: Record<string, number | string> = {};
  const lists: JobFeedPost[][] = [];
  for (const feed of feeds) {
    try {
      const posts = [...(await feed.search({ keyword, limit }))];
      byFeed[feed.slug] = posts.length;
      lists.push(posts);
    } catch (error) {
      byFeed[feed.slug] = error instanceof Error ? error.message.slice(0, 120) : 'failed';
    }
  }
  const posts: JobFeedPost[] = [];
  for (let i = 0; lists.some((list) => i < list.length); i += 1) {
    for (const list of lists) {
      const post = list[i];
      if (post) posts.push(post);
    }
  }
  return { posts, byFeed };
}

/**
 * Takes up to `limit` companies the campaign has not seen from the feeds.
 *
 * Idempotent by posting URL (`job_posts`) and by company domain (the crawl's
 * dedupe key), so a weekday schedule reading the same monthly HN thread every
 * morning only ever pays for what is new.
 */
export async function intakeJobFeeds(
  deps: JobFeedIntakeDeps,
  input: JobFeedIntakeInput,
): Promise<JobFeedIntakeResult> {
  const { db } = deps;
  const stamp = (deps.now ?? new Date()).toISOString();
  // Postings outnumber companies: read well past the limit so known ones can be passed over.
  const { posts, byFeed } = await readJobFeeds(
    deps.feeds,
    input.keyword,
    Math.max(input.limit * 3, 60),
  );
  // Every feed failing is an outage, not a quiet morning: fail the step so
  // the run retries it, rather than report "0 new companies" as success.
  const failed = Object.values(byFeed).filter((v) => typeof v === 'string');
  if (deps.feeds.length > 0 && failed.length === deps.feeds.length) {
    throw new Error(`every job feed failed: ${failed.join('; ')}`);
  }
  const own = await ownDomains(db, input.workspaceId);

  const found = await lookUpDomains(deps, input, posts);
  let companies = 0;
  let known = 0;
  let agencies = 0;
  let noDomain = 0;
  let postedPeople = 0;
  const seenCompanies = new Set<string>();

  for (const post of posts) {
    if (companies >= input.limit) break;
    const nameKey = post.company.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!nameKey || seenCompanies.has(nameKey)) continue;
    seenCompanies.add(nameKey);

    if (AGENCY_NAME.test(post.company) || isAgencyPosting(post.text)) {
      agencies += 1;
      continue;
    }

    const already = await queryOne<{ id: string }>(
      db,
      'SELECT id FROM job_posts WHERE workspace_id = ? AND url = ?',
      [input.workspaceId, post.url],
    );
    if (already) {
      known += 1;
      continue;
    }

    let domain = post.domain;
    if (!domain) {
      const byName = await queryOne<{ domain: string }>(
        db,
        `SELECT domain FROM companies WHERE lower(name) = ? AND domain IS NOT NULL LIMIT 1`,
        [post.company.toLowerCase()],
      );
      domain = byName?.domain;
    }
    if (!domain) domain = found.get(nameKey);
    if (!domain) {
      noDomain += 1;
      continue;
    }
    if (own.has(domain) || [...own].some((d) => domain.endsWith(`.${d}`))) continue;

    if (await companyInCampaign(db, input.workspaceId, input.campaignId, domain)) {
      known += 1;
      await recordPosting(db, input, post, domain, stamp, 'already in this campaign');
      continue;
    }

    const companyId = await upsertCompany(db, post, domain, stamp);
    await recordPosting(db, input, post, domain, stamp, `from ${post.feed}; site crawled`);
    await db.execute({
      sql: `INSERT INTO signals (id, workspace_id, company_id, network, signal_type, subtype, summary,
                                 evidence, source_url, source_timestamp, observed_at, confidence,
                                 relevance, sentiment)
            VALUES (?, ?, ?, 'website', 'hiring', ?, ?, ?, ?, ?, ?, ?, ?, 'neutral')`,
      args: [
        newId('signal'),
        input.workspaceId,
        companyId,
        `hiring_${post.feed}`,
        `Hiring: ${(post.title ?? post.company).slice(0, 160)}`,
        post.text.slice(0, 2_000),
        post.url,
        post.postedAt ?? null,
        stamp,
        HIRING_SIGNAL_CONFIDENCE,
        HIRING_SIGNAL_RELEVANCE,
      ],
    });

    await enqueue(db, {
      workspaceId: input.workspaceId,
      kind: 'crawl_site',
      payload: { url: `https://${domain}`, campaignId: input.campaignId },
      dedupeKey: `crawl:${input.campaignId}:${domain}`,
    });
    companies += 1;

    postedPeople += await intakePostedPeople(deps, input, post, domain, companyId, stamp);
  }

  return {
    byFeed,
    postings: posts.length,
    companies,
    known,
    agencies,
    noDomain,
    postedPeople,
  };
}

/**
 * Domains for the companies the feeds named without one, searched side by
 * side. One at a time, a ValueSERP query takes 40-150 s, so the first run of
 * this step spent over ten minutes on its first source (2026-10-26); the
 * account allows 250 a minute.
 */
async function lookUpDomains(
  deps: JobFeedIntakeDeps,
  input: JobFeedIntakeInput,
  posts: readonly JobFeedPost[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!deps.searcher) return found;
  const searcher = deps.searcher;
  const budget = input.domainLookups ?? DEFAULT_DOMAIN_LOOKUPS;
  const wanted: { key: string; company: string }[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    if (wanted.length >= budget) break;
    const key = post.company.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!key || seen.has(key) || post.domain) continue;
    seen.add(key);
    if (AGENCY_NAME.test(post.company) || isAgencyPosting(post.text)) continue;
    const posted = await queryOne<{ id: string }>(
      deps.db,
      'SELECT id FROM job_posts WHERE workspace_id = ? AND url = ?',
      [input.workspaceId, post.url],
    );
    if (posted) continue;
    const byName = await queryOne<{ domain: string }>(
      deps.db,
      `SELECT domain FROM companies WHERE lower(name) = ? AND domain IS NOT NULL LIMIT 1`,
      [post.company.toLowerCase()],
    );
    if (byName) continue;
    wanted.push({ key, company: post.company });
  }
  for (let i = 0; i < wanted.length; i += LOOKUP_CONCURRENCY) {
    await Promise.all(
      wanted.slice(i, i + LOOKUP_CONCURRENCY).map(async ({ key, company }) => {
        const domain = await findCompanyDomain(searcher, company);
        if (domain) found.set(key, domain);
      }),
    );
  }
  return found;
}

/** Whether anyone at this domain is already in the campaign, or its crawl is queued. */
async function companyInCampaign(
  db: Client,
  workspaceId: string,
  campaignId: string,
  domain: string,
): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM campaign_people cp
          JOIN people p ON p.id = cp.person_id
          JOIN companies co ON co.id = p.current_company_id
         WHERE cp.campaign_id = ? AND co.domain = ?)
     + (SELECT COUNT(*) FROM jobs WHERE workspace_id = ? AND dedupe_key = ?) AS n`,
    [campaignId, domain, workspaceId, `crawl:${campaignId}:${domain}`],
  );
  return Number(row?.n ?? 0) > 0;
}

async function upsertCompany(
  db: Client,
  post: JobFeedPost,
  domain: string,
  stamp: string,
): Promise<string> {
  const existing = await queryOne<{ id: string }>(db, 'SELECT id FROM companies WHERE domain = ?', [
    domain,
  ]);
  if (existing) return existing.id;
  const id = newId('company');
  await db.execute({
    sql: `INSERT INTO companies (id, name, domain, technologies, lead_source, lead_ref,
                                 created_at, updated_at)
          VALUES (?, ?, ?, '[]', 'job_feed', ?, ?, ?)
          ON CONFLICT DO NOTHING`,
    args: [id, post.company.slice(0, 120), domain, post.url, stamp, stamp],
  });
  const row = await queryOne<{ id: string }>(db, 'SELECT id FROM companies WHERE domain = ?', [
    domain,
  ]);
  return row?.id ?? id;
}

async function recordPosting(
  db: Client,
  input: JobFeedIntakeInput,
  post: JobFeedPost,
  domain: string,
  stamp: string,
  notes: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO job_posts (id, workspace_id, campaign_id, url, source, title, company,
                                 company_domain, location, posted_at, description, keyword,
                                 published_emails_json, status, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'other', ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
          ON CONFLICT (workspace_id, url) DO NOTHING`,
    args: [
      newId('jobPost'),
      input.workspaceId,
      input.campaignId,
      post.url,
      post.title?.slice(0, 300) ?? null,
      post.company.slice(0, 200),
      domain,
      post.location?.slice(0, 200) ?? null,
      post.postedAt ?? null,
      post.text.slice(0, 4_000),
      input.keyword,
      JSON.stringify(post.emails),
      notes,
      stamp,
      stamp,
    ],
  });
}

/** A person's name from their address, when the local part is one. */
export function nameFromAddress(address: string): string | undefined {
  const local = address.split('@')[0]?.toLowerCase() ?? '';
  if (ROLE_LOCAL.test(local)) return undefined;
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return undefined;
  if (!parts.every((p) => /^[a-z]{2,20}$/.test(p))) return undefined;
  const name = parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join(' ');
  return isLikelyRoleAccount(name) ? undefined : name;
}

/**
 * The people a posting itself invites mail to: an address at the company's
 * own domain whose local part is a name. Role addresses become the company's
 * contact address instead, which the shared-inbox rules already govern.
 */
async function intakePostedPeople(
  deps: JobFeedIntakeDeps,
  input: JobFeedIntakeInput,
  post: JobFeedPost,
  domain: string,
  companyId: string,
  stamp: string,
): Promise<number> {
  const { db } = deps;
  let taken = 0;
  for (const address of post.emails) {
    const host = address.split('@')[1] ?? '';
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    const name = nameFromAddress(address);
    if (!name) {
      await db.execute({
        sql: 'UPDATE companies SET contact_email = COALESCE(contact_email, ?) WHERE id = ?',
        args: [address, companyId],
      });
      continue;
    }
    if (!post.author) continue;

    const intake = await intakeSocialPeople(
      { db, ...(deps.now ? { now: deps.now } : {}) },
      {
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        people: [
          {
            network: 'hackernews',
            handle: post.author,
            profileUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(post.author)}`,
            displayName: name,
            via: 'job_feed',
          },
        ],
        source: 'job-feeds',
      },
    );
    const person = intake.people[0];
    if (!person) continue;
    await db.execute({
      sql: `UPDATE people SET current_company_id = COALESCE(current_company_id, ?) WHERE id = ?`,
      args: [companyId, person.id],
    });
    const exists = await queryOne<{ id: string }>(
      db,
      `SELECT id FROM social_identities WHERE person_id = ? AND network = 'email' AND lower(handle) = ?`,
      [person.id, address],
    );
    if (!exists) {
      await db.execute({
        sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
                                             profile_url, confidence, source_type, verified_by,
                                             first_seen_at, last_verified_at)
              VALUES (?, ?, 'email', ?, NULL, ?, ?, 'public_web', ?, ?, ?)`,
        args: [
          newId('socialIdentity'),
          person.id,
          address,
          post.url,
          POSTED_EMAIL_CONFIDENCE,
          JSON.stringify(['job-post']),
          stamp,
          stamp,
        ],
      });
    }
    await db.execute({
      sql: `INSERT INTO signals (id, workspace_id, person_id, company_id, network, signal_type,
                                 subtype, summary, evidence, source_url, source_timestamp,
                                 observed_at, confidence, relevance, sentiment)
            VALUES (?, ?, ?, ?, 'hackernews', 'hiring', 'hiring_post_author', ?, ?, ?, ?, ?, ?, ?,
                    'neutral')`,
      args: [
        newId('signal'),
        input.workspaceId,
        person.id,
        companyId,
        `Posted a hiring thread for ${post.company}: ${(post.title ?? '').slice(0, 140)}`,
        post.text.slice(0, 2_000),
        post.url,
        post.postedAt ?? null,
        stamp,
        HIRING_SIGNAL_CONFIDENCE,
        HIRING_SIGNAL_RELEVANCE,
      ],
    });
    taken += 1;
  }
  return taken;
}
