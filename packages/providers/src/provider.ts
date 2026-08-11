/**
 * The provider boundary (PRD §10.1, §1.1 principle 8).
 *
 * Apollo, People Data Labs, official social APIs and anything added later
 * implement this interface. Vendor-specific objects never leak past an
 * adapter: every provider returns the same normalised candidate shape with
 * provenance already attached, so the waterfall, the resolver and the scorer
 * are all vendor-agnostic.
 */

import type { LicenseClass, Network, SourceType } from '@outreachgraph/domain';

export interface ProviderCapabilities {
  readonly slug: string;
  readonly displayName: string;
  /** Networks this provider can return identities for. */
  readonly networks: readonly Network[];
  readonly canSearch: boolean;
  readonly canEnrich: boolean;
  /** How the provider's data may be retained and re-shared. */
  readonly licenseClass: LicenseClass;
  readonly sourceType: SourceType;
  /** Typical cost of one enrichment, for the waterfall's ordering. */
  readonly costPerEnrichmentUsd: number;
  /** Retention limit imposed by the provider contract, in days. */
  readonly maxRetentionDays?: number;
}

export interface PersonSearchInput {
  readonly titles?: readonly string[];
  readonly seniorities?: readonly string[];
  readonly industries?: readonly string[];
  readonly countries?: readonly string[];
  readonly technologies?: readonly string[];
  readonly keywords?: readonly string[];
  readonly employeeCountMin?: number;
  readonly employeeCountMax?: number;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PersonEnrichmentInput {
  readonly fullName?: string;
  readonly email?: string;
  readonly companyDomain?: string;
  readonly companyName?: string;
  readonly title?: string;
  readonly profileUrls?: readonly string[];
  /** Known handles keyed by network, e.g. `{ github: 'janesmith' }`. */
  readonly handles?: Readonly<Partial<Record<Network, string>>>;
}

/** A normalised identity as returned by a provider, before resolution. */
export interface CandidateIdentity {
  readonly network: Network;
  readonly handle?: string;
  readonly platformUserId?: string;
  readonly profileUrl?: string;
  /** The provider's own confidence, if it reports one. */
  readonly providerConfidence?: number;
}

export interface PersonCandidate {
  readonly fullName: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly title?: string;
  readonly seniority?: string;
  readonly companyName?: string;
  readonly companyDomain?: string;
  readonly employeeCount?: number;
  readonly industry?: string;
  readonly location?: string;
  readonly country?: string;
  readonly technologies?: readonly string[];
  readonly personalDomain?: string;
  readonly identities: readonly CandidateIdentity[];
  /** Opaque provider-side record id, retained for deletion tracing. */
  readonly sourceRecordId?: string;
  readonly observedAt: string;
}

export interface PersonSearchResult {
  readonly candidates: readonly PersonCandidate[];
  readonly cursor?: string;
  readonly costUsd: number;
}

export interface PersonEnrichmentResult {
  readonly candidate?: PersonCandidate;
  /** 0..1 — how completely the provider matched the input. */
  readonly matchConfidence: number;
  readonly costUsd: number;
}

export interface PersonEnrichmentProvider {
  capabilities(): ProviderCapabilities;
  search(input: PersonSearchInput): Promise<PersonSearchResult>;
  enrich(input: PersonEnrichmentInput): Promise<PersonEnrichmentResult>;
  costEstimate(input: PersonSearchInput | PersonEnrichmentInput): Promise<number>;
}

/** Raised when a provider is misconfigured, rather than failing at call time. */
export class ProviderConfigurationError extends Error {
  constructor(provider: string, detail: string) {
    super(`provider ${provider} is not configured: ${detail}`);
    this.name = 'ProviderConfigurationError';
  }
}
