/**
 * `@outreachgraph/scoring` — ICP fit, intent, reachability, relationship and
 * the combined opportunity score (PRD §12).
 */

export {
  scoreIcpFit,
  scoreIntent,
  scoreOpportunity,
  scoreReachability,
  scoreRelationship,
  toScore,
  type IcpBreakdown,
  type IcpInput,
  type IntentBreakdown,
  type IntentInput,
  type OpportunityBreakdown,
  type OpportunityInput,
  type ReachabilityInput,
  type RelationshipInput,
  type Score,
} from './scores';

export { DEFAULT_WEIGHTS, normalizeWeights, type OpportunityWeights } from './weights';
