/**
 * The open lists the lead base grows from.
 *
 * Each source reads one batch from where its cursor stopped and returns
 * candidate companies keyed by domain, plus the cursor after them. Nothing
 * here touches the database or a model; the runner (`./runner.ts`) stores
 * what comes back, counts it against the source's daily cap and saves the
 * cursor, so a run that dies is a run that resumes.
 *
 * Every source is keyless and its terms allow commercial reuse:
 *
 * - **Wikidata** (CC0): every business (instance of a subclass of Q4830453)
 *   with an official website (P856), with country, industry and headcount.
 *   Read through QLever's public SPARQL endpoint, which answers 2,000 rows in
 *   a few seconds where the WDQS endpoint times out on this query.
 * - **The Majestic Million** (CC BY 3.0): the million registered domains with
 *   the most referring subnets, refreshed daily. Read by byte range, so a run
 *   reads only its slice of the 80 MB file. (Tranco was considered and
 *   rejected: its default list folds in Cloudflare Radar, CC BY-NC.)
 * - **nichedb.dev** (ours): collections whose items name a business's own
 *   site: SaaS listings, browser extensions, MCP servers, deal and coupon
 *   stores, self-hosted podcasts.
 * - **pit.world** (ours): the /pros business directory, each listing read as
 *   its OpenProfile.md (Kind organization), so a business carries its
 *   category and place, not only a domain.
 */

import { identityValue, kindOf, parseOpenProfile, web } from '@profullstack/openprofile';
import { countryFromDomain, hostFrom, leadDomain } from './domains';

/** One company a source found. */
export interface LeadCandidate {
  readonly domain: string;
  readonly name: string;
  readonly industry?: string | null;
  /** Free-text place, "Los Gatos, CA, USA". */
  readonly location?: string | null;
  readonly country?: string | null;
  readonly employees?: number | null;
  /** The source's own id for the row (a Wikidata Q-id, a nichedb item id, a rank). */
  readonly ref?: string | null;
  /** Lower is better: a popularity rank, where the source has one. */
  readonly rank?: number | null;
}

export interface LeadBatch {
  readonly candidates: readonly LeadCandidate[];
  /** Where the next run starts; null starts the source over from the top. */
  readonly cursor: string | null;
  /** Upstream rows read, kept or not. */
  readonly seen: number;
  /** True when the source has nothing past this batch (until it is restarted). */
  readonly done: boolean;
}

export interface LeadReadContext {
  readonly cursor: string | null;
  /** Candidates wanted at most; a source may return fewer. */
  readonly max: number;
  readonly fetch: typeof fetch;
}

export interface LeadSourceDefinition {
  readonly id: string;
  readonly label: string;
  readonly homepage: string;
  readonly license: string;
  /** New companies stored per UTC day, at most. */
  readonly dailyCap: number;
  /** Candidates asked for per run. */
  readonly batchSize: number;
  /** Minutes between runs while under the cap. */
  readonly everyMinutes: number;
  /** Days to wait after reaching the end before reading from the top again. */
  readonly restartAfterDays: number;
  /**
   * The source describes businesses it knows first-hand (their own directory
   * listing), so a company already stored gets its blank industry, location
   * and country filled from it. Never overwrites a value.
   */
  readonly fillBlanks?: boolean;
  read(context: LeadReadContext): Promise<LeadBatch>;
}

const USER_AGENT =
  'outreachgraph-lead-sources/1 (+https://outreachgraph.com; bot@profullstack.com)';

// ------------------------------------------------------------------ Wikidata

export const WIKIDATA_SPARQL_URL = 'https://qlever.dev/api/wikidata';
const WIKIDATA_ENTITY = 'http://www.wikidata.org/entity/';

/** The SPARQL for one page of businesses with a website, keyset-paged on the item IRI. */
export function wikidataQuery(after: string | null, limit: number): string {
  const filter = after
    ? `FILTER(STR(?item) > "${WIKIDATA_ENTITY}${after.replace(/[^Q0-9]/g, '')}")`
    : '';
  return `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item (SAMPLE(?site) AS ?website) (SAMPLE(?label) AS ?name) (SAMPLE(?cc) AS ?country)
       (SAMPLE(?ind) AS ?industry) (MAX(?emp) AS ?employees) WHERE {
  ?item wdt:P31/wdt:P279* wd:Q4830453 .
  ?item wdt:P856 ?site .
  ${filter}
  OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = "en") }
  OPTIONAL { ?item wdt:P17 ?c . ?c wdt:P297 ?cc }
  OPTIONAL { ?item wdt:P452 ?i . ?i rdfs:label ?ind . FILTER(LANG(?ind) = "en") }
  OPTIONAL { ?item wdt:P1128 ?emp }
}
GROUP BY ?item
ORDER BY ?item
LIMIT ${Math.max(1, Math.floor(limit))}`;
}

interface SparqlBinding {
  readonly [name: string]: { readonly value: string } | undefined;
}

export function wikidataSource(endpoint = WIKIDATA_SPARQL_URL): LeadSourceDefinition {
  return {
    id: 'wikidata',
    label: 'Wikidata businesses with a website',
    homepage: 'https://www.wikidata.org',
    license: 'CC0',
    dailyCap: 6000,
    batchSize: 2000,
    everyMinutes: 10,
    restartAfterDays: 7,
    async read({ cursor, max, fetch: doFetch }) {
      const limit = Math.min(Math.max(1, max), 5000);
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/sparql-results+json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': USER_AGENT,
        },
        body: new URLSearchParams({ query: wikidataQuery(cursor, limit) }).toString(),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error(`Wikidata SPARQL answered ${response.status}`);
      const body = (await response.json()) as { results?: { bindings?: SparqlBinding[] } };
      const rows = body.results?.bindings ?? [];
      const candidates: LeadCandidate[] = [];
      let last = cursor;
      for (const row of rows) {
        const item = row.item?.value ?? '';
        const qid = item.startsWith(WIKIDATA_ENTITY) ? item.slice(WIKIDATA_ENTITY.length) : '';
        if (qid) last = qid;
        const domain = leadDomain(row.website?.value);
        if (!domain) continue;
        const employees = Number(row.employees?.value);
        const country = row.country?.value?.toUpperCase() ?? null;
        candidates.push({
          domain,
          name: row.name?.value?.trim() || domain,
          industry: row.industry?.value ?? null,
          country: country && /^[A-Z]{2}$/.test(country) ? country : countryFromDomain(domain),
          employees: Number.isFinite(employees) && employees > 0 ? Math.round(employees) : null,
          ref: qid || null,
        });
      }
      const done = rows.length < limit;
      return { candidates, cursor: done ? null : last, seen: rows.length, done };
    },
  };
}

// ---------------------------------------------------------- Majestic Million

export const MAJESTIC_URL = 'https://downloads.majestic.com/majestic_million.csv';

/** Lines read per run at most, so one run never walks the whole file. */
const MAJESTIC_MAX_LINES = 60_000;

/**
 * Majestic ranks at or above this are skipped. The top thousand is almost all
 * megacorps, platforms, national media and universities (rank 1-120 was
 * google, instagram, twitter, linkedin, apple, wikipedia, nytimes, oracle,
 * cnn, mit.edu...), which no campaign can sell to; the explicit list in
 * `MEGA_PLATFORMS` catches the famous ones further down.
 */
export const MAJESTIC_SKIP_TOP = 1000;

interface MajesticCursor {
  /** Byte offset of the newline that ended the last line read. */
  readonly offset: number;
}

function parseMajesticCursor(cursor: string | null): MajesticCursor {
  if (!cursor) return { offset: 0 };
  try {
    const parsed = JSON.parse(cursor) as { offset?: unknown };
    const offset = Number(parsed.offset);
    return { offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0 };
  } catch {
    return { offset: 0 };
  }
}

/**
 * Reads the Majestic Million from a byte offset. The cursor is the offset of
 * the newline that ended the last line used, so the next run asks for the
 * range from there and drops everything up to the first newline: nothing when
 * the file is the same one, a torn line when the daily refresh moved it, and a
 * few rows missed or repeated across a refresh are harmless, because the
 * domain is the key.
 */
export function majesticSource(url = MAJESTIC_URL): LeadSourceDefinition {
  return {
    id: 'majestic-million',
    label: 'Majestic Million',
    homepage: 'https://majestic.com/reports/majestic-million',
    license: 'CC BY 3.0',
    dailyCap: 3000,
    batchSize: 1000,
    everyMinutes: 15,
    restartAfterDays: 30,
    async read({ cursor, max, fetch: doFetch }) {
      const { offset } = parseMajesticCursor(cursor);
      const response = await doFetch(url, {
        headers: {
          'user-agent': USER_AGENT,
          // The server ignores a range on a compressed response and sends the
          // whole 80 MB; byte offsets only mean something uncompressed.
          'accept-encoding': 'identity',
          ...(offset > 0 ? { range: `bytes=${offset}-` } : {}),
        },
        signal: AbortSignal.timeout(120_000),
      });
      if (response.status === 416) return { candidates: [], cursor: null, seen: 0, done: true };
      if (!response.ok) throw new Error(`Majestic answered ${response.status}`);
      if (offset > 0 && response.status !== 206) {
        throw new Error('Majestic ignored the byte range; refusing to re-read the whole file');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Majestic sent no body');

      const decoder = new TextDecoder();
      const candidates: LeadCandidate[] = [];
      let buffer = new Uint8Array(0);
      let consumed = 0; // bytes of the response before `buffer`
      let lastNewline = -1; // response-relative offset of the last newline used
      let skippingFirst = offset > 0; // a range starts mid-line until its first newline
      let lines = 0;
      let seen = 0;
      let ended = false;

      outer: while (true) {
        const { value, done } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer);
        merged.set(value, buffer.length);
        buffer = merged;
        let start = 0;
        for (let i = 0; i < buffer.length; i += 1) {
          if (buffer[i] !== 0x0a) continue;
          const line = decoder.decode(buffer.subarray(start, i)).trim();
          const at = consumed + i;
          start = i + 1;
          if (skippingFirst) {
            skippingFirst = false;
            lastNewline = at;
            continue;
          }
          lastNewline = at;
          lines += 1;
          const fields = line.split(',');
          const rank = Number(fields[0]);
          if (Number.isFinite(rank) && rank > MAJESTIC_SKIP_TOP && fields[2]) {
            seen += 1;
            const domain = leadDomain(fields[2]);
            if (domain && domain === fields[2].toLowerCase().replace(/^www\./, '')) {
              candidates.push({
                domain,
                name: domain,
                country: countryFromDomain(domain),
                ref: String(rank),
                rank,
              });
            }
          }
          if (candidates.length >= max || lines >= MAJESTIC_MAX_LINES) break outer;
        }
        consumed += start;
        buffer = buffer.slice(start);
      }
      await reader.cancel().catch(() => undefined);

      if (ended) return { candidates, cursor: null, seen, done: true };
      const next = offset + lastNewline;
      return { candidates, cursor: JSON.stringify({ offset: next }), seen, done: false };
    },
  };
}

// ---------------------------------------------------------------- nichedb.dev

export const NICHEDB_ITEMS_URL = 'https://nichedb.dev/api/v1/items';

interface NichedbLeadItem {
  readonly id?: string | number;
  readonly title?: string;
  readonly url?: string;
  readonly updated_at?: string;
  readonly data?: Record<string, unknown> | null;
}

export interface NichedbLeadOptions {
  readonly collection: string;
  readonly label: string;
  readonly dailyCap: number;
  /** Where the business's site is in an item. */
  readonly siteOf: (item: NichedbLeadItem) => string | null | undefined;
  /** The company's name; defaults to the item title, else the domain. */
  readonly nameOf?: (item: NichedbLeadItem, domain: string) => string;
  readonly industryOf?: (item: NichedbLeadItem) => string | null | undefined;
  readonly pages?: number;
}

export function nextMillisecond(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms + 1).toISOString() : iso;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * One nichedb.dev collection, read oldest-updated first from a `since` cursor,
 * the way `discover_nichedb` follows it.
 */
export function nichedbSource(
  options: NichedbLeadOptions,
  baseUrl = NICHEDB_ITEMS_URL,
): LeadSourceDefinition {
  const pageSize = 200;
  return {
    id: `nichedb-${options.collection}`,
    label: options.label,
    homepage: `https://nichedb.dev/c/${options.collection}`,
    license: 'nichedb.dev open items (ours)',
    dailyCap: options.dailyCap,
    batchSize: 1000,
    everyMinutes: 30,
    restartAfterDays: 1,
    async read({ cursor, max, fetch: doFetch }) {
      const candidates: LeadCandidate[] = [];
      let since = cursor;
      let seen = 0;
      let done = false;
      for (let page = 0; page < (options.pages ?? 15); page += 1) {
        const params = new URLSearchParams({
          collection: options.collection,
          sort: 'updated',
          order: 'asc',
          limit: String(pageSize),
        });
        if (since) params.set('since', since);
        const response = await doFetch(`${baseUrl}?${params}`, {
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`nichedb answered ${response.status}`);
        const body = (await response.json()) as { items?: NichedbLeadItem[] } | null;
        const items = Array.isArray(body?.items) ? body.items : [];
        seen += items.length;
        for (const item of items) {
          const domain = leadDomain(options.siteOf(item), { dropPlatformRoots: true });
          if (!domain) continue;
          const name = options.nameOf?.(item, domain) ?? str(item.title) ?? domain;
          candidates.push({
            domain,
            name: name.slice(0, 200),
            industry: options.industryOf?.(item) ?? null,
            country: countryFromDomain(domain),
            ref: item.id === undefined ? null : String(item.id),
          });
        }
        const last = items[items.length - 1]?.updated_at ?? null;
        if (items.length < pageSize) {
          // Caught up. Keep the newest timestamp so the next run reads only
          // what changed; a source that is caught up is not "done", it waits.
          if (last) since = last;
          done = true;
          break;
        }
        if (!last) break;
        // A whole page inside one millisecond cannot move a `since` cursor;
        // step past that millisecond rather than read the same page forever.
        since = last === since ? nextMillisecond(last) : last;
        if (candidates.length >= max) break;
      }
      return { candidates, cursor: since, seen, done };
    },
  };
}

const DIRECTORY_HOSTS =
  /(^|\.)(nichedb\.dev|saasrow\.com|slickdeals\.net|c0upons\.com|github\.com)$/;

function ownUrl(item: NichedbLeadItem): string | null {
  const url = str(item.url);
  if (!url) return null;
  try {
    return DIRECTORY_HOSTS.test(new URL(url).hostname) ? null : url;
  } catch {
    return null;
  }
}

export function nichedbSources(baseUrl = NICHEDB_ITEMS_URL): LeadSourceDefinition[] {
  return [
    nichedbSource(
      {
        collection: 'saas',
        label: 'nichedb SaaS listings',
        dailyCap: 1000,
        siteOf: (item) => str(item.data?.website) ?? ownUrl(item),
        industryOf: (item) => str(item.data?.category) ?? 'software',
      },
      baseUrl,
    ),
    nichedbSource(
      {
        collection: 'extensions',
        label: 'nichedb browser and editor extensions',
        dailyCap: 1000,
        siteOf: (item) => str(item.data?.homepage),
        industryOf: () => 'software',
      },
      baseUrl,
    ),
    nichedbSource(
      {
        collection: 'mcp',
        label: 'nichedb MCP servers',
        dailyCap: 1000,
        siteOf: (item) => str(item.data?.website) ?? str(item.data?.homepage) ?? ownUrl(item),
        industryOf: () => 'AI tooling',
      },
      baseUrl,
    ),
    nichedbSource(
      {
        collection: 'deals',
        label: 'nichedb deal stores',
        dailyCap: 1000,
        siteOf: (item) => str(item.data?.storeDomain),
        nameOf: (item, domain) => str(item.data?.store) ?? domain,
        industryOf: (item) => str(item.data?.category) ?? 'retail',
      },
      baseUrl,
    ),
    nichedbSource(
      {
        collection: 'coupons',
        label: 'nichedb coupon stores',
        dailyCap: 1000,
        siteOf: (item) => str(item.data?.storeDomain) ?? str(item.data?.dealUrl),
        nameOf: (item, domain) => str(item.data?.store) ?? domain,
        industryOf: () => 'retail',
      },
      baseUrl,
    ),
    nichedbSource(
      {
        collection: 'podcasts',
        label: 'nichedb self-hosted podcasts',
        dailyCap: 3000,
        siteOf: (item) => str(item.data?.siteUrl),
        industryOf: () => 'podcast',
      },
      baseUrl,
    ),
  ];
}

// ------------------------------------------------------------------ pit.world

export const PIT_WORLD_URL = 'https://pit.world';

interface PitWorldPro {
  readonly domain?: string;
  readonly moshpitOnly?: boolean;
  readonly openprofile?: string;
}

const COUNTRY_NAMES: Record<string, string> = {
  usa: 'US',
  us: 'US',
  'united states': 'US',
  'united states of america': 'US',
  uk: 'GB',
  'united kingdom': 'GB',
  canada: 'CA',
  australia: 'AU',
  germany: 'DE',
  france: 'FR',
};

/** The country at the end of "Los Gatos, CA, USA", as ISO 3166 alpha-2 when it is one we know. */
export function countryFromPlace(place: string | null | undefined): string | null {
  const last = place?.split(',').pop()?.trim().toLowerCase();
  if (!last) return null;
  return COUNTRY_NAMES[last] ?? null;
}

/** `seo.rank.pit.world`: pit.world's relay host for a name that only opens on Moshpit DNS. */
export function pitWorldRelayHost(value: string | null | undefined): string | null {
  const host = hostFrom(value);
  return host && host.endsWith('.pit.world') && host.slice(0, -'.pit.world'.length).includes('.')
    ? host
    : null;
}

/**
 * One pit.world listing's OpenProfile.md as a candidate; null when it is not a business with a site.
 * A Moshpit-only business is keyed by its relay host, `<name>.pit.world`, which any crawler can open;
 * reduced to a registered domain it would collapse into pit.world itself.
 */
export function pitWorldCandidate(
  markdown: string,
  domain: string,
  ref: string,
): LeadCandidate | null {
  const doc = parseOpenProfile(markdown);
  if (kindOf(doc) !== 'organization') return null;
  const key = pitWorldRelayHost(web(doc)) ?? leadDomain(domain) ?? leadDomain(web(doc));
  if (!key) return null;
  const location = identityValue(doc, 'Location') ?? identityValue(doc, 'Area');
  return {
    domain: key,
    name: (doc.name ?? key).slice(0, 200),
    industry: identityValue(doc, 'Category'),
    location,
    country: countryFromPlace(identityValue(doc, 'Location')) ?? countryFromDomain(key),
    ref: ref.slice(0, 120),
  };
}

/**
 * The pit.world pro directory, small enough to read whole once a day: page
 * the directory for domains, then read each listing's OpenProfile.md. A name
 * that only opens on Moshpit DNS comes in as its `<name>.pit.world` relay.
 */
export function pitWorldSource(baseUrl = PIT_WORLD_URL): LeadSourceDefinition {
  return {
    id: 'pit-world',
    label: 'pit.world pro directory (OpenProfile)',
    homepage: `${baseUrl}/pros`,
    license: 'pit.world listings (ours)',
    dailyCap: 2000,
    batchSize: 2000,
    everyMinutes: 60,
    restartAfterDays: 1,
    fillBlanks: true,
    async read({ max, fetch: doFetch }) {
      const headers = { 'user-agent': USER_AGENT };
      const pros: PitWorldPro[] = [];
      for (let page = 1; page <= 50; page += 1) {
        const response = await doFetch(`${baseUrl}/api/pros?n=100&page=${page}`, {
          headers: { ...headers, accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`pit.world answered ${response.status}`);
        const body = (await response.json()) as { total?: number; results?: PitWorldPro[] };
        const results = Array.isArray(body.results) ? body.results : [];
        pros.push(...results);
        if (results.length < 100 || pros.length >= Number(body.total ?? 0)) break;
      }
      const candidates: LeadCandidate[] = [];
      for (const pro of pros) {
        if (candidates.length >= max) break;
        if (!pro.domain) continue;
        const url =
          pro.openprofile ?? `${baseUrl}/b/${encodeURIComponent(pro.domain)}/openprofile.md`;
        const response = await doFetch(url, {
          headers: { ...headers, accept: 'text/markdown' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) continue;
        const candidate = pitWorldCandidate(await response.text(), pro.domain, url);
        if (candidate) candidates.push(candidate);
      }
      return { candidates, cursor: null, seen: pros.length, done: true };
    },
  };
}

/** Every source, in the order they are run. Business-y first. */
export function defaultLeadSources(): LeadSourceDefinition[] {
  return [pitWorldSource(), wikidataSource(), ...nichedbSources(), majesticSource()];
}
