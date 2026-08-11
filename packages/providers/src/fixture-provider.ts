/**
 * A deterministic in-memory provider.
 *
 * The whole pipeline — discovery, resolution, research, scoring, drafting —
 * must be runnable end to end with no API keys and no spend. This provider is
 * how tests, local development and CI do that. It is not a mock in the
 * test-double sense: it implements the real interface faithfully, including
 * partial matches and misses.
 */

import type {
  PersonCandidate,
  PersonEnrichmentInput,
  PersonEnrichmentProvider,
  PersonEnrichmentResult,
  PersonSearchInput,
  PersonSearchResult,
  ProviderCapabilities,
} from './provider';

export interface FixtureProviderOptions {
  readonly slug?: string;
  readonly costPerEnrichmentUsd?: number;
  readonly candidates?: readonly PersonCandidate[];
  /** Forces every call to throw, for exercising waterfall fallback. */
  readonly failWith?: string;
}

/** A small, realistic developer-tools dataset (PRD §45 launch wedge). */
export const FIXTURE_CANDIDATES: readonly PersonCandidate[] = [
  {
    fullName: 'Jane Smith',
    firstName: 'Jane',
    lastName: 'Smith',
    title: 'VP Engineering',
    seniority: 'vp',
    companyName: 'Acme',
    companyDomain: 'acme.com',
    employeeCount: 120,
    industry: 'SaaS',
    location: 'San Francisco Bay Area',
    country: 'United States',
    technologies: ['Next.js', 'Postgres', 'Stripe'],
    personalDomain: 'jane.dev',
    sourceRecordId: 'fixture-jane-smith',
    observedAt: '2026-08-01T00:00:00.000Z',
    identities: [
      { network: 'github', handle: 'janesmith', platformUserId: 'gh_1001' },
      { network: 'bluesky', handle: 'jane.dev', platformUserId: 'did:plc:jane' },
      { network: 'linkedin', profileUrl: 'https://www.linkedin.com/in/janesmith' },
      { network: 'website', profileUrl: 'https://jane.dev' },
    ],
  },
  {
    fullName: 'Alex Chen',
    firstName: 'Alex',
    lastName: 'Chen',
    title: 'Founder & CTO',
    seniority: 'founder',
    companyName: 'Loopwright',
    companyDomain: 'loopwright.io',
    employeeCount: 24,
    industry: 'Developer Tools',
    location: 'Berlin',
    country: 'Germany',
    technologies: ['TypeScript', 'Bun', 'SQLite'],
    sourceRecordId: 'fixture-alex-chen',
    observedAt: '2026-08-05T00:00:00.000Z',
    identities: [
      { network: 'github', handle: 'alexchen', platformUserId: 'gh_2002' },
      { network: 'x', handle: 'alexbuilds', platformUserId: 'x_2002' },
    ],
  },
  {
    fullName: 'Priya Raman',
    firstName: 'Priya',
    lastName: 'Raman',
    title: 'Head of Platform',
    seniority: 'director',
    companyName: 'Northwind Data',
    companyDomain: 'northwind.dev',
    employeeCount: 310,
    industry: 'SaaS',
    location: 'Toronto',
    country: 'Canada',
    technologies: ['Kubernetes', 'Go', 'Postgres'],
    sourceRecordId: 'fixture-priya-raman',
    observedAt: '2026-08-08T00:00:00.000Z',
    identities: [{ network: 'github', handle: 'praman', platformUserId: 'gh_3003' }],
  },
];

export class FixtureProvider implements PersonEnrichmentProvider {
  readonly #options: FixtureProviderOptions;
  readonly #candidates: readonly PersonCandidate[];

  constructor(options: FixtureProviderOptions = {}) {
    this.#options = options;
    this.#candidates = options.candidates ?? FIXTURE_CANDIDATES;
  }

  capabilities(): ProviderCapabilities {
    return {
      slug: this.#options.slug ?? 'fixture',
      displayName: 'Fixture provider',
      networks: ['github', 'bluesky', 'x', 'linkedin', 'website'],
      canSearch: true,
      canEnrich: true,
      licenseClass: 'customer_owned',
      sourceType: 'customer_data',
      costPerEnrichmentUsd: this.#options.costPerEnrichmentUsd ?? 0,
    };
  }

  async search(input: PersonSearchInput): Promise<PersonSearchResult> {
    this.#throwIfConfigured();

    const matches = this.#candidates.filter((candidate) => {
      if (input.titles?.length && !containsAny(candidate.title, input.titles)) return false;
      if (input.industries?.length && !containsAny(candidate.industry, input.industries)) {
        return false;
      }
      if (input.countries?.length && !containsAny(candidate.country, input.countries)) return false;
      if (
        input.technologies?.length &&
        !input.technologies.some((tech) =>
          (candidate.technologies ?? []).some((owned) => equalsIgnoreCase(owned, tech)),
        )
      ) {
        return false;
      }
      if (
        input.employeeCountMin !== undefined &&
        (candidate.employeeCount ?? 0) < input.employeeCountMin
      ) {
        return false;
      }
      if (
        input.employeeCountMax !== undefined &&
        (candidate.employeeCount ?? 0) > input.employeeCountMax
      ) {
        return false;
      }
      return true;
    });

    const limited = matches.slice(0, input.limit ?? matches.length);

    return {
      candidates: limited,
      costUsd: limited.length * this.capabilities().costPerEnrichmentUsd,
    };
  }

  async enrich(input: PersonEnrichmentInput): Promise<PersonEnrichmentResult> {
    this.#throwIfConfigured();

    const cost = this.capabilities().costPerEnrichmentUsd;

    for (const candidate of this.#candidates) {
      const confidence = matchConfidence(candidate, input);
      if (confidence > 0) {
        return { candidate, matchConfidence: confidence, costUsd: cost };
      }
    }

    // A miss still costs money at a real provider, which is why the waterfall
    // needs to know about it.
    return { matchConfidence: 0, costUsd: cost };
  }

  async costEstimate(): Promise<number> {
    return this.capabilities().costPerEnrichmentUsd;
  }

  #throwIfConfigured(): void {
    if (this.#options.failWith) throw new Error(this.#options.failWith);
  }
}

/**
 * How completely a fixture record answers the query.
 *
 * An exact handle or domain match is near-certain; a bare name match is not,
 * which is what lets the waterfall keep walking for something better.
 */
function matchConfidence(candidate: PersonCandidate, input: PersonEnrichmentInput): number {
  if (input.handles) {
    for (const [network, handle] of Object.entries(input.handles)) {
      const hit = candidate.identities.some(
        (identity) => identity.network === network && equalsIgnoreCase(identity.handle, handle),
      );
      if (hit) return 0.98;
    }
  }

  if (input.email) {
    const domain = input.email.split('@')[1];
    if (
      domain &&
      (equalsIgnoreCase(candidate.companyDomain, domain) ||
        equalsIgnoreCase(candidate.personalDomain, domain)) &&
      equalsIgnoreCase(candidate.fullName, input.fullName)
    ) {
      return 0.95;
    }
  }

  if (input.fullName && equalsIgnoreCase(candidate.fullName, input.fullName)) {
    return equalsIgnoreCase(candidate.companyDomain, input.companyDomain) ? 0.92 : 0.6;
  }

  return 0;
}

function equalsIgnoreCase(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function containsAny(value: string | undefined, candidates: readonly string[]): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return candidates.some((candidate) => lower.includes(candidate.toLowerCase()));
}
