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
  'reddit',
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
 */
export function isInternalAction(action: ActionKind): boolean {
  return (
    action === 'observe' ||
    action === 'refresh_research' ||
    action === 'wait' ||
    action === 'suppress' ||
    action === 'manual_review' ||
    action === 'create_crm_task'
  );
}

export const CAPABILITY_LEVELS = ['yes', 'limited', 'no'] as const;
export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number];

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
