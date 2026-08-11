/**
 * `@outreachgraph/recommend` — the Next-Best-Action engine (PRD §13).
 *
 * Deterministic. It selects from what the Policy Engine permits and always
 * names the signal that triggered it.
 */

export {
  computePriority,
  generateRecommendation,
  type CandidateSignal,
  type GeneratedRecommendation,
  type NoRecommendationReason,
  type RecommendationInput,
  type RecommendationResult,
} from './engine';
