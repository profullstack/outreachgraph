/**
 * Asking every configured provider what else it knows about one person.
 *
 * The waterfall picks *one* provider to answer a question cheaply. This is the
 * other shape: a candidate already exists, and each provider is asked to add
 * the identities it can vouch for. A crawl that produced a name and an X handle
 * gains a Bluesky profile here, and only then does the resolver decide whether
 * any of it is the same human.
 *
 * Nothing here merges anything. It gathers claims; `@outreachgraph/identity`
 * weighs them. Keeping those apart is what stops a provider's confidence from
 * quietly becoming the product's confidence.
 */

import type { Network } from '@outreachgraph/domain';
import type { CandidateIdentity, PersonCandidate, PersonEnrichmentProvider } from './provider';

export interface FanOutAttempt {
  readonly provider: string;
  readonly ok: boolean;
  readonly found: number;
  readonly error?: string;
}

export interface FanOutResult {
  /** The candidate with everything discovered folded in. */
  readonly candidate: PersonCandidate;
  readonly attempts: readonly FanOutAttempt[];
  readonly costUsd: number;
}

function key(identity: CandidateIdentity): string {
  return `${identity.network}:${(identity.platformUserId ?? identity.handle ?? '').toLowerCase()}`;
}

/**
 * Runs every provider that can add something, and folds the results together.
 *
 * A provider is only asked when the candidate already carries a handle it can
 * resolve. Handing a display name to a network with no verification and taking
 * the first match is how the wrong person ends up in an approval queue, so
 * discovery here is strictly "resolve what we were told", never "find someone
 * who looks like this".
 *
 * One provider failing never fails the fan-out. A quota wall on one network is
 * not a reason to discard what the others returned.
 */
export async function findIdentities(
  candidate: PersonCandidate,
  providers: readonly PersonEnrichmentProvider[],
): Promise<FanOutResult> {
  const merged = new Map<string, CandidateIdentity>();
  for (const identity of candidate.identities) merged.set(key(identity), identity);

  const attempts: FanOutAttempt[] = [];
  let costUsd = 0;

  const known: Partial<Record<Network, string>> = {};
  for (const identity of candidate.identities) {
    if (identity.handle) known[identity.network] = identity.handle;
  }

  for (const provider of providers) {
    const capabilities = provider.capabilities();
    if (!capabilities.canEnrich) continue;

    // Only ask a provider about a network we already hold a handle for.
    const usable = capabilities.networks.some((network) => known[network]);
    if (!usable) continue;

    try {
      const result = await provider.enrich({
        fullName: candidate.fullName,
        ...(candidate.companyDomain ? { companyDomain: candidate.companyDomain } : {}),
        ...(candidate.companyName ? { companyName: candidate.companyName } : {}),
        handles: known,
      });

      costUsd += result.costUsd;

      let found = 0;
      for (const identity of result.candidate?.identities ?? []) {
        const id = key(identity);
        if (merged.has(id)) continue;
        merged.set(id, identity);
        found += 1;
      }

      attempts.push({ provider: capabilities.slug, ok: true, found });
    } catch (error) {
      attempts.push({
        provider: capabilities.slug,
        ok: false,
        found: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    candidate: { ...candidate, identities: [...merged.values()] },
    attempts,
    costUsd,
  };
}
