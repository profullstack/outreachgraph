/**
 * Evidence weights for identity resolution (PRD §9.5).
 *
 * A weight is the confidence a single piece of evidence would carry on its
 * own, at full strength. `same_personal_domain` at 0.85 means: if the only
 * thing we know is that both accounts link the same personal domain, that
 * alone lands in the "high" band but not the auto-merge band.
 *
 * Weights are data so they can be tuned against labelled outcomes without
 * touching the scoring logic.
 */

import type {
  EvidenceKind,
  NegativeEvidenceKind,
  PositiveEvidenceKind,
} from '@outreachgraph/domain';

export type WeightTable = Readonly<Record<EvidenceKind, number>>;

/**
 * Positive weights.
 *
 * Ordering rationale: evidence a third party asserted, or that the person
 * published themselves, outranks anything inferred from similarity. Name and
 * location similarity are deliberately weak — "same name, same city" is the
 * classic false-merge trap, and precision beats recall here (PRD §48
 * Decision 4).
 */
const POSITIVE: Readonly<Record<PositiveEvidenceKind, number>> = {
  // The person published the link themselves — strongest available evidence.
  cross_linked_profile: 0.92,
  same_personal_domain: 0.85,
  same_public_email: 0.9,
  // A licensed provider returned both accounts on one record.
  provider_asserted_link: 0.8,
  same_username: 0.55,
  same_employer: 0.45,
  temporal_employment_consistency: 0.3,
  uncommon_name_match: 0.4,
  same_title: 0.2,
  bio_similarity: 0.25,
  same_location: 0.15,
  // Common names carry almost no information on their own.
  exact_name_match: 0.1,
  // Perceptual photo matching is available only where legally and
  // contractually appropriate, so it is weighted as corroboration, not proof.
  profile_photo_match: 0.5,
};

/**
 * Negative weights, applied as penalties.
 *
 * `different_platform_user_id` and `impossible_timeline` are disqualifying:
 * they describe facts that cannot both be true of one person, so they zero the
 * score rather than reducing it.
 */
const NEGATIVE: Readonly<Record<NegativeEvidenceKind, number>> = {
  different_platform_user_id: 1,
  impossible_timeline: 1,
  conflicting_employer: 0.45,
  incompatible_geography: 0.35,
  conflicting_name: 0.6,
  inconsistent_linked_websites: 0.3,
};

/** Negative evidence that forces a rejection regardless of positive support. */
export const DISQUALIFYING: readonly NegativeEvidenceKind[] = [
  'different_platform_user_id',
  'impossible_timeline',
];

export const DEFAULT_WEIGHTS: WeightTable = { ...POSITIVE, ...NEGATIVE };

export function isDisqualifying(kind: EvidenceKind): boolean {
  return (DISQUALIFYING as readonly EvidenceKind[]).includes(kind);
}
