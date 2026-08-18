/**
 * `@outreachgraph/ai` — the only package that talks to a model (PRD §14, §20.7).
 *
 * Everything a model produces here passes deterministic gates before anyone
 * sees it. Nothing a model says decides a policy outcome, an identity merge,
 * or a score.
 */

export {
  extractClaims,
  failedChecks,
  findUnsupportedClaims,
  runChecks,
  similarityFingerprint,
  type CheckInput,
  type CheckReport,
  type GroundingContext,
} from './checks';

export {
  ClaudeModel,
  DEFAULT_MODEL,
  MissingApiKeyError,
  StubModel,
  type ClaudeModelOptions,
  type GenerateInput,
  type GenerateResult,
  type TextModel,
} from './model';

export {
  composeDraft,
  type ComposeInput,
  type ComposeResult,
  type OfferingContext,
  type ProspectContext,
  type TriggerContext,
  type VoiceContext,
} from './composer';

export { draftForRecommendation, type DraftResult } from './draft';

export { draftProfile, type ProfileDraft, type ProfileDraftResult } from './profile';

export {
  discoverCompanies,
  normaliseDomain,
  type DiscoverOptions,
  type DiscoveredCompany,
  type DiscoveryResult,
} from './discover';

export {
  OpenAIModel,
  OpenAIApiError,
  MissingOpenAIKeyError,
  DEFAULT_OPENAI_MODEL,
  type OpenAIModelOptions,
} from './openai';

export {
  GeminiModel,
  GeminiApiError,
  MissingGeminiKeyError,
  DEFAULT_GEMINI_MODEL,
  type GeminiModelOptions,
} from './gemini';

export {
  FallbackModel,
  isBudgetExhausted,
  type FallbackAttempt,
  type FallbackEntry,
  type FallbackModelOptions,
} from './fallback';

export {
  answerGridCell,
  type GridAnswer,
  type GridAnswerInput,
  type GridAnswerStatus,
  type GridEvidence,
  type GridQuestion,
} from './grid';

export { expandTerm, mergeTerms, MAX_EXPANSIONS_PER_TERM, type ExpansionResult } from './synonyms';
