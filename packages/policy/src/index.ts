/**
 * `@outreachgraph/policy` — the deterministic gate every outbound action
 * passes through (PRD §1.1 principle 9, §16, §20.8).
 *
 * No LLM participates in a decision made here. The Strategy Agent receives the
 * output of `allowedActions` and may only choose from it.
 */

export {
  allowedActions,
  evaluatePolicy,
  isExecutable,
  POLICY_DECISIONS,
  POLICY_GATES,
  type PolicyDecision,
  type PolicyGate,
  type PolicyRequest,
  type PolicyResult,
  type PolicyTraceEntry,
} from './engine';

export {
  capabilityKey,
  DEFAULT_CAPABILITY_RULES,
  featureFlagKey,
  indexRules,
  POLICY_MODES,
  POLICY_VERSION,
  type CapabilityKey,
  type CapabilityRule,
  type PolicyMode,
} from './capability-matrix';
