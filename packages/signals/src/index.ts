/**
 * `@outreachgraph/signals` — normalisation and decay for public signals
 * (PRD §11).
 */

export {
  ageInDays,
  ARCHIVAL_FACTOR,
  decayFactor,
  DECAY_PROFILES,
  DEFAULT_STEPS,
  effectiveWeight,
  isArchival,
  isExpired,
  profileFor,
  type DecayableSignal,
  type DecayOptions,
  type DecayProfile,
  type DecayStep,
} from './decay';
