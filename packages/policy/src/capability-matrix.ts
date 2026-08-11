/**
 * The default platform capability matrix (PRD §16).
 *
 * This table is the product's written record of what each network permits. It
 * is data, not logic, so it can be overridden from the database without a
 * deploy when a platform changes its rules (PRD §7.4, §37).
 *
 * IMPORTANT: these entries reflect the policy notes in PRD §51 as of the
 * `POLICY_VERSION` below. They are a starting position, not legal advice, and
 * every entry carries a `nextReviewAt` because platform terms change.
 */

import type { ActionKind, Network } from '@outreachgraph/domain';

/** Bump whenever any rule below changes. Recorded on every recommendation. */
export const POLICY_VERSION = '2026-08-11';

/** PRD §16.2. Ordered loosest to strictest is not meaningful — these are kinds. */
export const POLICY_MODES = [
  'disabled',
  'research_only',
  'draft_only',
  'manual_only',
  'official_api',
  'approved_partner',
  'customer_managed',
] as const;

export type PolicyMode = (typeof POLICY_MODES)[number];

export interface CapabilityRule {
  readonly network: Network;
  readonly capability: ActionKind;
  readonly mode: PolicyMode;
  /** Shown to the user when an action is blocked or downgraded. */
  readonly reason: string;
  readonly source: 'platform_policy' | 'product_decision' | 'provider_terms';
  readonly reviewedAt: string;
  readonly nextReviewAt: string;
}

const REVIEWED = '2026-08-11';
const NEXT_REVIEW = '2026-09-11';

function rule(
  network: Network,
  capability: ActionKind,
  mode: PolicyMode,
  reason: string,
  source: CapabilityRule['source'] = 'platform_policy',
): CapabilityRule {
  return {
    network,
    capability,
    mode,
    reason,
    source,
    reviewedAt: REVIEWED,
    nextReviewAt: NEXT_REVIEW,
  };
}

/**
 * LinkedIn (PRD §16.3).
 *
 * LinkedIn's User Agreement prohibits unauthorized bots and automated methods
 * for scraping, messaging, adding contacts and engagement. V1 therefore treats
 * LinkedIn as a research and draft surface only: the user performs any action
 * themselves, in LinkedIn's own interface.
 */
const LINKEDIN: readonly CapabilityRule[] = [
  rule('linkedin', 'observe', 'research_only', 'Licensed provider data and public research only.'),
  rule('linkedin', 'refresh_research', 'research_only', 'Licensed provider data only.'),
  rule(
    'linkedin',
    'view_profile',
    'manual_only',
    'Automated profile visiting is prohibited; open the profile yourself.',
  ),
  rule('linkedin', 'connect', 'manual_only', 'Automated connection requests are prohibited.'),
  rule('linkedin', 'send_dm', 'manual_only', 'Automated messaging is prohibited.'),
  rule('linkedin', 'like', 'manual_only', 'Automated engagement is prohibited.'),
  rule('linkedin', 'comment', 'manual_only', 'Automated engagement is prohibited.'),
  rule('linkedin', 'reply', 'manual_only', 'Automated engagement is prohibited.'),
  rule('linkedin', 'follow', 'manual_only', 'Automated engagement is prohibited.'),
];

/**
 * X (PRD §16.4).
 *
 * Public reads and approved API actions are available, but X's automation
 * rules prohibit spam and spammy automated Direct Messages. DMs are therefore
 * manual-only in V1 — an unsolicited automated DM must not become the model.
 */
const X: readonly CapabilityRule[] = [
  rule('x', 'observe', 'official_api', 'Public timeline reads via the supported API.'),
  rule('x', 'refresh_research', 'official_api', 'Public timeline reads via the supported API.'),
  rule('x', 'view_profile', 'official_api', 'Public profile reads via the supported API.'),
  rule('x', 'like', 'official_api', 'Permitted via the authenticated account, subject to limits.'),
  rule(
    'x',
    'follow',
    'official_api',
    'Permitted via the authenticated account, subject to limits.',
  ),
  rule('x', 'reply', 'official_api', 'Public replies are permitted; volume limits apply.'),
  rule('x', 'comment', 'official_api', 'Public replies are permitted; volume limits apply.'),
  rule(
    'x',
    'send_dm',
    'manual_only',
    'Automated unsolicited Direct Messages are prohibited; send it yourself.',
  ),
];

/**
 * Bluesky (PRD §16.5).
 *
 * The AT Protocol exposes public profiles and feeds, and supports actions on
 * behalf of an authenticated account the user has connected themselves.
 */
const BLUESKY: readonly CapabilityRule[] = [
  rule('bluesky', 'observe', 'official_api', 'Public AppView feed and profile data.'),
  rule('bluesky', 'refresh_research', 'official_api', 'Public AppView feed and profile data.'),
  rule('bluesky', 'view_profile', 'official_api', 'Public profile data.'),
  rule('bluesky', 'like', 'official_api', 'Permitted for the connected account.'),
  rule('bluesky', 'follow', 'official_api', 'Permitted for the connected account.'),
  rule('bluesky', 'reply', 'official_api', 'Permitted for the connected account.'),
  rule('bluesky', 'comment', 'official_api', 'Permitted for the connected account.'),
  rule(
    'bluesky',
    'send_dm',
    'manual_only',
    'Direct messaging is not an approved automated channel in V1.',
    'product_decision',
  ),
];

/**
 * GitHub (PRD §16.6).
 *
 * GitHub is a signal source, not an outreach channel. Issues, pull requests
 * and discussions are explicitly off limits for sales contact.
 */
const GITHUB: readonly CapabilityRule[] = [
  rule('github', 'observe', 'official_api', 'Public profile, repository and activity data.'),
  rule('github', 'refresh_research', 'official_api', 'Public profile and activity data.'),
  rule('github', 'view_profile', 'official_api', 'Public profile data.'),
  rule(
    'github',
    'comment',
    'disabled',
    'Sales outreach in issues, pull requests and discussions is prohibited.',
    'product_decision',
  ),
  rule(
    'github',
    'reply',
    'disabled',
    'Sales outreach in issues, pull requests and discussions is prohibited.',
    'product_decision',
  ),
  rule(
    'github',
    'send_dm',
    'disabled',
    'GitHub is a signal source, not a messaging channel.',
    'product_decision',
  ),
  rule('github', 'follow', 'manual_only', 'Follow from your own account if you choose.'),
];

/** Read-only research surfaces. */
const READ_ONLY: readonly CapabilityRule[] = [
  rule('website', 'observe', 'research_only', 'Permitted public web retrieval.'),
  rule('website', 'refresh_research', 'research_only', 'Permitted public web retrieval.'),
  rule('rss', 'observe', 'research_only', 'Public feed retrieval.'),
  rule('rss', 'refresh_research', 'research_only', 'Public feed retrieval.'),
  rule('reddit', 'observe', 'official_api', 'Public reads via the supported API.'),
  rule('reddit', 'refresh_research', 'official_api', 'Public reads via the supported API.'),
  rule(
    'reddit',
    'send_dm',
    'disabled',
    'Unsolicited direct messaging is not supported in V1.',
    'product_decision',
  ),
  rule('youtube', 'observe', 'official_api', 'Public reads via the supported API.'),
  rule('youtube', 'refresh_research', 'official_api', 'Public reads via the supported API.'),
  rule(
    'instagram',
    'observe',
    'disabled',
    'No approved read integration in V1.',
    'product_decision',
  ),
];

/** Channels the customer owns outright. */
const OWNED: readonly CapabilityRule[] = [
  rule(
    'email',
    'send_email',
    'customer_managed',
    'Sent through the customer’s own mailbox or sending domain.',
    'product_decision',
  ),
  rule(
    'crm',
    'create_crm_task',
    'customer_managed',
    'Written to the customer’s own CRM.',
    'product_decision',
  ),
];

export const DEFAULT_CAPABILITY_RULES: readonly CapabilityRule[] = [
  ...LINKEDIN,
  ...X,
  ...BLUESKY,
  ...GITHUB,
  ...READ_ONLY,
  ...OWNED,
];

export type CapabilityKey = `${Network}:${ActionKind}`;

export function capabilityKey(network: Network, capability: ActionKind): CapabilityKey {
  return `${network}:${capability}`;
}

export function indexRules(
  rules: readonly CapabilityRule[] = DEFAULT_CAPABILITY_RULES,
): ReadonlyMap<CapabilityKey, CapabilityRule> {
  const map = new Map<CapabilityKey, CapabilityRule>();
  for (const entry of rules) {
    map.set(capabilityKey(entry.network, entry.capability), entry);
  }
  return map;
}

/**
 * Feature-flag keys (PRD §37). A missing flag is treated as enabled so that
 * adding a network does not require seeding flags first; a flag explicitly set
 * to false is an immediate kill switch.
 */
export function featureFlagKey(network: Network, capability: ActionKind): string {
  return `network.${network}.${capability}`;
}
