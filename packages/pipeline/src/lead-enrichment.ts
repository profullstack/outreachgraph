/**
 * Filling in what a lead is missing: name, job title, LinkedIn.
 *
 * An imported row is often just an address. A message written to "there"
 * with no idea what the person does reads as exactly what it is, so before a
 * lead is written to, this fills the blanks from the cheapest source that can
 * answer, in order, and only ever fills blanks:
 *
 *   1. **The address itself.** `scott.perry@acme.com` is Scott Perry. Free,
 *      and only the unambiguous shape (`nameFromAddress`).
 *   2. **People Data Labs**, when a key is configured. Paid per match, capped
 *      per day, and licensed for storage (Apollo is not, and is never used).
 *   3. **A Google search of LinkedIn** through ValueSERP: the profile, and
 *      the job title off the result's headline, taken only when the result is
 *      evidence (see `pickPerson`). The company's LinkedIn page is the
 *      fallback when no person profile is evidenced.
 *
 * Every search's raw results are cached in `serp_cache`, so a rerun costs
 * nothing, and the searches are bounded three ways: per run, per workspace per
 * day (counted in `enrichment_usage`, so a restart cannot reset it), and by
 * HTTP 402, which stops the run cleanly. ValueSERP takes 10-45 s a query, so
 * the work runs at a concurrency of about ten with a per-request timeout.
 *
 * This reads search results. It never fetches LinkedIn, never logs in, and the
 * profiles it records are research at a confidence no machine acts on.
 */

import { isConsumerMailDomain, nameFromAddress, newId } from '@outreachgraph/domain';
import {
  companyQuery,
  linkedinPath,
  personQuery,
  pickCompany,
  pickPerson,
  SearchOutOfCredits,
  titleFromResult,
  type PersonEnricher,
  type SerpResult,
  type WebSearcher,
} from '@outreachgraph/providers';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';

/** A search result is research, below any outreach threshold (same as photos). */
const SEARCH_IDENTITY_CONFIDENCE = 0.6;
/** A licensed provider matched the address itself: stronger than a name search. */
const PDL_IDENTITY_CONFIDENCE = 0.8;

export const DEFAULT_SEARCHES_PER_DAY = 300;
export const DEFAULT_PDL_PER_DAY = 3;
const DEFAULT_PEOPLE_PER_RUN = 60;
const DEFAULT_SEARCHES_PER_RUN = 100;
const DEFAULT_CONCURRENCY = 10;

export interface LeadEnrichDeps {
  readonly db: Client;
  /** Google results (ValueSERP). Absent: names from addresses only. */
  readonly searcher?: WebSearcher | undefined;
  /** People Data Labs. Absent: not used. */
  readonly pdl?: PersonEnricher | undefined;
  readonly now?: Date;
  readonly concurrency?: number;
  readonly searchesPerDay?: number;
  readonly pdlPerDay?: number;
}

export interface LeadEnrichInput {
  readonly workspaceId: string;
  /** Only this campaign's leads. */
  readonly campaignId?: string | undefined;
  /** People looked at in this run. */
  readonly limit?: number;
  /** New (uncached) searches this run may spend. */
  readonly maxSearches?: number;
}

export interface LeadEnrichResult {
  readonly looked: number;
  readonly names: number;
  readonly titles: number;
  readonly profiles: number;
  readonly companies: number;
  readonly pdlMatches: number;
  readonly searches: number;
  readonly cached: number;
  /** Why the run stopped spending early, when it did. */
  readonly stopped?: string;
}

interface Subject {
  readonly person_id: string;
  readonly display_name: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly current_title: string | null;
  readonly company_id: string | null;
  readonly company_domain: string | null;
  readonly company_linkedin: string | null;
  readonly email: string | null;
  readonly linkedin: string | null;
}

/** Workspace-wide: paused after a 402 until the next UTC day. */
const pausedUntil = new Map<string, string>();

/** Forgets every 402 pause. For tests, and for an operator who just topped up. */
export function resetEnrichmentPauses(): void {
  pausedUntil.clear();
}

export function enrichmentPausedUntil(provider: 'valueserp' | 'pdl'): string | undefined {
  const until = pausedUntil.get(provider);
  return until && until > new Date().toISOString() ? until : undefined;
}

function nextUtcDay(at: Date): string {
  const next = new Date(at);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

/** Lookups spent today by this workspace with this provider. */
export async function lookupsToday(
  db: Client,
  workspaceId: string,
  provider: string,
  at: Date = new Date(),
): Promise<number> {
  const row = await queryOne<{ lookups: number }>(
    db,
    'SELECT lookups FROM enrichment_usage WHERE workspace_id = ? AND day = ? AND provider = ?',
    [workspaceId, at.toISOString().slice(0, 10), provider],
  );
  return Number(row?.lookups ?? 0);
}

async function countLookup(db: Client, workspaceId: string, provider: string, at: Date) {
  await db.execute({
    sql: `INSERT INTO enrichment_usage (workspace_id, day, provider, lookups) VALUES (?, ?, ?, 1)
          ON CONFLICT (workspace_id, day, provider) DO UPDATE
            SET lookups = enrichment_usage.lookups + 1`,
    args: [workspaceId, at.toISOString().slice(0, 10), provider],
  });
}

/** The people a run would look at: in a live campaign, missing something, never tried. */
async function subjects(db: Client, input: LeadEnrichInput, limit: number): Promise<Subject[]> {
  return queryAll<Subject>(
    db,
    `SELECT DISTINCT p.id AS person_id, p.display_name, p.first_name, p.last_name,
            p.current_title, co.id AS company_id, co.domain AS company_domain,
            co.linkedin_url AS company_linkedin,
            (SELECT pe.address FROM person_emails pe
              WHERE pe.person_id = p.id AND pe.workspace_id = cp.workspace_id
              ORDER BY pe.created_at LIMIT 1) AS email,
            (SELECT si.profile_url FROM social_identities si
              WHERE si.person_id = p.id AND si.network = 'linkedin' LIMIT 1) AS linkedin
       FROM campaign_people cp
       JOIN campaigns c ON c.id = cp.campaign_id
       JOIN people p ON p.id = cp.person_id
       LEFT JOIN companies co ON co.id = p.current_company_id
      WHERE cp.workspace_id = ? ${input.campaignId ? 'AND cp.campaign_id = ?' : ''}
        AND c.status != 'archived'
        AND p.status = 'active' AND p.kind = 'person'
        AND p.linkedin_looked_up_at IS NULL
        AND (p.current_title IS NULL OR p.first_name IS NULL OR p.last_name IS NULL
             OR NOT EXISTS (SELECT 1 FROM social_identities si
                             WHERE si.person_id = p.id AND si.network = 'linkedin'))
      LIMIT ?`,
    input.campaignId ? [input.workspaceId, input.campaignId, limit] : [input.workspaceId, limit],
  );
}

/** Workspaces with live-campaign leads still missing a name, title or profile. */
export async function workspacesAwaitingLeadEnrichment(db: Client): Promise<string[]> {
  const rows = await queryAll<{ workspace_id: string }>(
    db,
    `SELECT DISTINCT cp.workspace_id
       FROM campaign_people cp
       JOIN campaigns c ON c.id = cp.campaign_id
       JOIN people p ON p.id = cp.person_id
      WHERE c.status IN ('active', 'running') AND p.status = 'active' AND p.kind = 'person'
        AND p.linkedin_looked_up_at IS NULL
        AND (p.current_title IS NULL OR p.first_name IS NULL
             OR NOT EXISTS (SELECT 1 FROM social_identities si
                             WHERE si.person_id = p.id AND si.network = 'linkedin'))`,
  );
  return rows.map((row) => row.workspace_id);
}

/**
 * One run over the next batch of leads.
 *
 * A person is stamped as looked up only when every question asked about them
 * was answered (from the cache or a search). One skipped because the run hit
 * its cap, ran out of credits or timed out is left for the next run.
 */
export async function enrichLeads(
  deps: LeadEnrichDeps,
  input: LeadEnrichInput,
): Promise<LeadEnrichResult> {
  const { db } = deps;
  const at = deps.now ?? new Date();
  const result = {
    looked: 0,
    names: 0,
    titles: 0,
    profiles: 0,
    companies: 0,
    pdlMatches: 0,
    searches: 0,
    cached: 0,
    stopped: undefined as string | undefined,
  };

  const searchRoom = deps.searcher
    ? Math.max(
        0,
        Math.min(
          input.maxSearches ?? DEFAULT_SEARCHES_PER_RUN,
          (deps.searchesPerDay ?? DEFAULT_SEARCHES_PER_DAY) -
            (await lookupsToday(db, input.workspaceId, 'valueserp', at)),
        ),
      )
    : 0;
  let pdlRoom = deps.pdl
    ? Math.max(
        0,
        (deps.pdlPerDay ?? DEFAULT_PDL_PER_DAY) -
          (await lookupsToday(db, input.workspaceId, 'pdl', at)),
      )
    : 0;
  if (enrichmentPausedUntil('pdl')) pdlRoom = 0;
  const searchPaused = enrichmentPausedUntil('valueserp');
  if (searchPaused) result.stopped = `ValueSERP is out of credits until ${searchPaused}`;

  const people = await subjects(db, input, input.limit ?? DEFAULT_PEOPLE_PER_RUN);
  const inflight = new Map<string, Promise<SerpResult[] | undefined>>();

  /** The query's results, from the cache or one search; undefined when it could not ask. */
  const ask = async (query: string): Promise<SerpResult[] | undefined> => {
    const cached = await queryOne<{ results: string }>(
      db,
      'SELECT results FROM serp_cache WHERE query = ?',
      [query],
    );
    if (cached) {
      result.cached += 1;
      try {
        return JSON.parse(cached.results) as SerpResult[];
      } catch {
        return [];
      }
    }
    const existing = inflight.get(query);
    if (existing) return existing;
    if (!deps.searcher || searchPaused || result.stopped || result.searches >= searchRoom) {
      if (!result.stopped && deps.searcher && result.searches >= searchRoom) {
        result.stopped = `reached the search cap (${searchRoom} this run)`;
      }
      return undefined;
    }
    result.searches += 1;
    const searcher = deps.searcher;
    const pending = (async () => {
      try {
        const results = await searcher.search(query, { num: 10 });
        const kept = results.map(({ title, link, snippet }) => ({ title, link, snippet }));
        await db.execute({
          sql: `INSERT INTO serp_cache (query, results, fetched_at) VALUES (?, ?, ?)
                ON CONFLICT (query) DO UPDATE SET results = excluded.results,
                  fetched_at = excluded.fetched_at`,
          args: [query, JSON.stringify(kept), now()],
        });
        await countLookup(db, input.workspaceId, 'valueserp', at);
        return kept;
      } catch (error) {
        if (error instanceof SearchOutOfCredits) {
          pausedUntil.set('valueserp', nextUtcDay(at));
          result.stopped = error.message;
        }
        // A timeout or a refusal is not an answer: the person is retried later.
        return undefined;
      }
    })();
    inflight.set(query, pending);
    return pending;
  };

  const enrichOne = async (subject: Subject): Promise<void> => {
    const stamp = now();
    const statements: { sql: string; args: (string | number | null)[] }[] = [];
    let first = subject.first_name;
    let last = subject.last_name;
    let title = subject.current_title;
    let linkedin = subject.linkedin;
    let complete = true;

    const emailDomain = subject.email?.split('@')[1]?.toLowerCase();
    const companyDomain =
      subject.company_domain ??
      (emailDomain && !isConsumerMailDomain(emailDomain) ? emailDomain : undefined);

    // 1. The address itself.
    if ((!first || !last) && subject.email) {
      const named = nameFromAddress(subject.email);
      if (named) {
        first = first ?? named.firstName;
        last = last ?? named.lastName;
        const display = /\s/.test(subject.display_name.trim())
          ? subject.display_name
          : `${named.firstName} ${named.lastName}`;
        statements.push({
          sql: `UPDATE people SET first_name = COALESCE(first_name, ?),
                  last_name = COALESCE(last_name, ?), display_name = ?, updated_at = ?
                 WHERE id = ?`,
          args: [named.firstName, named.lastName, display, stamp, subject.person_id],
        });
        statements.push(provenance(subject.person_id, 'first_name', named.firstName, 'address'));
        result.names += 1;
      }
    }

    // 2. People Data Labs, by address, for whoever still lacks a title or profile.
    if ((!title || !linkedin) && subject.email && pdlRoom > 0 && deps.pdl) {
      pdlRoom -= 1;
      try {
        await countLookup(db, input.workspaceId, 'pdl', at);
        const found = await deps.pdl.enrichByEmail(subject.email);
        if (found) {
          result.pdlMatches += 1;
          if ((!first || !last) && found.firstName && found.lastName) {
            first = found.firstName;
            last = found.lastName;
            statements.push({
              sql: `UPDATE people SET first_name = COALESCE(first_name, ?),
                      last_name = COALESCE(last_name, ?), updated_at = ? WHERE id = ?`,
              args: [found.firstName, found.lastName, stamp, subject.person_id],
            });
          }
          if (!title && found.title) {
            title = found.title;
            statements.push(...setTitle(subject.person_id, found.title, 'pdl', found.linkedinUrl));
            result.titles += 1;
          }
          const profile = linkedinPath(found.linkedinUrl, 'in');
          if (!linkedin && profile) {
            linkedin = profile;
            statements.push(addProfile(subject.person_id, profile, PDL_IDENTITY_CONFIDENCE, 'pdl'));
            result.profiles += 1;
          }
        }
      } catch (error) {
        if (error instanceof SearchOutOfCredits) {
          pausedUntil.set('pdl', nextUtcDay(at));
          pdlRoom = 0;
        }
      }
    }

    // 3. A Google search of LinkedIn: the profile and its headline.
    if ((!title || !linkedin) && first && last) {
      const subjectForSearch = { firstName: first, lastName: last, companyDomain };
      const query = personQuery(subjectForSearch);
      const results = await ask(query);
      if (!results) {
        complete = false;
      } else {
        const url = pickPerson(results, subjectForSearch);
        if (url) {
          if (!linkedin) {
            linkedin = url;
            statements.push(
              addProfile(subject.person_id, url, SEARCH_IDENTITY_CONFIDENCE, 'search'),
            );
            result.profiles += 1;
          }
          const hit = results.find((r) => linkedinPath(r.link, 'in') === url);
          const headline = hit ? titleFromResult(hit.title ?? '', companyDomain ?? '') : '';
          if (!title && headline) {
            title = headline;
            statements.push(...setTitle(subject.person_id, headline, 'valueserp', url));
            result.titles += 1;
          }
        }
      }
    }

    // 4. The company's page, when no person profile is evidenced.
    if (!linkedin && companyDomain && subject.company_id && !subject.company_linkedin) {
      const results = await ask(companyQuery(companyDomain));
      if (!results) {
        complete = false;
      } else {
        const url = pickCompany(results, companyDomain);
        if (url) {
          statements.push({
            sql: `UPDATE companies SET linkedin_url = ?, updated_at = ?
                   WHERE id = ? AND linkedin_url IS NULL`,
            args: [url, stamp, subject.company_id],
          });
          result.companies += 1;
        }
      }
    }

    if (complete) {
      statements.push({
        sql: 'UPDATE people SET linkedin_looked_up_at = ? WHERE id = ?',
        args: [stamp, subject.person_id],
      });
    }
    if (statements.length > 0) await db.batch(statements);
  };

  let next = 0;
  const worker = async () => {
    while (next < people.length) {
      const subject = people[next++]!;
      result.looked += 1;
      try {
        await enrichOne(subject);
      } catch (error) {
        console.error(`lead enrichment failed for ${subject.person_id}`, error);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(deps.concurrency ?? DEFAULT_CONCURRENCY, people.length) },
      worker,
    ),
  );

  return {
    looked: result.looked,
    names: result.names,
    titles: result.titles,
    profiles: result.profiles,
    companies: result.companies,
    pdlMatches: result.pdlMatches,
    searches: result.searches,
    cached: result.cached,
    ...(result.stopped ? { stopped: result.stopped } : {}),
  };
}

function provenance(
  personId: string,
  field: string,
  value: string,
  via: 'address' | 'pdl' | 'valueserp',
  url?: string,
): { sql: string; args: (string | number | null)[] } {
  const stamp = now();
  const [sourceType, license, confidence] =
    via === 'address'
      ? ['derived', 'derived_inference', 0.7]
      : via === 'pdl'
        ? ['provider', 'licensed_enrichment', PDL_IDENTITY_CONFIDENCE]
        : ['public_web', 'public_web', SEARCH_IDENTITY_CONFIDENCE];
  return {
    sql: `INSERT INTO field_provenance (id, entity_kind, entity_id, field, value, source_type,
          provider, source_url, license_class, confidence, observed_at, created_at)
          VALUES (?, 'person', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('fieldProvenance'),
      personId,
      field,
      value,
      sourceType,
      via,
      url ?? null,
      license,
      confidence,
      stamp,
      stamp,
    ],
  };
}

function setTitle(
  personId: string,
  title: string,
  via: 'pdl' | 'valueserp',
  url?: string,
): { sql: string; args: (string | number | null)[] }[] {
  return [
    {
      sql: `UPDATE people SET current_title = ?, updated_at = ?
             WHERE id = ? AND current_title IS NULL`,
      args: [title, now(), personId],
    },
    provenance(personId, 'current_title', title, via, url),
  ];
}

function addProfile(
  personId: string,
  url: string,
  confidence: number,
  via: 'pdl' | 'search',
): { sql: string; args: (string | number | null)[] } {
  const stamp = now();
  return {
    // Guarded in SQL as well: two runs racing on one person record one profile.
    sql: `INSERT INTO social_identities (id, person_id, network, handle, profile_url, confidence,
          source_type, verified_by, first_seen_at, last_verified_at)
          SELECT ?, ?, 'linkedin', ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM social_identities
                              WHERE person_id = ? AND network = 'linkedin')`,
    args: [
      newId('socialIdentity'),
      personId,
      decodeURIComponent(url.split('/in/')[1] ?? '') || null,
      url,
      confidence,
      via === 'pdl' ? 'provider' : 'public_web',
      JSON.stringify([via]),
      stamp,
      stamp,
      personId,
    ],
  };
}

/** What a campaign's leads are missing, and what enrichment can still spend today. */
export async function enrichmentStatus(
  deps: LeadEnrichDeps,
  input: { readonly workspaceId: string; readonly campaignId: string },
) {
  const row = await queryOne<{
    leads: number;
    no_name: number;
    no_title: number;
    no_linkedin: number;
    looked_up: number;
  }>(
    deps.db,
    `SELECT COUNT(*) AS leads,
            SUM(CASE WHEN p.first_name IS NULL OR p.last_name IS NULL THEN 1 ELSE 0 END) AS no_name,
            SUM(CASE WHEN p.current_title IS NULL THEN 1 ELSE 0 END) AS no_title,
            SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM social_identities si
                                       WHERE si.person_id = p.id AND si.network = 'linkedin')
                     THEN 1 ELSE 0 END) AS no_linkedin,
            SUM(CASE WHEN p.linkedin_looked_up_at IS NOT NULL THEN 1 ELSE 0 END) AS looked_up
       FROM campaign_people cp JOIN people p ON p.id = cp.person_id
      WHERE cp.campaign_id = ? AND cp.workspace_id = ? AND p.status = 'active'`,
    [input.campaignId, input.workspaceId],
  );
  const at = deps.now ?? new Date();
  const [searches, pdl] = await Promise.all([
    lookupsToday(deps.db, input.workspaceId, 'valueserp', at),
    lookupsToday(deps.db, input.workspaceId, 'pdl', at),
  ]);
  return {
    leads: Number(row?.leads ?? 0),
    missing_name: Number(row?.no_name ?? 0),
    missing_title: Number(row?.no_title ?? 0),
    missing_linkedin: Number(row?.no_linkedin ?? 0),
    looked_up: Number(row?.looked_up ?? 0),
    providers: {
      address: true,
      valueserp: Boolean(deps.searcher),
      pdl: Boolean(deps.pdl),
    },
    today: {
      searches,
      searches_cap: deps.searcher ? (deps.searchesPerDay ?? DEFAULT_SEARCHES_PER_DAY) : 0,
      pdl_lookups: pdl,
      pdl_cap: deps.pdl ? (deps.pdlPerDay ?? DEFAULT_PDL_PER_DAY) : 0,
    },
    paused: {
      ...(enrichmentPausedUntil('valueserp')
        ? { valueserp: enrichmentPausedUntil('valueserp') }
        : {}),
      ...(enrichmentPausedUntil('pdl') ? { pdl: enrichmentPausedUntil('pdl') } : {}),
    },
  };
}
