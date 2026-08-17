/**
 * A company web page as a source (PRD §10.1; `website/observe` in the
 * capability matrix, "permitted public web retrieval").
 *
 * Hybrid by design. The deterministic pass reads what a site published about
 * itself and costs nothing; the model runs only where that came back empty.
 * Most sites with any structured data never reach the model at all, and the
 * ones that do are exactly the bespoke marketing pages parsing cannot read.
 */

import type {
  PersonCandidate,
  PersonEnrichmentInput,
  PersonEnrichmentProvider,
  PersonEnrichmentResult,
  PersonSearchInput,
  PersonSearchResult,
  ProviderCapabilities,
} from '../provider';
import {
  fetchPage,
  loadRobots,
  type FetchOptions,
  type FetchOutcome,
  type FetchedPage,
} from './fetch';
import { extractSite, handleFromUrl, type ExtractedCompany } from './extract';
import { attributeToPeople, mergeAttribution } from './attribute';
import { extractWithModel, visibleText, type ExtractionModel } from './model-extract';
import { assignEmails, findEmails } from './emails';

export interface SiteProviderOptions extends FetchOptions {
  /** Omit to run deterministic-only; the crawl still works, it just reads less. */
  readonly model?: ExtractionModel;
}

export interface CrawlResult {
  readonly url: string;
  readonly finalUrl: string;
  readonly outcome: FetchOutcome;
  readonly company: ExtractedCompany;
  readonly people: readonly PersonCandidate[];
  /** Which halves contributed: `json-ld`, `opengraph`, `links`, `model`. */
  readonly usedSignals: readonly string[];
  readonly contentHash?: string;
  readonly fetchedAt: string;
  readonly detail?: string;
  /**
   * Set when the model pass was asked for and never answered.
   *
   * `people: []` alone is ambiguous — a homepage that names nobody and a model
   * that is down produce the identical result — and the two deserve opposite
   * treatment: one is a finished crawl, the other is worth trying again.
   */
  readonly extractionUnavailable?: string;
  /**
   * The page's visible prose, markup stripped.
   *
   * Carried so a caller that wants to reason about the page itself — reading
   * your *own* site to draft your profile, rather than mining someone else's
   * for leads — does not have to fetch it a second time.
   */
  readonly pageText?: string;
  /**
   * The company's shared inbox, when the page published one.
   *
   * The fallback for a site that names people but gives no personal address —
   * which is most of them. Kept off `company.identities` because it is a way
   * to reach the company, not a profile belonging to it.
   */
  readonly contactEmail?: string;
}

function emptyCompany(): ExtractedCompany {
  return { identities: [] };
}

export class SiteProvider implements PersonEnrichmentProvider {
  readonly #options: SiteProviderOptions;

  constructor(options: SiteProviderOptions = {}) {
    this.#options = options;
  }

  capabilities(): ProviderCapabilities {
    return {
      slug: 'site',
      displayName: 'Company website',
      networks: ['website', 'x', 'github', 'bluesky', 'linkedin'],
      // There is nothing to search: this provider answers about a URL you
      // already have. Discovery is the enrichment vendors' job.
      canSearch: false,
      canEnrich: true,
      licenseClass: 'public_web',
      sourceType: 'public_web',
      // Free apart from the model fallback, so the waterfall reaches it early.
      costPerEnrichmentUsd: 0,
    };
  }

  async search(_input: PersonSearchInput): Promise<PersonSearchResult> {
    return { candidates: [], costUsd: 0 };
  }

  /**
   * Enriches from a company domain.
   *
   * Returns the first named person as the candidate, because the interface is
   * one-candidate-shaped. `crawl` is the honest entry point for a URL that may
   * name several people, and it is what the pipeline calls.
   */
  async enrich(input: PersonEnrichmentInput): Promise<PersonEnrichmentResult> {
    const target = input.companyDomain ?? input.profileUrls?.[0];
    if (!target) return { matchConfidence: 0, costUsd: 0 };

    const result = await this.crawl(normaliseUrl(target));
    const candidate = result.people[0];

    if (!candidate) return { matchConfidence: 0, costUsd: 0 };
    return { candidate, matchConfidence: 0.6, costUsd: 0 };
  }

  async costEstimate(_input: PersonSearchInput | PersonEnrichmentInput): Promise<number> {
    return 0;
  }

  /**
   * Reads a site: the page asked for, plus the few pages that name people.
   *
   * A homepage is the wrong place to look for staff. It describes the company,
   * links to `/team` or `/about`, and names nobody — so a one-page crawl found
   * a company and no humans, or found humans with no job titles, which in
   * production was the same thing as finding nothing at all. (An untitled
   * person produced no signal, and no signal meant a card that could never
   * become outreach.) The pages that carry names and roles are exactly the
   * ones a homepage links to and a one-page crawl never opened.
   *
   * Bounded deliberately, because breadth is where a crawler turns into a
   * nuisance:
   *
   *   - Same origin only, and only paths that look like a team, about or
   *     contact page. Not a spider — a fixed shortlist.
   *   - At most `MAX_FOLLOWED` extra pages.
   *   - `robots.txt` is fetched once and passed to every page, so following
   *     four links costs one robots round trip rather than four, and a
   *     disallowed path is still refused.
   *   - The model runs at most once for the whole site, after the cheap
   *     deterministic reads of every page have been merged. Parsing four pages
   *     costs four fetches and nothing else; the expensive pass happens only
   *     if all four together still named nobody.
   *
   * A refusal — robots, a 404, a PDF — is a result, not an exception. One bad
   * URL in a batch of a hundred must not take the other ninety-nine with it,
   * and one unreadable sub-page must not discard the homepage that led to it.
   */
  async crawl(url: string): Promise<CrawlResult> {
    const page: FetchedPage = await fetchPage(url, this.#options);

    if (page.outcome !== 'ok' || !page.html) {
      return {
        url,
        finalUrl: page.finalUrl,
        outcome: page.outcome,
        company: emptyCompany(),
        people: [],
        usedSignals: [],
        fetchedAt: page.fetchedAt,
        ...(page.detail ? { detail: page.detail } : {}),
      };
    }

    const deterministic = extractSite(page.html, page.finalUrl);
    const usedSignals = new Set(deterministic.usedSignals);

    let company = deterministic.company;
    let people = [...deterministic.people];

    // Every page read, entry first, so addresses and prose can be re-read
    // below without fetching anything twice.
    const pages: FetchedPage[] = [page];

    // Robots once for the whole origin, reused by every follow.
    const robots =
      this.#options.robots ?? (await loadRobotsFor(page.finalUrl, this.#options)) ?? undefined;

    for (const href of peoplePageLinks(page.html, page.finalUrl)) {
      const sub = await fetchPage(href, { ...this.#options, ...(robots ? { robots } : {}) });
      if (sub.outcome !== 'ok' || !sub.html) continue;

      pages.push(sub);

      const readSub = extractSite(sub.html, sub.finalUrl);
      for (const signal of readSub.usedSignals) usedSignals.add(signal);

      company = mergeCompany(company, readSub.company);
      people = mergePeople(people, readSub.people);
    }

    // The hybrid's hinge, now asked about the site rather than a page. A site
    // whose team page carries JSON-LD never pays for the model; one whose
    // pages are all bespoke marketing still gets one call, not four.
    const needsPeople = people.length === 0;
    const needsName = !company.name;
    let extractionUnavailable: string | undefined;

    if (this.#options.model && (needsPeople || needsName)) {
      // Ask about the most likely page rather than always the homepage: if a
      // team page was followed, that is where the names are.
      const target = needsPeople ? (pages[pages.length - 1] ?? page) : page;

      const fromModel = await extractWithModel(
        this.#options.model,
        target.html ?? '',
        target.finalUrl,
        company,
      );

      extractionUnavailable = fromModel.unavailable;

      if (needsName && fromModel.company.name) {
        company = { ...company, name: fromModel.company.name };
      }
      if (!company.description && fromModel.company.description) {
        company = { ...company, description: fromModel.company.description };
      }
      if (needsPeople && fromModel.people.length > 0) {
        people = [...fromModel.people];
      }

      if (fromModel.company.name || fromModel.people.length > 0) usedSignals.add('model');
    }

    // ------------------------------------------------------- attribution
    //
    // Whose profile is whose, decided from where the page puts each link.
    //
    // This runs after the model pass because it needs the people, and the model
    // is usually what produced them: an ordinary team page publishes no JSON-LD
    // `Person`, which is why `PersonCandidate.identities` sat empty in
    // production for 208 people while their handles were on the page the whole
    // time. Links that belong to nobody in particular stay with the company.
    const attributedEmails = new Set<string>();

    if (people.length > 0) {
      const names = people.map((person) => person.fullName);

      // Every page read, not just the entry one. The crawl follows `/team` and
      // `/about`, and that is exactly where the cards are — attributing only
      // the page the crawl was pointed at would leave the feature reading a
      // homepage that names nobody.
      const attributed = mergeAttribution(
        pages
          .filter((read) => Boolean(read.html))
          .map((read) =>
            attributeToPeople({ html: read.html ?? '', people: names, handleOf: handleFromUrl }),
          ),
      );

      for (const address of attributed.emailsByPerson.values()) attributedEmails.add(address);

      if (attributed.identitiesByPerson.size > 0) {
        people = people.map((person) => {
          const extra = attributed.identitiesByPerson.get(person.fullName);
          if (!extra || extra.length === 0) return person;

          // Merged rather than replaced: a JSON-LD `sameAs` is a stronger
          // statement than anything inferred from layout, so it wins on a
          // collision.
          const byKey = new Map(
            extra.map((identity) => [
              `${identity.network}:${identity.handle?.toLowerCase()}`,
              identity,
            ]),
          );
          for (const identity of person.identities) {
            byKey.set(`${identity.network}:${identity.handle?.toLowerCase()}`, identity);
          }

          return { ...person, identities: [...byKey.values()] };
        });

        usedSignals.add('attribution');
      }

      // The company keeps what nobody claimed — and gives up what somebody did.
      //
      // `extractSite` files every link on the page against the company, which
      // was the only sensible answer before anything could tell whose was
      // whose. Left alone, the practice principal's personal X account stays
      // listed as the practice's own, and a later "post to the company's
      // account" would be posting to hers.
      const claimed = new Set<string>();
      for (const identities of attributed.identitiesByPerson.values()) {
        for (const identity of identities) {
          claimed.add(`${identity.network}:${identity.handle?.toLowerCase()}`);
        }
      }

      const byKey = new Map(
        company.identities
          .filter(
            (identity) => !claimed.has(`${identity.network}:${identity.handle?.toLowerCase()}`),
          )
          .map((identity) => [`${identity.network}:${identity.handle?.toLowerCase()}`, identity]),
      );

      for (const identity of attributed.companyIdentities) {
        const key = `${identity.network}:${identity.handle?.toLowerCase()}`;
        if (!byKey.has(key) && !claimed.has(key)) byKey.set(key, identity);
      }

      company = { ...company, identities: [...byKey.values()] };

      // An address inside somebody's own card is theirs, whatever it is called.
      if (attributed.emailsByPerson.size > 0) {
        people = people.map((person) => {
          const email = attributed.emailsByPerson.get(person.fullName);
          return email && !person.email ? { ...person, email } : person;
        });
        usedSignals.add('email');
      }
    }

    // Addresses are read last, once the people are known: matching
    // `jane@acme.com` to a person needs the person, and the model pass is
    // often what produced them. Read across every page, because the address
    // is usually on `/contact` and the people are usually on `/team`.
    const found = pages.flatMap((read) => (read.html ? findEmails(read.html) : []));
    let contactEmail: string | undefined;

    if (found.length > 0) {
      const assigned = assignEmails(
        found,
        people.map((person) => person.fullName),
        company.domain ?? hostOf(page.finalUrl),
      );

      if (assigned.byPerson.size > 0) {
        people = people.map((person) => {
          const email = assigned.byPerson.get(person.fullName);
          return email ? { ...person, email } : person;
        });
        usedSignals.add('email');
      }

      contactEmail = assigned.companyEmail;

      // An address already claimed by a named person is not the house inbox.
      //
      // `assignEmails` only recognises an address as somebody's when the local
      // part resembles their name, so `j.okafor@acme.com` sitting in Jane's own
      // card looks unclaimed to it — and on a page with no `info@` it would be
      // promoted to the company address. The company would then be written to
      // at a mailbox belonging to one employee.
      if (contactEmail && attributedEmails.has(contactEmail)) contactEmail = undefined;

      if (contactEmail) usedSignals.add('email');
    }

    return {
      url,
      finalUrl: page.finalUrl,
      outcome: 'ok',
      company,
      people,
      usedSignals: [...usedSignals],
      ...(contactEmail ? { contactEmail } : {}),
      ...(page.contentHash ? { contentHash: page.contentHash } : {}),
      fetchedAt: page.fetchedAt,
      ...(extractionUnavailable ? { extractionUnavailable } : {}),
      // The entry page's prose, not the whole site's. A caller reading its own
      // site to draft a profile means the page it named.
      pageText: visibleText(page.html),
    };
  }
}

/** How many pages beyond the entry one a single crawl may open. */
const MAX_FOLLOWED = 3;

/**
 * Paths worth opening for names and roles.
 *
 * A shortlist rather than a heuristic: these are the conventional names, and
 * anything cleverer starts spidering. Matched against the path and the link
 * text both, because plenty of sites route `/company` to a staff page and
 * label it "Meet the team".
 */
const PEOPLE_PAGE =
  /\b(team|about|about-us|contact|staff|people|leadership|our-team|who-we-are)\b/i;

/**
 * Same-origin links that look like they name people, in page order.
 *
 * Deduped by resolved URL, capped, and never the page we are already on.
 * Fragments and query strings are dropped so `/about#top` and `/about` are one
 * page rather than two fetches of the same HTML.
 */
export function peoplePageLinks(html: string, pageUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }

  const seen = new Set<string>([canonical(base)]);
  const found: string[] = [];

  for (const match of html.matchAll(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]{0,200}?)<\/a>/gi,
  )) {
    const href = match[1];
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) continue;

    let target: URL;
    try {
      target = new URL(href, base);
    } catch {
      continue;
    }

    if (target.origin !== base.origin) continue;
    if (!PEOPLE_PAGE.test(target.pathname) && !PEOPLE_PAGE.test(stripTags(match[3] ?? '')))
      continue;

    const key = canonical(target);
    if (seen.has(key)) continue;

    seen.add(key);
    found.push(key);

    if (found.length >= MAX_FOLLOWED) break;
  }

  return found;
}

/** Without the fragment or query, which never change which page was served. */
function canonical(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}`;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

/** Robots for a page's origin, or undefined if the URL will not parse. */
async function loadRobotsFor(pageUrl: string, options: SiteProviderOptions) {
  try {
    return await loadRobots(new URL(pageUrl).origin, options);
  } catch {
    return undefined;
  }
}

/**
 * Two reads of the same company, combined.
 *
 * First non-empty wins for the scalar fields — the entry page is read first
 * and is the more authoritative description of the company — while identities
 * union, because the profile links a contact page publishes are usually not
 * the ones the homepage does.
 */
function mergeCompany(base: ExtractedCompany, next: ExtractedCompany): ExtractedCompany {
  const identities = new Map(
    base.identities.map((identity) => [
      `${identity.network}:${identity.handle?.toLowerCase()}`,
      identity,
    ]),
  );

  for (const identity of next.identities) {
    const key = `${identity.network}:${identity.handle?.toLowerCase()}`;
    if (!identities.has(key)) identities.set(key, identity);
  }

  return {
    ...base,
    ...(base.name ? {} : next.name ? { name: next.name } : {}),
    ...(base.description ? {} : next.description ? { description: next.description } : {}),
    ...(base.domain ? {} : next.domain ? { domain: next.domain } : {}),
    identities: [...identities.values()],
  };
}

/**
 * People from several pages, deduped by name.
 *
 * The titled record wins. This is the whole point of following links: a
 * homepage that says "Jane Doe" and a team page that says "Jane Doe, Clinic
 * Director" are the same person, and the second one is the one that produces a
 * signal worth acting on. Merging field-by-field rather than replacing keeps
 * an email found on `/contact` when the title came from `/team`.
 */
function mergePeople(
  base: readonly PersonCandidate[],
  next: readonly PersonCandidate[],
): PersonCandidate[] {
  const byName = new Map<string, PersonCandidate>();

  for (const person of [...base, ...next]) {
    const key = person.fullName.trim().toLowerCase();
    if (!key) continue;

    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, person);
      continue;
    }

    byName.set(key, {
      ...existing,
      ...(existing.title ? {} : person.title ? { title: person.title } : {}),
      ...(existing.email ? {} : person.email ? { email: person.email } : {}),
      ...(existing.companyName
        ? {}
        : person.companyName
          ? { companyName: person.companyName }
          : {}),
      identities: mergeIdentities(existing, person),
    });
  }

  return [...byName.values()];
}

function mergeIdentities(a: PersonCandidate, b: PersonCandidate): PersonCandidate['identities'] {
  const merged = new Map(
    a.identities.map((identity) => [
      `${identity.network}:${identity.handle?.toLowerCase()}`,
      identity,
    ]),
  );

  for (const identity of b.identities) {
    const key = `${identity.network}:${identity.handle?.toLowerCase()}`;
    if (!merged.has(key)) merged.set(key, identity);
  }

  return [...merged.values()];
}

/** The host a page was finally served from, for matching addresses against. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** `example.com` and `https://example.com/` both mean the same thing here. */
export function normaliseUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, '')}`;
}
