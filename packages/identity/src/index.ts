/**
 * `@outreachgraph/identity` — cross-network identity resolution (PRD §9).
 *
 * The merge decision is arithmetic. Models may produce evidence; they never
 * decide a merge (PRD §9.5).
 */

export {
  aggregateIdentityConfidence,
  resolveIdentity,
  type Contribution,
  type EvidenceInput,
  type ResolutionResult,
  type ResolveOptions,
} from './resolver';

export { DEFAULT_WEIGHTS, DISQUALIFYING, isDisqualifying, type WeightTable } from './weights';
