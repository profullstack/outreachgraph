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
import { extractSite, handleFromUrl, type ExtractedCompany } from './extract';
import { attributeToPeople } from './attribute';
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
      const attributed = attributeToPeople({
        html: page.html,
        people: people.map((person) => person.fullName),
        handleOf: handleFromUrl,
      });

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

        usedSignals.push('attribution');
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
        if (!usedSignals.includes('email')) usedSignals.push('email');
      }
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

      // An address already claimed by a named person is not the house inbox.
      //
      // `assignEmails` only recognises an address as somebody's when the local
      // part resembles their name, so `j.okafor@acme.com` sitting in Jane's own
      // card looks unclaimed to it — and on a page with no `info@` it would be
      // promoted to the company address. The company would then be written to
      // at a mailbox belonging to one employee.
      if (contactEmail && attributedEmails.has(contactEmail)) contactEmail = undefined;

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
