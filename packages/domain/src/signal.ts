/**
 * Signals — normalised public events that make a prospect worth contacting
 * now (PRD §11).
 */

import type { PrefixedId } from './ids';
import type { Network } from './networks';

/** PRD §11.2. */
export const SIGNAL_TYPES = [
  'pain',
  'purchase_intent',
  'recommendation_request',
  'competitor_mention',
  'technology_adoption',
  'technology_removal',
  'hiring',
  'role_change',
  'company_growth',
  'funding',
  'launch',
  'project_start',
  'public_question',
  'public_complaint',
  'migration',
  'security',
  'integration',
  'event',
  'community_activity',
  'content_topic',
  /**
   * Somebody engaged with the workspace's own account: a follow, like, repost,
   * reply or mention. Written by the audience watcher (`packages/pipeline/src/audience.ts`),
   * never by a classifier — the network named both parties, so there is
   * nothing to infer.
   */
  'audience_engagement',
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

export function isSignalType(value: unknown): value is SignalType {
  return typeof value === 'string' && (SIGNAL_TYPES as readonly string[]).includes(value);
}

export const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export interface Signal {
  readonly id: PrefixedId<'signal'>;
  readonly workspaceId: PrefixedId<'workspace'>;
  readonly personId?: PrefixedId<'person'>;
  readonly companyId?: PrefixedId<'company'>;
  readonly network: Network;
  readonly type: SignalType;
  /** Free-form narrowing, e.g. `payments` under `technology_adoption`. */
  readonly subtype?: string;
  readonly summary: string;
  /** Verbatim excerpt backing the summary. Required to ground a message. */
  readonly evidence?: string;
  readonly sourceDocumentId?: PrefixedId<'sourceDocument'>;
  readonly sourceUrl?: string;
  /** When the event happened, per the source. Drives decay. */
  readonly sourceTimestamp?: string;
  /** When we saw it. Falls back to driving decay if the source has no date. */
  readonly observedAt: string;
  /** 0..1 — confidence the classification is correct. */
  readonly confidence: number;
  /** 0..1 — relevance to this workspace's offering. */
  readonly relevance: number;
  readonly sentiment: Sentiment;
  readonly expiresAt?: string;
}

/**
 * Signals that stay meaningful for a long time. A job change is still worth
 * referencing after a month; "which vendor should I use today?" is not
 * (PRD §11.3).
 */
export const DURABLE_SIGNAL_TYPES = [
  'role_change',
  'funding',
  'company_growth',
  'technology_adoption',
  'technology_removal',
  'migration',
  'launch',
] as const satisfies readonly SignalType[];

export function isDurableSignal(type: SignalType): boolean {
  return (DURABLE_SIGNAL_TYPES as readonly SignalType[]).includes(type);
}

/**
 * Signals that indicate an explicit, time-boxed buying window. These decay
 * fastest and rank highest while fresh.
 */
export const HIGH_INTENT_SIGNAL_TYPES = [
  'purchase_intent',
  'recommendation_request',
  'public_question',
  'competitor_mention',
  'public_complaint',
  'pain',
  /**
   * Not "intent" in the sense the others are — nobody asked for a vendor by
   * liking a post. It is here because it decays like one: engagement is
   * something the person remembers for days, and a message that opens by
   * recalling a like from three weeks ago reads worse than a cold one.
   */
  'audience_engagement',
] as const satisfies readonly SignalType[];

export function isHighIntentSignal(type: SignalType): boolean {
  return (HIGH_INTENT_SIGNAL_TYPES as readonly SignalType[]).includes(type);
}
