/**
 * Identity resolution (PRD §9.5).
 *
 * Deterministic evidence combination. A model may *produce* evidence — reading
 * a bio and reporting "this profile links the same personal domain" — but the
 * merge decision itself is arithmetic, because an LLM must never be the sole
 * source of an identity merge (PRD §9.5, §48 Decision 4).
 *
 * Evidence combines with a noisy-OR rather than a sum. Two independent pieces
 * of 0.5 evidence give 0.75, not 1.0: corroboration should raise confidence
 * without any fixed number of weak observations ever reaching certainty.
 */

import {
  clampConfidence,
  confidenceLevel,
  DEFAULT_MERGE_THRESHOLDS,
  isNegativeEvidence,
  mergeDecision,
  type ConfidenceLevel,
  type EvidenceKind,
  type MergeDecision,
  type MergeThresholds,
} from '@outreachgraph/domain';
import { DEFAULT_WEIGHTS, isDisqualifying, type WeightTable } from './weights';

/** The minimal shape the resolver needs; the stored row carries more. */
export interface EvidenceInput {
  readonly kind: EvidenceKind;
  /** 0..1 — how strongly this observation holds. */
  readonly strength?: number;
  readonly detail?: string;
}

export interface Contribution {
  readonly kind: EvidenceKind;
  readonly strength: number;
  readonly weight: number;
  /** Effective confidence this evidence contributed, after weighting. */
  readonly effect: number;
  readonly detail?: string;
}

export interface ResolutionResult {
  /** 0..1 combined confidence that the accounts belong to one person. */
  readonly score: number;
  readonly level: ConfidenceLevel;
  readonly decision: MergeDecision;
  /** Positive evidence, strongest effect first. */
  readonly contributions: readonly Contribution[];
  /** Negative evidence, strongest effect first. */
  readonly contradictions: readonly Contribution[];
  /** Set when a disqualifying contradiction forced the rejection. */
  readonly disqualifiedBy?: EvidenceKind;
  /** Evidence kinds that supported the link, for `social_identities.verified_by`. */
  readonly verifiedBy: readonly EvidenceKind[];
  readonly explanation: string;
}

export interface ResolveOptions {
  readonly weights?: WeightTable;
  readonly thresholds?: MergeThresholds;
}

/**
 * Combines evidence into a single confidence and a merge decision.
 *
 * Duplicate evidence of the same kind does not stack: the strongest instance
 * wins. Without that, listing the same fact three ways would inflate the score.
 */
export function resolveIdentity(
  evidence: readonly EvidenceInput[],
  options: ResolveOptions = {},
): ResolutionResult {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const thresholds = options.thresholds ?? DEFAULT_MERGE_THRESHOLDS;

  const strongest = strongestPerKind(evidence);

  const contributions: Contribution[] = [];
  const contradictions: Contribution[] = [];
  let disqualifiedBy: EvidenceKind | undefined;

  for (const item of strongest) {
    const strength = clampConfidence(item.strength ?? 1);
    const weight = weights[item.kind] ?? 0;
    const effect = weight * strength;
    const entry: Contribution = {
      kind: item.kind,
      strength,
      weight,
      effect,
      ...(item.detail === undefined ? {} : { detail: item.detail }),
    };

    if (isNegativeEvidence(item.kind)) {
      contradictions.push(entry);
      // A disqualifying contradiction only counts when actually observed —
      // strength 0 means "checked, and it does not hold".
      if (isDisqualifying(item.kind) && strength > 0) {
        disqualifiedBy ??= item.kind;
      }
    } else {
      contributions.push(entry);
    }
  }

  contributions.sort((a, b) => b.effect - a.effect);
  contradictions.sort((a, b) => b.effect - a.effect);

  const score = disqualifiedBy
    ? 0
    : applyPenalties(noisyOr(contributions.map((c) => c.effect)), contradictions);

  const decision = disqualifiedBy ? 'reject' : mergeDecision(score, thresholds);

  return {
    score,
    level: confidenceLevel(score),
    decision,
    contributions,
    contradictions,
    ...(disqualifiedBy ? { disqualifiedBy } : {}),
    verifiedBy:
      decision === 'reject' ? [] : contributions.filter((c) => c.effect > 0).map((c) => c.kind),
    explanation: explain(score, decision, contributions, contradictions, disqualifiedBy),
  };
}

/**
 * Probabilistic OR: 1 - Π(1 - eᵢ).
 *
 * Independent evidence accumulates with diminishing returns and can never
 * exceed 1, so no pile of weak signals reaches certainty on its own.
 */
function noisyOr(effects: readonly number[]): number {
  let remaining = 1;
  for (const effect of effects) {
    remaining *= 1 - clampConfidence(effect);
  }
  return clampConfidence(1 - remaining);
}

/**
 * Contradictions reduce the score multiplicatively. A 0.45 conflicting-employer
 * penalty removes 45% of the accumulated confidence rather than a flat amount,
 * so it bites hardest when the positive case was weak to begin with.
 */
function applyPenalties(score: number, contradictions: readonly Contribution[]): number {
  let result = score;
  for (const contradiction of contradictions) {
    result *= 1 - clampConfidence(contradiction.effect);
  }
  return clampConfidence(result);
}

/** Keeps only the strongest instance of each evidence kind. */
function strongestPerKind(evidence: readonly EvidenceInput[]): EvidenceInput[] {
  const best = new Map<EvidenceKind, EvidenceInput>();
  for (const item of evidence) {
    const current = best.get(item.kind);
    if (!current || (item.strength ?? 1) > (current.strength ?? 1)) {
      best.set(item.kind, item);
    }
  }
  return [...best.values()];
}

function explain(
  score: number,
  decision: MergeDecision,
  contributions: readonly Contribution[],
  contradictions: readonly Contribution[],
  disqualifiedBy?: EvidenceKind,
): string {
  if (disqualifiedBy) {
    return `Rejected: ${humanize(disqualifiedBy)} rules out a match.`;
  }
  if (contributions.length === 0) {
    return 'No supporting evidence.';
  }

  const top = contributions
    .slice(0, 3)
    .map((c) => humanize(c.kind))
    .join(', ');
  const percent = Math.round(score * 100);

  const verdict =
    decision === 'merge'
      ? 'Merged automatically'
      : decision === 'candidate'
        ? 'Flagged for review'
        : 'Below the merge threshold';

  const caveat =
    contradictions.length > 0
      ? ` Reduced by ${contradictions.map((c) => humanize(c.kind)).join(', ')}.`
      : '';

  return `${verdict} at ${percent}% confidence, supported by ${top}.${caveat}`;
}

function humanize(kind: EvidenceKind): string {
  return kind.replace(/_/g, ' ');
}

/**
 * Recomputes an aggregate confidence for a person from their identity scores.
 *
 * The person is only as trustworthy as their weakest linked identity, since a
 * single wrong link is enough to address the wrong human.
 */
export function aggregateIdentityConfidence(identityScores: readonly number[]): number {
  if (identityScores.length === 0) return 0;
  return clampConfidence(Math.min(...identityScores.map(clampConfidence)));
}
