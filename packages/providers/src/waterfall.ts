/**
 * The provider waterfall (PRD §10.2).
 *
 * Objectives, in order: never pay for a lookup twice, stop as soon as the
 * result is good enough, and record where every field came from.
 *
 * Providers are consulted cheapest-first — customer-owned data before licensed
 * enrichment before paid social APIs — and the walk stops at the first result
 * clearing the confidence target.
 */

import type { Provenanced, SourceType } from '@outreachgraph/domain';
import type {
  PersonCandidate,
  PersonEnrichmentInput,
  PersonEnrichmentProvider,
  ProviderCapabilities,
} from './provider';

export interface WaterfallOptions {
  /** Stop once a provider returns at least this match confidence. */
  readonly confidenceTarget?: number;
  /** Abort the walk once accumulated spend would exceed this. */
  readonly maxCostUsd?: number;
  /**
   * Records already paid for, keyed by `provider:requestHash`. A hit skips
   * the provider entirely (PRD §10.2 "avoid repeating paid lookups").
   */
  readonly alreadyFetched?: ReadonlySet<string>;
  readonly requestHash?: string;
}

export interface WaterfallAttempt {
  readonly provider: string;
  readonly outcome: 'hit' | 'miss' | 'skipped_cached' | 'skipped_budget' | 'error';
  readonly matchConfidence: number;
  readonly costUsd: number;
  readonly error?: string;
}

export interface WaterfallResult {
  readonly candidate?: PersonCandidate;
  readonly matchConfidence: number;
  readonly totalCostUsd: number;
  /** Every provider consulted and why it did or did not contribute. */
  readonly attempts: readonly WaterfallAttempt[];
  /** Field-level attribution for everything in `candidate`. */
  readonly provenance: Readonly<Record<string, Provenanced<string>>>;
}

const DEFAULT_TARGET = 0.9;

/** Cheapest first; ties broken by name so the order is deterministic. */
export function orderProviders(
  providers: readonly PersonEnrichmentProvider[],
): readonly PersonEnrichmentProvider[] {
  return [...providers].sort((a, b) => {
    const ca = a.capabilities();
    const cb = b.capabilities();
    if (ca.costPerEnrichmentUsd !== cb.costPerEnrichmentUsd) {
      return ca.costPerEnrichmentUsd - cb.costPerEnrichmentUsd;
    }
    return ca.slug.localeCompare(cb.slug);
  });
}

/**
 * Walks the providers until the confidence target is met or the list runs out.
 *
 * A provider that throws is recorded and skipped rather than aborting the
 * walk — one vendor outage must not stop enrichment entirely.
 */
export async function enrichWithWaterfall(
  providers: readonly PersonEnrichmentProvider[],
  input: PersonEnrichmentInput,
  options: WaterfallOptions = {},
): Promise<WaterfallResult> {
  const target = options.confidenceTarget ?? DEFAULT_TARGET;
  const attempts: WaterfallAttempt[] = [];

  let best: PersonCandidate | undefined;
  let bestConfidence = 0;
  let bestCapabilities: ProviderCapabilities | undefined;
  let totalCost = 0;

  for (const provider of orderProviders(providers)) {
    const capabilities = provider.capabilities();

    if (!capabilities.canEnrich) continue;

    const cacheKey = `${capabilities.slug}:${options.requestHash ?? ''}`;
    if (options.requestHash && options.alreadyFetched?.has(cacheKey)) {
      attempts.push({
        provider: capabilities.slug,
        outcome: 'skipped_cached',
        matchConfidence: 0,
        costUsd: 0,
      });
      continue;
    }

    if (
      options.maxCostUsd !== undefined &&
      totalCost + capabilities.costPerEnrichmentUsd > options.maxCostUsd
    ) {
      attempts.push({
        provider: capabilities.slug,
        outcome: 'skipped_budget',
        matchConfidence: 0,
        costUsd: 0,
      });
      continue;
    }

    try {
      const result = await provider.enrich(input);
      totalCost += result.costUsd;

      if (result.candidate && result.matchConfidence > bestConfidence) {
        best = result.candidate;
        bestConfidence = result.matchConfidence;
        bestCapabilities = capabilities;
      }

      attempts.push({
        provider: capabilities.slug,
        outcome: result.candidate ? 'hit' : 'miss',
        matchConfidence: result.matchConfidence,
        costUsd: result.costUsd,
      });

      if (bestConfidence >= target) break;
    } catch (error) {
      attempts.push({
        provider: capabilities.slug,
        outcome: 'error',
        matchConfidence: 0,
        costUsd: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ...(best ? { candidate: best } : {}),
    matchConfidence: bestConfidence,
    totalCostUsd: round(totalCost),
    attempts,
    provenance: best && bestCapabilities ? attributeFields(best, bestCapabilities) : {},
  };
}

/**
 * Attaches provenance to every scalar field of a candidate (PRD §10.3).
 *
 * Done here rather than in each adapter so a new provider cannot forget it.
 */
export function attributeFields(
  candidate: PersonCandidate,
  capabilities: ProviderCapabilities,
): Readonly<Record<string, Provenanced<string>>> {
  const provenance: Record<string, Provenanced<string>> = {};

  const attribute = (field: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return;
    provenance[field] = {
      value: String(value),
      sourceType: capabilities.sourceType as SourceType,
      provider: capabilities.slug,
      ...(candidate.sourceRecordId ? { sourceRecordId: candidate.sourceRecordId } : {}),
      observedAt: candidate.observedAt,
      licenseClass: capabilities.licenseClass,
      ...(capabilities.maxRetentionDays
        ? { retentionPolicy: `${capabilities.maxRetentionDays}d` }
        : {}),
      confidence: 1,
    };
  };

  attribute('fullName', candidate.fullName);
  attribute('firstName', candidate.firstName);
  attribute('lastName', candidate.lastName);
  attribute('title', candidate.title);
  attribute('seniority', candidate.seniority);
  attribute('companyName', candidate.companyName);
  attribute('companyDomain', candidate.companyDomain);
  attribute('employeeCount', candidate.employeeCount);
  attribute('industry', candidate.industry);
  attribute('location', candidate.location);
  attribute('country', candidate.country);
  attribute('personalDomain', candidate.personalDomain);

  for (const identity of candidate.identities) {
    attribute(`identity.${identity.network}`, identity.handle ?? identity.profileUrl);
  }

  return provenance;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
