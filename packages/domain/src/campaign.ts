/**
 * Offerings, voice profiles and campaigns — the output of the wizard
 * (PRD §7.1–§7.8).
 */

import type { PrefixedId } from './ids';
import type { Network } from './networks';
import type { SignalType } from './signal';

/** Normalised description of what the customer sells (PRD §7.1). */
export interface Offering {
  readonly id: PrefixedId<'offering'>;
  readonly workspaceId: PrefixedId<'workspace'>;
  readonly name: string;
  readonly category: string;
  readonly url?: string;
  readonly description?: string;
  readonly valuePropositions: readonly string[];
  readonly likelyPains: readonly string[];
  readonly competitors: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const OUTREACH_STYLES = [
  'relationship_first',
  'concise_founder',
  'technical',
  'helpful_no_pitch',
  'direct',
  'community_first',
  'custom',
] as const;

export type OutreachStyle = (typeof OUTREACH_STYLES)[number];

/** Reusable writing voice, optionally learned from customer samples (PRD §7.5). */
export interface VoiceProfile {
  readonly id: PrefixedId<'voiceProfile'>;
  readonly workspaceId: PrefixedId<'workspace'>;
  readonly name: string;
  readonly style: OutreachStyle;
  readonly instructions?: string;
  readonly samples: readonly string[];
  readonly maxWords?: number;
  readonly prohibitedClaims: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Approval policy (PRD §7.6). `draft_and_approve` is the V1 default and the
 * only mode that ships enabled; `trusted_automation` additionally requires the
 * Policy Engine to return ALLOW for the specific action.
 */
export const APPROVAL_MODES = ['research_only', 'draft_and_approve', 'trusted_automation'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'draft_and_approve';

/** Structured targeting extracted from the natural-language brief (PRD §7.2). */
export interface CampaignFilters {
  readonly titles: readonly string[];
  readonly seniorities: readonly string[];
  readonly industries: readonly string[];
  readonly countries: readonly string[];
  readonly technologies: readonly string[];
  readonly keywords: readonly string[];
  readonly exclusions: readonly string[];
  readonly employeeCountMin?: number;
  readonly employeeCountMax?: number;
  readonly fundingStages?: readonly string[];
  readonly hiring?: boolean;
}

export const EMPTY_FILTERS: CampaignFilters = {
  titles: [],
  seniorities: [],
  industries: [],
  countries: [],
  technologies: [],
  keywords: [],
  exclusions: [],
};

/** Which signals this campaign cares about, and how much (PRD §7.3). */
export interface CampaignSignalRule {
  readonly type: SignalType;
  readonly enabled: boolean;
  /** Multiplier applied to the signal's contribution to intent. */
  readonly weight: number;
  /** Optional match terms that raise relevance, e.g. competitor names. */
  readonly keywords?: readonly string[];
}

/** Hard ceilings enforced before any spend or send (PRD §7.7, §18). */
export interface CampaignBudget {
  readonly maxProspects: number;
  readonly maxEnrichmentCredits: number;
  readonly maxResearchCredits: number;
  readonly maxAiSpendUsd: number;
  readonly maxActionsPerDay: number;
  readonly maxActionsPerProspectPerWeek: number;
}

export const DEFAULT_BUDGET: CampaignBudget = {
  maxProspects: 1_000,
  maxEnrichmentCredits: 3_500,
  maxResearchCredits: 1_500,
  maxAiSpendUsd: 50,
  maxActionsPerDay: 50,
  maxActionsPerProspectPerWeek: 1,
};

export const CAMPAIGN_STATUS = ['draft', 'running', 'paused', 'completed', 'archived'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUS)[number];

export interface Campaign {
  readonly id: PrefixedId<'campaign'>;
  readonly workspaceId: PrefixedId<'workspace'>;
  readonly name: string;
  readonly offeringId: PrefixedId<'offering'>;
  readonly voiceProfileId?: PrefixedId<'voiceProfile'>;
  readonly brief?: string;
  readonly filters: CampaignFilters;
  readonly signalRules: readonly CampaignSignalRule[];
  readonly networks: readonly Network[];
  readonly approvalMode: ApprovalMode;
  readonly budget: CampaignBudget;
  /** Per-campaign override of the opportunity weights (PRD §12.6). */
  readonly scoreWeights?: Readonly<Record<string, number>>;
  readonly status: CampaignStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
}
