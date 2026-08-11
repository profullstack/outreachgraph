/**
 * GitHub as an enrichment provider (PRD §10.1, §16.6, §45).
 *
 * This is the launch wedge's cheapest useful source: a public GitHub profile
 * frequently states the person's employer, personal domain and X handle in
 * fields they filled in themselves. That is the strongest class of identity
 * evidence available (PRD §9.3 `cross_linked_profile`), and it costs nothing.
 */

import type { CandidateIdentity, PersonCandidate } from '../provider';
import type {
  PersonEnrichmentInput,
  PersonEnrichmentProvider,
  PersonEnrichmentResult,
  PersonSearchInput,
  PersonSearchResult,
  ProviderCapabilities,
} from '../provider';
import {
  GitHubClient,
  GitHubNotFoundError,
  type GitHubClientOptions,
  type GitHubUser,
} from './client';

export interface GitHubProviderOptions extends GitHubClientOptions {
  /** Cap on profiles fetched per search, to bound unauthenticated quota use. */
  readonly maxSearchHydrations?: number;
}

export class GitHubProvider implements PersonEnrichmentProvider {
  readonly #client: GitHubClient;
  readonly #maxHydrations: number;

  constructor(options: GitHubProviderOptions = {}) {
    this.#client = new GitHubClient(options);
    this.#maxHydrations = options.maxSearchHydrations ?? 10;
  }

  capabilities(): ProviderCapabilities {
    return {
      slug: 'github',
      displayName: 'GitHub',
      networks: ['github', 'x', 'website'],
      canSearch: true,
      canEnrich: true,
      licenseClass: 'public_api',
      sourceType: 'official_api',
      // Free, so the waterfall consults it before any paid provider.
      costPerEnrichmentUsd: 0,
    };
  }

  async search(input: PersonSearchInput): Promise<PersonSearchResult> {
    const query = buildSearchQuery(input);
    if (!query) return { candidates: [], costUsd: 0 };

    const results = await this.#client.searchUsers(query, input.limit ?? 20);
    const logins = results.items.slice(0, this.#maxHydrations).map((item) => item.login);

    // Search returns logins only; the useful fields need a profile fetch each.
    const candidates: PersonCandidate[] = [];
    for (const login of logins) {
      try {
        candidates.push(toCandidate(await this.#client.getUser(login)));
      } catch (error) {
        if (error instanceof GitHubNotFoundError) continue;
        throw error;
      }
    }

    return { candidates, costUsd: 0 };
  }

  async enrich(input: PersonEnrichmentInput): Promise<PersonEnrichmentResult> {
    const login = input.handles?.github;

    if (login) {
      try {
        const user = await this.#client.getUser(login);
        // An exact handle lookup is as certain as this source gets.
        return { candidate: toCandidate(user), matchConfidence: 0.98, costUsd: 0 };
      } catch (error) {
        if (!(error instanceof GitHubNotFoundError)) throw error;
        return { matchConfidence: 0, costUsd: 0 };
      }
    }

    // Without a handle, fall back to search — much weaker, and deliberately
    // scored so the waterfall keeps looking for something better.
    const query = buildSearchQuery({
      ...(input.fullName ? { keywords: [input.fullName] } : {}),
    });
    if (!query) return { matchConfidence: 0, costUsd: 0 };

    const results = await this.#client.searchUsers(query, 5);
    const first = results.items[0];
    if (!first) return { matchConfidence: 0, costUsd: 0 };

    const user = await this.#client.getUser(first.login);
    const candidate = toCandidate(user);

    return { candidate, matchConfidence: confidenceForNameMatch(user, input), costUsd: 0 };
  }

  async costEstimate(): Promise<number> {
    return 0;
  }

  /** Raw activity for the signal extractor. */
  async activity(login: string, limit = 50) {
    const [events, repos] = await Promise.all([
      this.#client.getPublicEvents(login, limit),
      this.#client.getRepos(login, 20),
    ]);
    return { events, repos };
  }
}

/**
 * Maps a GitHub profile onto the canonical candidate shape.
 *
 * The identity list is where the value is: `twitter_username` and `blog` are
 * links the person published about themselves, so the resolver can treat them
 * as cross-links rather than inferences.
 */
export function toCandidate(user: GitHubUser): PersonCandidate {
  const identities: CandidateIdentity[] = [
    {
      network: 'github',
      handle: user.login,
      platformUserId: String(user.id),
      profileUrl: user.html_url,
      providerConfidence: 1,
    },
  ];

  if (user.twitter_username) {
    identities.push({
      network: 'x',
      handle: user.twitter_username,
      profileUrl: `https://x.com/${user.twitter_username}`,
      // Self-declared on their own profile, but GitHub does not verify it.
      providerConfidence: 0.9,
    });
  }

  const personalDomain = domainOf(user.blog);
  if (user.blog && personalDomain) {
    identities.push({
      network: 'website',
      profileUrl: normalizeUrl(user.blog),
      providerConfidence: 0.9,
    });
  }

  const [firstName, lastName] = splitName(user.name ?? user.login);

  return {
    fullName: user.name ?? user.login,
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(user.company ? { companyName: cleanCompany(user.company) } : {}),
    ...(user.location ? { location: user.location } : {}),
    ...(personalDomain ? { personalDomain } : {}),
    identities,
    sourceRecordId: `github:${user.id}`,
    observedAt: new Date().toISOString(),
  };
}

/**
 * GitHub company fields are free text and usually carry an `@org` handle.
 * Stripping it makes employer comparison work against provider data.
 */
export function cleanCompany(raw: string): string {
  return raw.replace(/^@/, '').replace(/\s+/g, ' ').trim();
}

export function domainOf(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '') || undefined;
  } catch {
    return undefined;
  }
}

function normalizeUrl(raw: string): string {
  return raw.startsWith('http') ? raw : `https://${raw}`;
}

function splitName(full: string): [string | undefined, string | undefined] {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return [parts[0], undefined];
  return [parts[0], parts[parts.length - 1]];
}

function buildSearchQuery(input: PersonSearchInput): string {
  const terms: string[] = [];

  for (const keyword of input.keywords ?? []) terms.push(keyword);
  for (const tech of input.technologies ?? []) terms.push(`language:${tech}`);
  for (const country of input.countries ?? []) terms.push(`location:${quote(country)}`);

  return terms.join(' ').trim();
}

function quote(value: string): string {
  return value.includes(' ') ? `"${value}"` : value;
}

/**
 * A name-only match is weak: GitHub search happily returns someone else with
 * the same display name. Corroborating employer or domain raises it.
 */
function confidenceForNameMatch(user: GitHubUser, input: PersonEnrichmentInput): number {
  if (!input.fullName) return 0.3;

  const sameName = (user.name ?? '').toLowerCase() === input.fullName.toLowerCase();
  if (!sameName) return 0.2;

  const domain = domainOf(user.blog);
  if (input.companyDomain && domain === input.companyDomain.toLowerCase()) return 0.85;

  if (
    input.companyName &&
    user.company &&
    cleanCompany(user.company).toLowerCase() === input.companyName.toLowerCase()
  ) {
    return 0.8;
  }

  return 0.45;
}
