/**
 * Networks and the actions the product can take on them.
 *
 * This module deliberately contains no policy decisions — it only names what
 * exists. Whether a given (network, action) pair is permitted is decided by
 * `@outreachgraph/policy`, which is deterministic and separately versioned
 * (PRD §16, §20.8).
 */

export const NETWORKS = [
  'linkedin',
  'x',
  'github',
  'bluesky',
  'mastodon',
  'reddit',
  'nostr',
  'youtube',
  'instagram',
  'website',
  'rss',
  'email',
  'crm',
] as const;

export type Network = (typeof NETWORKS)[number];

export function isNetwork(value: unknown): value is Network {
  return typeof value === 'string' && (NETWORKS as readonly string[]).includes(value);
}

/**
 * Every action the Next-Best-Action engine may propose (PRD §13.1).
 *
 * The Strategy Agent selects from this list but cannot invent members — the
 * Policy Engine hands it the filtered subset it is allowed to choose from.
 */
export const ACTION_KINDS = [
  'observe',
  'refresh_research',
  'view_profile',
  'follow',
  'like',
  'reply',
  'comment',
  'connect',
  'send_dm',
  'send_email',
  'create_crm_task',
  'wait',
  'suppress',
  'manual_review',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === 'string' && (ACTION_KINDS as readonly string[]).includes(value);
}

/**
 * Actions that put a message in front of another human. These carry the
 * strictest defaults: individual approval, per-prospect cooldowns and
 * suppression checks (PRD §15, §18).
 */
export const OUTBOUND_ACTION_KINDS = [
  'reply',
  'comment',
  'connect',
  'send_dm',
  'send_email',
] as const satisfies readonly ActionKind[];

export type OutboundActionKind = (typeof OUTBOUND_ACTION_KINDS)[number];

export function isOutboundAction(action: ActionKind): action is OutboundActionKind {
  return (OUTBOUND_ACTION_KINDS as readonly ActionKind[]).includes(action);
}

/**
 * Actions that only read or record state internally. These may be batched in
 * the approval queue because the prospect never sees them (PRD §15).
 *
 * Exported as a list, and not only as a predicate, because the rate limiters
 * have to ask the same question in SQL. A research sweep is not outreach and
 * must not be counted by the limits that govern outreach — see `actionCounts`.
 */
export const INTERNAL_ACTION_KINDS = [
  'observe',
  'refresh_research',
  'wait',
  'suppress',
  'manual_review',
  'create_crm_task',
] as const satisfies readonly ActionKind[];

export function isInternalAction(action: ActionKind): boolean {
  return (INTERNAL_ACTION_KINDS as readonly ActionKind[]).includes(action);
}

export const CAPABILITY_LEVELS = ['yes', 'limited', 'no'] as const;
export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number];

/**
 * How you reach someone, one level up from the network.
 *
 * The approval queue needs this because "what can I act on" is usually a
 * question about the medium rather than the site: only email actually sends
 * today, so "show me the email ones" is the difference between a usable queue
 * and scrolling past dozens of cards that were never going to be sendable.
 *
 * Deliberately coarser than `Network` — a reviewer sorting their own work does
 * not care whether a profile is on Bluesky or Mastodon, only that acting on it
 * means opening a social app rather than writing a message.
 */
export const CHANNELS = ['email', 'social', 'web'] as const;

export type Channel = (typeof CHANNELS)[number];

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

/**
 * Which channel a network belongs to.
 *
 * `rss` and `crm` sit under `web` rather than earning buckets of their own:
 * neither is a place a human is messaged, so grouping them with the website is
 * closer to the truth than a third tab that is almost always empty. GitHub is
 * `social` despite being a code host — it is a profile with a person behind it,
 * and the PRD forbids messaging there, which is exactly the kind of card this
 * filter exists to move out of the way.
 */
export function channelForNetwork(network: Network): Channel {
  switch (network) {
    case 'email':
      return 'email';
    case 'linkedin':
    case 'x':
    case 'bluesky':
    case 'mastodon':
    case 'reddit':
    case 'nostr':
    case 'youtube':
    case 'instagram':
    case 'github':
      return 'social';
    case 'website':
    case 'rss':
    case 'crm':
      return 'web';
  }
}

/**
 * Per-network capability advertised to the campaign wizard (PRD §7.4).
 * Remotely configurable because platform rules change without notice.
 */
export interface NetworkCapability {
  readonly network: Network;
  readonly discover: CapabilityLevel;
  readonly readSignals: CapabilityLevel;
  readonly draftAction: CapabilityLevel;
  readonly autoExecute: CapabilityLevel;
  readonly manualAction: CapabilityLevel;
}
