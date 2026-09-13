/**
 * The public directory: what the crawler learned from pages that were already
 * public, about things that are public by nature.
 *
 * Everything OutreachGraph knows arrived from the open web, but not everything
 * it knows is public data. A company's home page is; the fact that a workspace
 * is running a campaign against it is not. A person's own OpenProfile.md is;
 * the bio a stranger pasted in from their timeline, the score the engine gave
 * them and the address the enrichment sweep guessed are not. This module draws
 * that line once, in one query, so a reader who wants the public half (the
 * nichedb.dev directory is the first) gets exactly that half and nothing
 * leaks through a second, looser path later.
 *
 * WHAT IS LISTED
 *
 * - A company or site: a `companies` row with a domain. `company` when the
 *   page named an organisation, `site` when it did not and the row is only
 *   the domain the crawler read.
 * - A person, only when they publish their own profile: an `openprofiles` row
 *   that either holds an OpenProfile.md they serve themselves
 *   (`published_url`) or was corroborated, meaning the profile named a home
 *   page and the home page pointed back with rel=me. A person known from a
 *   scraped handle alone is not listed, whatever their confidence says.
 *
 * WHAT IS NOT
 *
 * No email address, no phone, no `contact_email`, no `location` (a street
 * address for a company, a city for a person), no campaign membership, no
 * signal, no score, no note, no workspace id, no avatar hot-linked from a
 * network's CDN. The row shape below is the whole export; a field not in it
 * is withheld, and adding one is a decision to make here, not in a caller.
 *
 * `companies` and `people` carry no workspace_id: they are the shared identity
 * graph, so nothing here needs a scope and nothing here can leak one.
 *
 * PAGING
 *
 * Keyset on `(updated, id)` ascending, so a reader can walk forward from a
 * `since` timestamp and resume from the opaque cursor without ever repeating
 * or skipping a row that was updated while it read. The cursor is the last
 * row's `(updated, id)` base64url-encoded; there is nothing to guess in it and
 * nothing to hide.
 */

import { queryAll, type Client } from '@outreachgraph/db';
import { ApiError } from './context';

export type DirectoryKind = 'company' | 'site' | 'person';

export interface DirectoryItem {
  readonly id: string;
  readonly kind: DirectoryKind;
  readonly name: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly topics: readonly string[];
  readonly country: string | null;
  /** The OpenProfile.md the person serves themselves, or null. */
  readonly openprofile: string | null;
  /** ISO timestamp of the last change to the row. */
  readonly updated: string;
}

export interface DirectoryPage {
  readonly items: readonly DirectoryItem[];
  readonly next: string | null;
}

export interface DirectoryQuery {
  /** Only rows updated at or after this ISO timestamp. */
  readonly since?: string | undefined;
  /** Resume after the row a previous page ended on. */
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const DIRECTORY_DEFAULT_LIMIT = 100;
export const DIRECTORY_MAX_LIMIT = 200;

/** Seconds a page may be served from a shared cache. */
export const DIRECTORY_CACHE_SECONDS = 300;

interface DirectoryRow {
  kind: string;
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  technologies: string | null;
  title: string | null;
  company_name: string | null;
  markdown: string | null;
  published_url: string | null;
  home_url: string | null;
  profile_url: string | null;
  updated_at: string;
}

/**
 * One query, both tables, one order.
 *
 * The person half is where the rule lives. `openprofiles` is joined rather
 * than left-joined because a person without one has no self-published
 * profile by definition; `published_url` and `corroborated` are the two ways
 * they can have one. `kind = 'person'` drops the company-inbox leads, which
 * are a mailbox wearing a person row. `status = 'active'` drops the suppressed
 * and the deleted; a tombstone must never resurface in a public list.
 *
 * The person's URL is their home page when a `website` identity was recorded
 * for them, else the profile the home page vouched for. Email rows are
 * excluded from both subqueries by network, not by pattern.
 */
const DIRECTORY_SQL = `
  SELECT * FROM (
    SELECT 'company' AS kind, c.id, c.name, c.domain, c.industry, c.technologies,
           NULL AS title, NULL AS company_name, NULL AS markdown, NULL AS published_url,
           NULL AS home_url, NULL AS profile_url, c.updated_at
      FROM companies c
     WHERE c.domain IS NOT NULL AND c.domain <> ''
    UNION ALL
    SELECT 'person' AS kind, p.id, p.display_name AS name, NULL AS domain, NULL AS industry,
           NULL AS technologies, p.current_title AS title, co.name AS company_name,
           o.markdown, o.published_url,
           (SELECT s.profile_url FROM social_identities s
             WHERE s.person_id = p.id AND s.network = 'website'
               AND s.profile_url LIKE 'http%'
             ORDER BY s.confidence DESC, s.first_seen_at ASC LIMIT 1) AS home_url,
           (SELECT s.profile_url FROM social_identities s
             WHERE s.person_id = p.id AND s.network NOT IN ('email', 'website')
               AND s.profile_url LIKE 'http%'
             ORDER BY s.confidence DESC, s.first_seen_at ASC LIMIT 1) AS profile_url,
           MAX(p.updated_at, o.generated_at) AS updated_at
      FROM people p
      JOIN openprofiles o ON o.person_id = p.id
      LEFT JOIN companies co ON co.id = p.current_company_id
     WHERE p.status = 'active' AND p.kind = 'person'
       AND (o.published_url IS NOT NULL OR o.corroborated = 1)
  ) d
  WHERE (? IS NULL OR d.updated_at >= ?)
    AND (? IS NULL OR d.updated_at > ? OR (d.updated_at = ? AND d.id > ?))
  ORDER BY d.updated_at ASC, d.id ASC
  LIMIT ?
`;

export async function listPublicDirectory(
  db: Client,
  query: DirectoryQuery = {},
): Promise<DirectoryPage> {
  const limit = clampLimit(query.limit);
  const since = parseSince(query.since);
  const after = query.cursor ? decodeCursor(query.cursor) : undefined;

  const rows = await queryAll<DirectoryRow>(db, DIRECTORY_SQL, [
    since ?? null,
    since ?? null,
    after?.updated ?? null,
    after?.updated ?? null,
    after?.updated ?? null,
    after?.id ?? null,
    limit + 1,
  ]);

  const page = rows.slice(0, limit).map(toItem);
  const last = page[page.length - 1];
  const next = rows.length > limit && last ? encodeCursor(last.updated, last.id) : null;

  return { items: page, next };
}

function toItem(row: DirectoryRow): DirectoryItem {
  if (row.kind === 'person') {
    return {
      id: row.id,
      kind: 'person',
      name: row.name,
      url: row.home_url ?? row.profile_url ?? row.published_url,
      description: describePerson(row.title, row.company_name),
      topics: topicsFromOpenProfile(row.markdown),
      country: null,
      openprofile: row.published_url,
      updated: row.updated_at,
    };
  }

  const domain = (row.domain ?? '').trim().toLowerCase();
  // The crawler names a company after its domain when the page named nobody;
  // that row is a site we read, not an organisation we can vouch for.
  const kind: DirectoryKind = row.name.trim().toLowerCase() === domain ? 'site' : 'company';

  return {
    id: row.id,
    kind,
    name: row.name,
    url: `https://${domain}`,
    // Nothing the crawler keeps on the company row describes it: the OpenGraph
    // description is read and used for drafting but never stored. Withheld
    // rather than invented.
    description: null,
    topics: companyTopics(row.industry, row.technologies),
    country: null,
    openprofile: null,
    updated: row.updated_at,
  };
}

/** "VP Engineering at Acme", or just the title, or nothing. Never a bio. */
function describePerson(title: string | null, company: string | null): string | null {
  const t = title?.trim();
  const c = company?.trim();
  if (t && c) return `${t} at ${c}`;
  return t || null;
}

/** The industry plus every technology the row carries, lower-cased and unique. */
export function companyTopics(industry: string | null, technologies: string | null): string[] {
  const topics = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const t = value.trim().toLowerCase();
    if (t) topics.add(t);
  };
  add(industry);
  if (technologies) {
    try {
      const parsed: unknown = JSON.parse(technologies);
      if (Array.isArray(parsed)) for (const value of parsed) add(value);
    } catch {
      // A malformed list is nothing to export, not an error to raise.
    }
  }
  return [...topics].slice(0, 40);
}

/**
 * The `## Topics` line of an OpenProfile.md: `- a, b, c`.
 *
 * The only part of the markdown that is read. Topics are what the person
 * tagged themselves with, in their own file or their own bio; the rest of the
 * document may carry an email line, so it is never exported wholesale.
 */
export function topicsFromOpenProfile(markdown: string | null): string[] {
  if (!markdown) return [];
  const match = /^## Topics\s*\n+\s*-\s*(.+)$/m.exec(markdown);
  if (!match?.[1]) return [];
  const topics = new Set<string>();
  for (const raw of match[1].split(',')) {
    const t = raw.trim().replace(/^#/, '').toLowerCase();
    if (t) topics.add(t);
  }
  return [...topics].slice(0, 40);
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return DIRECTORY_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), DIRECTORY_MAX_LIMIT);
}

function parseSince(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw ApiError.badRequest('since must be an ISO 8601 timestamp');
  return new Date(ms).toISOString();
}

export function encodeCursor(updated: string, id: string): string {
  return Buffer.from(`${updated}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { updated: string; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw ApiError.badRequest('cursor is not valid');
  }
  const separator = decoded.lastIndexOf('|');
  const updated = separator > 0 ? decoded.slice(0, separator) : '';
  const id = separator > 0 ? decoded.slice(separator + 1) : '';
  if (!updated || !id || Number.isNaN(Date.parse(updated))) {
    throw ApiError.badRequest('cursor is not valid');
  }
  return { updated, id };
}

/**
 * A fixed window per caller, in memory.
 *
 * The deployment is one container pinned to one replica, so a map is the whole
 * truth. The endpoint is cheap and cacheable for five minutes, so the limit is
 * there to stop a runaway loop, not to meter anyone: a reader walking the
 * whole directory at 200 a page needs a handful of requests.
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Records one request and says whether it is within the window's allowance. */
  take(key: string): { allowed: boolean; retryAfterSeconds: number; remaining: number } {
    const now = this.clock();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(now);
      return { allowed: true, retryAfterSeconds: 0, remaining: this.limit - 1 };
    }
    entry.count += 1;
    const remaining = Math.max(this.limit - entry.count, 0);
    if (entry.count > this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(Math.ceil((entry.resetAt - now) / 1000), 1),
        remaining,
      };
    }
    return { allowed: true, retryAfterSeconds: 0, remaining };
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}

export const DIRECTORY_RATE_LIMIT = 60;
export const DIRECTORY_RATE_WINDOW_MS = 60_000;

/** The caller as the edge saw it: first forwarded hop, else the one Bun reports. */
export function clientKey(request: Request, fallback = 'unknown'): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip')?.trim() || fallback;
}
