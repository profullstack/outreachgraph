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
import { fetchPage, type FetchOptions, type FetchOutcome, type FetchedPage } from './fetch';
import { extractSite, type ExtractedCompany } from './extract';
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
   * Fetches one page and reads it.
   *
   * A refusal — robots, a 404, a PDF — is a result, not an exception. One bad
   * URL in a batch of a hundred must not take the other ninety-nine with it.
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
    const usedSignals = [...deterministic.usedSignals];

    let company = deterministic.company;
    let people = [...deterministic.people];

    // The hybrid's hinge. The model is asked only for what parsing missed, so a
    // page with JSON-LD people never pays for it — and a page whose only claim
    // to a company name was its <title> can still get a better one.
    const needsPeople = people.length === 0;
    const needsName = !company.name;
    let extractionUnavailable: string | undefined;

    if (this.#options.model && (needsPeople || needsName)) {
      const fromModel = await extractWithModel(
        this.#options.model,
        page.html,
        page.finalUrl,
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

      if (fromModel.company.name || fromModel.people.length > 0) usedSignals.push('model');
    }

    // Addresses are read last, once the people are known: matching
    // `jane@acme.com` to a person needs the person, and the model pass is
    // often what produced them.
    const found = findEmails(page.html);
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
        usedSignals.push('email');
      }

      contactEmail = assigned.companyEmail;
      if (contactEmail && !usedSignals.includes('email')) usedSignals.push('email');
    }

    return {
      url,
      finalUrl: page.finalUrl,
      outcome: 'ok',
      company,
      people,
      usedSignals,
      ...(contactEmail ? { contactEmail } : {}),
      ...(page.contentHash ? { contentHash: page.contentHash } : {}),
      fetchedAt: page.fetchedAt,
      ...(extractionUnavailable ? { extractionUnavailable } : {}),
      pageText: visibleText(page.html),
    };
  }
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
