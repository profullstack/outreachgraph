/**
 * Signal decay (PRD §11.3).
 *
 * A signal's usefulness is a function of its age, and the right curve depends
 * on the kind of event. "Which payments vendor should I use today?" is stale
 * within days; "promoted to VP Engineering" is still a good reason to reach
 * out two months later.
 *
 * The PRD specifies a global stepped table and notes that signal-specific
 * decay should eventually replace it. Both live here: `DEFAULT_STEPS` is the
 * published global curve, and each signal type maps to a profile that scales
 * it. A type with no profile falls back to the global curve exactly.
 */

import { isDurableSignal, isHighIntentSignal, type SignalType } from '@outreachgraph/domain';

export interface DecayStep {
  /** Inclusive upper bound of the bucket, in days. */
  readonly throughDays: number;
  readonly factor: number;
}

/** The global curve from PRD §11.3. */
export const DEFAULT_STEPS: readonly DecayStep[] = [
  { throughDays: 7, factor: 1.0 },
  { throughDays: 14, factor: 0.85 },
  { throughDays: 30, factor: 0.65 },
  { throughDays: 60, factor: 0.4 },
  { throughDays: 90, factor: 0.2 },
];

/** Applied beyond the last step: archival unless the signal is durable. */
export const ARCHIVAL_FACTOR = 0.05;

/**
 * Per-type timescale. A profile stretches or compresses the global curve:
 * `fast` at 0.25 means a 7-day bucket behaves like a ~1.75-day bucket, so an
 * explicit vendor question is nearly worthless within a week.
 */
export const DECAY_PROFILES = {
  fast: 0.25,
  standard: 1,
  durable: 2.5,
} as const;

export type DecayProfile = keyof typeof DECAY_PROFILES;

/**
 * Chooses a profile for a signal type.
 *
 * High-intent signals describe a buying window that closes; durable signals
 * describe a state change that persists.
 */
export function profileFor(type: SignalType): DecayProfile {
  if (isHighIntentSignal(type)) return 'fast';
  if (isDurableSignal(type)) return 'durable';
  return 'standard';
}

export interface DecayOptions {
  readonly steps?: readonly DecayStep[];
  /** Overrides the profile chosen for the type. */
  readonly profile?: DecayProfile;
  readonly archivalFactor?: number;
}

/**
 * Returns the 0..1 multiplier for a signal of `type` that is `ageDays` old.
 *
 * A future-dated signal — clock skew, or a source with a bad timestamp — is
 * treated as brand new rather than trusted to be from the future.
 */
export function decayFactor(type: SignalType, ageDays: number, options: DecayOptions = {}): number {
  if (!Number.isFinite(ageDays)) return options.archivalFactor ?? ARCHIVAL_FACTOR;

  const steps = options.steps ?? DEFAULT_STEPS;
  const scale = DECAY_PROFILES[options.profile ?? profileFor(type)];

  // Dividing the age by the scale is what stretches the curve: a durable
  // signal at 60 days is evaluated as though it were 24 days old.
  const effectiveAge = Math.max(0, ageDays) / scale;

  for (const step of steps) {
    if (effectiveAge <= step.throughDays) return step.factor;
  }
  return options.archivalFactor ?? ARCHIVAL_FACTOR;
}

/** Age in days between two ISO timestamps. */
export function ageInDays(timestamp: string, now: Date = new Date()): number {
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - then) / 86_400_000;
}

export interface DecayableSignal {
  readonly type: SignalType;
  /** When the event happened, per the source. */
  readonly sourceTimestamp?: string;
  /** When we saw it. Used when the source carries no date of its own. */
  readonly observedAt: string;
  readonly confidence: number;
  readonly relevance: number;
  readonly expiresAt?: string;
}

/**
 * The effective weight of a signal right now: freshness × confidence ×
 * relevance. This is the number the intent score is built from.
 */
export function effectiveWeight(
  signal: DecayableSignal,
  now: Date = new Date(),
  options: DecayOptions = {},
): number {
  if (isExpired(signal, now)) return 0;

  const stamp = signal.sourceTimestamp ?? signal.observedAt;
  const decay = decayFactor(signal.type, ageInDays(stamp, now), options);

  return clamp01(decay) * clamp01(signal.confidence) * clamp01(signal.relevance);
}

export function isExpired(signal: DecayableSignal, now: Date = new Date()): boolean {
  if (!signal.expiresAt) return false;
  const expiry = Date.parse(signal.expiresAt);
  return !Number.isNaN(expiry) && expiry <= now.getTime();
}

/**
 * True once a signal has decayed past usefulness and should be archived rather
 * than kept in the working set (PRD §11.3, §35).
 */
export function isArchival(
  signal: DecayableSignal,
  now: Date = new Date(),
  options: DecayOptions = {},
): boolean {
  if (isExpired(signal, now)) return true;
  const stamp = signal.sourceTimestamp ?? signal.observedAt;
  const factor = decayFactor(signal.type, ageInDays(stamp, now), options);
  return factor <= (options.archivalFactor ?? ARCHIVAL_FACTOR);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
