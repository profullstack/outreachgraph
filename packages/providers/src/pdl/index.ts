/**
 * People Data Labs: a person's name, title, LinkedIn and employer from their
 * email address.
 *
 * Optional, behind `PDL_API_KEY`, and the only paid person source here on
 * purpose: PDL's terms allow storing what it returns inside a product, which
 * Apollo's do not (Apollo data must never be written to this database). A
 * free key carries 100 matches a month, and a 404 (no match) is not charged,
 * so the caller caps lookups per day and asks only for leads still missing a
 * title or a profile after the free sources.
 *
 * Measured on our own list (2026-10-06): PDL's titles are Apollo's titles
 * verbatim (a shared upstream), work addresses match about half the time,
 * personal addresses rarely.
 */

import { SearchOutOfCredits } from '../valueserp';

export interface PersonEnrichment {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly title?: string;
  /** `https://www.linkedin.com/in/<slug>` */
  readonly linkedinUrl?: string;
  readonly companyName?: string;
  /** The employer's domain, e.g. `acme.com`. */
  readonly companyDomain?: string;
  /** PDL's own 1-10 confidence that the match is this person. */
  readonly likelihood?: number;
}

export interface PersonEnricher {
  readonly name: string;
  /** One person by address, or undefined for no match. Throws SearchOutOfCredits on 402. */
  enrichByEmail(email: string): Promise<PersonEnrichment | undefined>;
}

export interface PeopleDataLabsOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Matches below this likelihood are not taken. PDL's scale is 1-10. */
  readonly minLikelihood?: number;
}

interface PdlPerson {
  readonly first_name?: unknown;
  readonly last_name?: unknown;
  readonly job_title?: unknown;
  readonly linkedin_url?: unknown;
  readonly job_company_name?: unknown;
  readonly job_company_website?: unknown;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const titleCase = (value: string | undefined): string | undefined =>
  value?.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());

export class PeopleDataLabsClient implements PersonEnricher {
  readonly name = 'pdl';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly minLikelihood: number;

  constructor(options: PeopleDataLabsOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.peopledatalabs.com').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.minLikelihood = options.minLikelihood ?? 6;
  }

  async enrichByEmail(email: string): Promise<PersonEnrichment | undefined> {
    const url = new URL('/v5/person/enrich', this.baseUrl);
    url.searchParams.set('email', email);
    url.searchParams.set('min_likelihood', String(this.minLikelihood));

    const response = await this.fetchImpl(url, {
      headers: { 'X-Api-Key': this.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return undefined;
    if (response.status === 402) throw new SearchOutOfCredits('People Data Labs');
    if (!response.ok) throw new Error(`People Data Labs answered ${response.status}`);

    const body = (await response.json().catch(() => ({}))) as {
      likelihood?: unknown;
      data?: PdlPerson;
    };
    const person = body.data;
    if (!person) return undefined;

    const linkedin = text(person.linkedin_url);
    const website = text(person.job_company_website)
      ?.toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split(/[/?#]/)[0];

    const out: PersonEnrichment = {
      ...(titleCase(text(person.first_name))
        ? { firstName: titleCase(text(person.first_name))! }
        : {}),
      ...(titleCase(text(person.last_name))
        ? { lastName: titleCase(text(person.last_name))! }
        : {}),
      ...(titleCase(text(person.job_title)) ? { title: titleCase(text(person.job_title))! } : {}),
      ...(linkedin
        ? {
            linkedinUrl: `https://www.${linkedin.replace(/^https?:\/\//, '').replace(/^www\./, '')}`,
          }
        : {}),
      ...(titleCase(text(person.job_company_name))
        ? { companyName: titleCase(text(person.job_company_name))! }
        : {}),
      ...(website && website.includes('.') ? { companyDomain: website } : {}),
      ...(typeof body.likelihood === 'number' ? { likelihood: body.likelihood } : {}),
    };
    return out;
  }
}
