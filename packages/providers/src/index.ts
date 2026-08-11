/**
 * `@outreachgraph/providers` — the vendor boundary (PRD §10).
 *
 * Adding Apollo or People Data Labs means adding an adapter here. No other
 * package changes, because nothing else knows a vendor exists.
 */

export {
  ProviderConfigurationError,
  type CandidateIdentity,
  type PersonCandidate,
  type PersonEnrichmentInput,
  type PersonEnrichmentProvider,
  type PersonEnrichmentResult,
  type PersonSearchInput,
  type PersonSearchResult,
  type ProviderCapabilities,
} from './provider';

export {
  attributeFields,
  enrichWithWaterfall,
  orderProviders,
  type WaterfallAttempt,
  type WaterfallOptions,
  type WaterfallResult,
} from './waterfall';

export { deriveEvidence, type EvidenceContext } from './evidence';

export {
  FixtureProvider,
  FIXTURE_CANDIDATES,
  type FixtureProviderOptions,
} from './fixture-provider';

export {
  GitHubClient,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GITHUB_API,
  type GitHubClientOptions,
  type GitHubEvent,
  type GitHubRepo,
  type GitHubUser,
} from './github/client';

export {
  cleanCompany,
  domainOf,
  GitHubProvider,
  toCandidate,
  type GitHubProviderOptions,
} from './github/provider';

export { extractSignals, type ExtractedSignal, type ExtractionContext } from './github/signals';
