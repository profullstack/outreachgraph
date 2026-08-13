/**
 * Bluesky as an identity source (capability matrix: `bluesky/observe` is
 * `official_api`, "public AppView feed and profile data").
 *
 * First after GitHub for one reason: the AppView is genuinely public. No key,
 * no contract, no per-seat cost — so it can ship and be tested without a
 * commercial decision attached, which is not true of X or an enrichment vendor.
 *
 * Read-only. Every write action on this network is `official_api` in the
 * matrix and belongs to the execution path, not to research.
 */

import type { FetchLike } from '../site/fetch';
import type {
  CandidateIdentity,
  PersonCandidate,
  PersonEnrichmentInput,
  PersonEnrichmentProvider,
  PersonEnrichmentResult,
  PersonSearchInput,
  PersonSearchResult,
  ProviderCapabilities,
} from '../provider';

export const BLUESKY_API = 'https://public.api.bsky.app';

export interface BlueskyProviderOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

interface ActorProfile {
  did?: string;
  handle?: string;
  displayName?: string;
  description?: string;
}

/** Raised for a quota wall, so callers can keep partial work as GitHub does. */
export class BlueskyRateLimitError extends Error {
  constructor() {
    super('bluesky rate limit reached');
    this.name = 'BlueskyRateLimitError';
  }
}

export class BlueskyProvider implements PersonEnrichmentProvider {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: BlueskyProviderOptions = {}) {
    this.#baseUrl = options.baseUrl ?? BLUESKY_API;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  capabilities(): ProviderCapabilities {
    return {
      slug: 'bluesky',
      displayName: 'Bluesky',
      networks: ['bluesky'],
      canSearch: true,
      canEnrich: true,
      licenseClass: 'public_api',
      sourceType: 'official_api',
      costPerEnrichmentUsd: 0,
    };
  }

  async #get<T>(path: string, params: Record<string, string>): Promise<T | undefined> {
    const url = new URL(`/xrpc/${path}`, this.#baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const response = await this.#fetch(url.toString(), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (response.status === 429) throw new BlueskyRateLimitError();
    // A missing actor is an answer, not a fault: most people are not here.
    if (response.status === 400 || response.status === 404) return undefined;
    if (!response.ok) throw new Error(`bluesky ${path} failed: ${response.status}`);

    return (await response.json()) as T;
  }

  async search(input: PersonSearchInput): Promise<PersonSearchResult> {
    const query = input.keywords?.join(' ').trim();
    if (!query) return { candidates: [], costUsd: 0 };

    const result = await this.#get<{ actors?: ActorProfile[] }>('app.bsky.actor.searchActors', {
      q: query,
      limit: String(Math.min(input.limit ?? 20, 50)),
    });

    const observedAt = new Date().toISOString();
    const candidates = (result?.actors ?? [])
      .filter((actor) => actor.handle)
      .map((actor) => toCandidate(actor, observedAt));

    return { candidates, costUsd: 0 };
  }

  /**
   * Resolves one Bluesky identity.
   *
   * Only a known handle is looked up. Searching by display name and taking the
   * first hit is how a product confidently attaches the wrong person: names are
   * not unique and this network has no verification to break the tie. Finding
   * nobody is the correct answer to a name.
   */
  async enrich(input: PersonEnrichmentInput): Promise<PersonEnrichmentResult> {
    const handle = input.handles?.bluesky;
    if (!handle) return { matchConfidence: 0, costUsd: 0 };

    const profile = await this.#get<ActorProfile>('app.bsky.actor.getProfile', { actor: handle });
    if (!profile?.handle) return { matchConfidence: 0, costUsd: 0 };

    return {
      candidate: toCandidate(profile, new Date().toISOString()),
      // The handle was supplied and the profile exists: this is a resolution,
      // not a guess.
      matchConfidence: 1,
      costUsd: 0,
    };
  }

  async costEstimate(_input: PersonSearchInput | PersonEnrichmentInput): Promise<number> {
    return 0;
  }
}

function toCandidate(actor: ActorProfile, observedAt: string): PersonCandidate {
  const identity: CandidateIdentity = {
    network: 'bluesky',
    handle: actor.handle!,
    ...(actor.did ? { platformUserId: actor.did } : {}),
    profileUrl: `https://bsky.app/profile/${actor.handle}`,
    providerConfidence: 1,
  };

  return {
    fullName: actor.displayName?.trim() || actor.handle!,
    identities: [identity],
    ...(actor.did ? { sourceRecordId: actor.did } : {}),
    observedAt,
  };
}
