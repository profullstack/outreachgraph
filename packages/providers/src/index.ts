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

export {
  SiteProvider,
  normaliseUrl,
  type CrawlResult,
  type SiteProviderOptions,
} from './site/provider';

export {
  fetchPage,
  loadRobots,
  USER_AGENT,
  type FetchLike,
  type FetchOptions,
  type FetchOutcome,
  type FetchedPage,
} from './site/fetch';

export {
  extractCompany,
  extractPeople,
  extractSite,
  networkForUrl,
  type ExtractedCompany,
  type SiteExtraction,
} from './site/extract';

export {
  extractWithModel,
  visibleText,
  type ExtractionModel,
  type ModelExtraction,
} from './site/model-extract';

export { isAllowed, parseRobots, type RobotsRules } from './site/robots';

export {
  BlueskyProvider,
  BlueskyRateLimitError,
  BLUESKY_API,
  type BlueskyProviderOptions,
} from './bluesky/provider';

export { findIdentities, type FanOutAttempt, type FanOutResult } from './fan-out';
