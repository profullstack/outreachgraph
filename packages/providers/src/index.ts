/**
 * `@outreachgraph/providers` — the vendor boundary (PRD §10).
 *
 * Adding Apollo or People Data Labs means adding an adapter here. No other
 * package changes, because nothing else knows a vendor exists.
 */

export {
  ProviderConfigurationError,
  type CandidateIdentity,
  type CandidatePhoto,
  type PersonCandidate,
  type PersonEnrichmentInput,
  type PersonEnrichmentProvider,
  type PersonEnrichmentResult,
  type PersonSearchInput,
  type PersonSearchResult,
  type ProviderCapabilities,
} from './provider';

export { publicPhotoUrl } from './photo';

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
  ValueSerpClient,
  carriesName,
  corroborate,
  isLinkedInProfile,
  type ProfilePhoto,
  type ProfilePhotoFinder,
  type ProfilePhotoQuery,
  type ValueSerpOptions,
} from './valueserp';

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
  buildOpenProfile,
  extractProfilePage,
  hashtagsIn,
  labelFor,
  mergeFacts,
  readBlueskyProfile,
  readMastodonProfile,
  readPublishedOpenProfile,
  urlsInText,
  wellKnownOpenProfile,
  type ProfileAccount,
  type ProfileFacts,
  type ProfileInput,
} from './site/openprofile';

export {
  extractWithModel,
  visibleText,
  type ExtractionModel,
  type ModelExtraction,
} from './site/model-extract';

export { isAllowed, parseRobots, type RobotsRules } from './site/robots';

export {
  assignEmails,
  findEmails,
  matchesName,
  parseEmail,
  type AssignedEmails,
  type FoundEmail,
} from './site/emails';

export {
  applyPattern,
  candidateAddresses,
  EMAIL_PATTERNS,
  inferPatterns,
  type AddressCandidate,
  type EmailPattern,
  type NameParts,
} from './email/patterns';

export {
  createSmtpProber,
  TransientDnsError,
  verifyDomainCandidates,
  type AddressVerdict,
  type DomainVerification,
  type MxRecord,
  type SmtpProbeResult,
  type SmtpProber,
  type SmtpProberOptions,
  type VerifierDeps,
} from './email/verify';

export {
  BlueskyProvider,
  BlueskyRateLimitError,
  BLUESKY_API,
  type BlueskyProviderOptions,
} from './bluesky/provider';
export {
  BlueskyAgent,
  BlueskyAuthError,
  BlueskyWriteError,
  detectFacets,
  fitPost,
  postUriFromUrl,
  BLUESKY_PDS,
  POST_GRAPHEME_LIMIT,
  type BlueskyAgentOptions,
  type BlueskySession,
  type Facet,
  type PostRef,
} from './bluesky/agent';

export { findIdentities, type FanOutAttempt, type FanOutResult } from './fan-out';

export {
  classifyPost,
  BlueskyFeedSource,
  FeedRateLimitError,
  NostrSource,
  RedditSource,
  RssSource,
  suggestSubreddits,
  DEFAULT_NOSTR_RELAYS,
  REDDIT_API,
  type BlueskyFeedSourceOptions,
  type Classification,
  type FeedPost,
  type FeedSearchInput,
  type FeedSource,
  type NostrSocket,
  type NostrSocketFactory,
  type NostrSourceOptions,
  type RedditSourceOptions,
  type RssSourceOptions,
  type SubredditSuggestion,
  type SuggestSubredditsOptions,
} from './feeds';
export {
  GRAVATAR_NETWORKS,
  gravatarHash,
  lookupGravatar,
  type GravatarAccount,
  type GravatarOptions,
  type GravatarProfile,
} from './gravatar';

export {
  XClient,
  XAuthError,
  XWriteError,
  tweetIdFromUrl,
  X_API,
  X_POST_LIMIT,
  type XClientOptions,
  type XPoster,
  type XUser,
} from './x/client';

export {
  XSession,
  XSessionError,
  XSessionWriteError,
  X_DEFAULT_QUERY_IDS,
  X_WEB_BEARER,
  type XSessionCookies,
  type XSessionOptions,
} from './x/session';

export {
  exchangeXCode,
  newOAuthState,
  pkcePair,
  refreshXToken,
  xAuthorizeUrl,
  X_AUTHORIZE_URL,
  X_SCOPES,
  X_TOKEN_URL,
  type XOAuthClient,
  type XTokens,
} from './x/oauth';

export {
  assertPublicUrl,
  isPrivateAddress,
  systemLookup,
  UnsafeUrlError,
  type HostLookup,
  type PublicUrlOptions,
} from './net/public-url';

export {
  newWebhookSecret,
  signWebhook,
  verifyWebhookSignature,
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
} from './webhooks/sign';
export { formatSlackMessage, type SlackMessage } from './webhooks/slack';
export {
  postWebhook,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_USER_AGENT,
  type PostWebhookInput,
  type PostWebhookOutcome,
} from './webhooks/deliver';

export {
  crmClientFor,
  CrmError,
  HubSpotClient,
  HUBSPOT_API,
  PipedriveClient,
  PIPEDRIVE_API,
  type CrmClient,
  type CrmClientOptions,
  type CrmContactInput,
  type CrmContactRef,
} from './crm';

export {
  LinkedInSession,
  LinkedInSessionError,
  LinkedInWriteError,
  threadUrnFromUrl,
  type LinkedInMember,
  type LinkedInSessionOptions,
} from './linkedin/session';
