/**
 * Canonical people, companies and social identities (PRD §9.1–§9.3).
 *
 * A canonical person is an internal entity that may map to many external
 * identifiers. Nothing outside the identity resolver may create the mapping.
 */

import type { PrefixedId } from './ids';
import type { Network } from './networks';
import type { SourceType } from './provenance';

export interface Company {
  readonly id: PrefixedId<'company'>;
  readonly name: string;
  readonly domain?: string;
  readonly employeeCount?: number;
  readonly industry?: string;
  readonly location?: string;
  readonly technologies?: readonly string[];
  readonly fundingStage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const PERSON_STATUS = ['active', 'suppressed', 'deleted'] as const;
export type PersonStatus = (typeof PERSON_STATUS)[number];

export interface Person {
  readonly id: PrefixedId<'person'>;
  readonly displayName: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly currentCompanyId?: PrefixedId<'company'>;
  readonly currentTitle?: string;
  readonly location?: string;
  /** Aggregate confidence that this person's identities are all the same human. */
  readonly identityConfidence: number;
  readonly status: PersonStatus;
  /**
   * False when the person must not be contacted — suppression, a minor, or a
   * confidence level below the workspace threshold (PRD §17.5).
   */
  readonly outreachEligible: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastResolvedAt?: string;
}

export interface PersonEmployment {
  readonly personId: PrefixedId<'person'>;
  readonly companyId: PrefixedId<'company'>;
  readonly title?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly isCurrent: boolean;
}

export interface SocialIdentity {
  readonly id: PrefixedId<'socialIdentity'>;
  readonly personId: PrefixedId<'person'>;
  readonly network: Network;
  readonly handle?: string;
  /** Stable platform-side id. Preferred join key — handles get renamed. */
  readonly platformUserId?: string;
  readonly profileUrl?: string;
  readonly confidence: number;
  readonly sourceType: SourceType;
  /** Names of the evidence kinds that supported this link, for display. */
  readonly verifiedBy: readonly string[];
  readonly firstSeenAt: string;
  readonly lastVerifiedAt?: string;
}

/**
 * Evidence kinds the resolver understands (PRD §9.3).
 *
 * Positive evidence raises the match score; negative evidence applies a
 * contradiction penalty. Keeping both in one enum means an evidence row always
 * names a known kind and the weight table can be exhaustively checked.
 */
export const POSITIVE_EVIDENCE = [
  'provider_asserted_link',
  'cross_linked_profile',
  'same_personal_domain',
  'same_public_email',
  'same_username',
  'same_employer',
  'same_title',
  'same_location',
  'uncommon_name_match',
  'exact_name_match',
  'bio_similarity',
  'temporal_employment_consistency',
  'profile_photo_match',
] as const;

export const NEGATIVE_EVIDENCE = [
  'conflicting_employer',
  'incompatible_geography',
  'conflicting_name',
  'impossible_timeline',
  'inconsistent_linked_websites',
  'different_platform_user_id',
] as const;

export type PositiveEvidenceKind = (typeof POSITIVE_EVIDENCE)[number];
export type NegativeEvidenceKind = (typeof NEGATIVE_EVIDENCE)[number];
export type EvidenceKind = PositiveEvidenceKind | NegativeEvidenceKind;

export function isNegativeEvidence(kind: EvidenceKind): kind is NegativeEvidenceKind {
  return (NEGATIVE_EVIDENCE as readonly string[]).includes(kind);
}

/**
 * One observation supporting or contradicting a link. Stored rather than
 * collapsed into a score so a reviewer can see why the system believes it
 * (PRD §9.3) and so scores can be recomputed when weights change.
 */
export interface IdentityEvidence {
  readonly id: PrefixedId<'identityEvidence'>;
  readonly kind: EvidenceKind;
  /** Human-readable statement shown in the provenance panel. */
  readonly detail: string;
  /** 0..1 — how strongly this observation holds, before weighting. */
  readonly strength: number;
  readonly sourceType: SourceType;
  readonly sourceUrl?: string;
  readonly observedAt: string;
}

/**
 * A proposed link awaiting a decision. Created when the score lands in the
 * candidate band (PRD §9.4) or when a merge needs human review.
 */
export interface IdentityCandidate {
  readonly id: PrefixedId<'identityCandidate'>;
  readonly workspaceId: PrefixedId<'workspace'>;
  readonly personId: PrefixedId<'person'>;
  readonly network: Network;
  readonly handle?: string;
  readonly platformUserId?: string;
  readonly profileUrl?: string;
  readonly score: number;
  readonly evidence: readonly IdentityEvidence[];
  readonly status: IdentityCandidateStatus;
  readonly createdAt: string;
  readonly decidedAt?: string;
  readonly decidedBy?: PrefixedId<'user'>;
}

export const IDENTITY_CANDIDATE_STATUS = ['pending', 'accepted', 'rejected'] as const;
export type IdentityCandidateStatus = (typeof IDENTITY_CANDIDATE_STATUS)[number];
