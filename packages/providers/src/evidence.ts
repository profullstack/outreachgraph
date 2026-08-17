/**
 * Turning provider output into identity evidence (PRD §9.3, §10.2).
 *
 * The waterfall produces candidates; the resolver consumes evidence. This is
 * the bridge, and it is deliberately conservative: it only emits evidence for
 * facts actually present in the candidate, never inferred ones.
 */

import type { EvidenceInput } from '@outreachgraph/identity';
import type { CandidateIdentity, PersonCandidate, ProviderCapabilities } from './provider';

export interface EvidenceContext {
  /** The identity being linked to the person. */
  readonly identity: CandidateIdentity;
  readonly candidate: PersonCandidate;
  readonly capabilities: ProviderCapabilities;
  /** Handles the person publishes on their own site or profiles. */
  readonly crossLinkedHandles?: readonly string[];
  /** Employer stated on the platform profile, when the platform exposes one. */
  readonly platformEmployer?: string;
  readonly platformLocation?: string;
}

/**
 * Derives evidence for linking one platform identity to a candidate person.
 *
 * Note what is absent: no evidence is produced from name similarity alone
 * beyond `exact_name_match`, and that carries almost no weight. Precision
 * beats recall (PRD §48 Decision 4).
 */
export function deriveEvidence(context: EvidenceContext): EvidenceInput[] {
  const { identity, candidate, capabilities } = context;
  const evidence: EvidenceInput[] = [];

  // The provider returned this account on the person's own record.
  if (capabilities.sourceType === 'provider' || capabilities.sourceType === 'customer_data') {
    evidence.push({
      kind: 'provider_asserted_link',
      strength: identity.providerConfidence ?? 0.9,
      detail: `${capabilities.displayName} returned ${identity.network} account on this record`,
    });
  }

  // Found next to the person's name on a page about them. Not a statement by
  // them, which is why it is its own kind rather than a weaker cross-link:
  // without it a layout-derived identity scores on `same_employer` alone, falls
  // under the candidate threshold, and is dropped — leaving the person
  // reachable only on `website`, where no outreach is permitted at all.
  //
  // Strength is 1 because the observation is binary — the link either sits
  // beside the name or it does not. How much that is worth is the weight's job;
  // discounting here as well would price the same doubt twice and sink it back
  // below the threshold.
  if (identity.inferred) {
    evidence.push({
      kind: 'published_beside_name',
      strength: 1,
      detail: `${identity.network} profile published beside this person's name`,
    });
  }

  // The person published the link themselves — the strongest thing available.
  const handle = identity.handle?.toLowerCase();
  if (handle && context.crossLinkedHandles?.some((h) => h.toLowerCase() === handle)) {
    evidence.push({
      kind: 'cross_linked_profile',
      strength: 1,
      detail: `${identity.network} handle @${identity.handle} is linked from the person's own profile`,
    });
  }

  // A profile URL on the person's own domain.
  if (candidate.personalDomain && identity.profileUrl?.includes(candidate.personalDomain)) {
    evidence.push({
      kind: 'same_personal_domain',
      strength: 1,
      detail: `profile is hosted on ${candidate.personalDomain}`,
    });
  }

  if (context.platformEmployer && candidate.companyName) {
    const same = normalize(context.platformEmployer) === normalize(candidate.companyName);
    evidence.push(
      same
        ? {
            kind: 'same_employer',
            strength: 1,
            detail: `both list ${candidate.companyName}`,
          }
        : {
            kind: 'conflicting_employer',
            strength: 1,
            detail: `profile lists ${context.platformEmployer}, record lists ${candidate.companyName}`,
          },
    );
  }

  if (context.platformLocation && candidate.location) {
    const same = sharesToken(context.platformLocation, candidate.location);
    if (same) {
      evidence.push({
        kind: 'same_location',
        strength: 1,
        detail: `both indicate ${candidate.location}`,
      });
    }
  }

  return evidence;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|gmbh|corp|co)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/** Loose location comparison — "Berlin, Germany" matches "Berlin". */
function sharesToken(a: string, b: string): boolean {
  const tokens = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((token) => token.length > 3),
    );

  const left = tokens(a);
  for (const token of tokens(b)) {
    if (left.has(token)) return true;
  }
  return false;
}
