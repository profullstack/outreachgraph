/**
 * Suppression, privacy requests and sensitive-category rules (PRD §17).
 *
 * Product design guidance, not legal advice. The architecture here is meant to
 * make deletion and suppression cheap to prove, not to settle whether the
 * business is a covered data broker.
 */

import type { PrefixedId } from './ids';
import type { Network } from './networks';

/**
 * Match keys are the minimal identifiers retained to prevent re-ingestion
 * after a person is deleted (PRD §17.3). Emails are stored hashed; platform
 * identities as `platform:<network>:<id>`.
 */
export type SuppressionMatchKey =
  | `hashed_email:${string}`
  | `platform:${Network}:${string}`
  | `domain_identity:${string}`
  | `person:${string}`;

export const SUPPRESSION_REASONS = [
  'consumer_opt_out',
  'customer_request',
  'complaint',
  'bounce',
  'do_not_contact',
  'minor',
  'legal_hold',
  'admin',
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const SUPPRESSION_SCOPES = ['global', 'organization', 'workspace'] as const;
export type SuppressionScope = (typeof SUPPRESSION_SCOPES)[number];

/**
 * A tombstone that outlives the prospect record. Deleting a person removes
 * their profile; the suppression entry survives so a later provider lookup
 * cannot silently resurrect them (PRD §6.6, §17.3).
 */
export interface SuppressionEntry {
  readonly id: PrefixedId<'suppression'>;
  readonly matchKeys: readonly SuppressionMatchKey[];
  readonly reason: SuppressionReason;
  readonly scope: SuppressionScope;
  /** Required unless scope is `global`. */
  readonly workspaceId?: PrefixedId<'workspace'>;
  readonly organizationId?: PrefixedId<'organization'>;
  readonly source: 'privacy_request' | 'user' | 'system' | 'import';
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export const PRIVACY_REQUEST_KINDS = ['delete', 'opt_out', 'access', 'correct'] as const;
export type PrivacyRequestKind = (typeof PRIVACY_REQUEST_KINDS)[number];

export const PRIVACY_REQUEST_STATUS = [
  'received',
  'verifying',
  'processing',
  'completed',
  'rejected',
] as const;

export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUS)[number];

/**
 * A consumer request. `sourceChannel` records how it arrived — `drop` is
 * California's Delete Request and Opt-out Platform, which covered brokers must
 * poll at least every 45 days from 1 August 2026 (PRD §17.2).
 */
export interface PrivacyRequest {
  readonly id: PrefixedId<'privacyRequest'>;
  readonly kind: PrivacyRequestKind;
  readonly status: PrivacyRequestStatus;
  readonly sourceChannel: 'drop' | 'web_form' | 'email' | 'admin';
  readonly subjectMatchKeys: readonly SuppressionMatchKey[];
  readonly receivedAt: string;
  readonly dueAt?: string;
  readonly completedAt?: string;
  readonly note?: string;
}

/**
 * Categories that must never become targeting or scoring features, even when
 * a public post happens to reveal them (PRD §17.4).
 */
export const SENSITIVE_CATEGORIES = [
  'health',
  'precise_geolocation',
  'sexual_orientation',
  'religion',
  'race_ethnicity',
  'political_affiliation',
  'union_membership',
  'financial_distress',
  'minor',
  'biometric',
  'immigration_status',
  'criminal_record',
] as const;

export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

export function isSensitiveCategory(value: unknown): value is SensitiveCategory {
  return typeof value === 'string' && (SENSITIVE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Gate applied before a person enters outreach. Returning a reason rather than
 * a bare boolean means the UI can explain the exclusion and the audit log can
 * record it.
 */
export interface EligibilityInput {
  readonly suppressed: boolean;
  readonly believedMinor: boolean;
  readonly identityConfidence: number;
  readonly minIdentityConfidence: number;
  readonly deleted: boolean;
}

export type EligibilityResult =
  { readonly eligible: true } | { readonly eligible: false; readonly reason: IneligibilityReason };

export const INELIGIBILITY_REASONS = [
  'suppressed',
  'believed_minor',
  'identity_confidence_below_threshold',
  'deleted',
] as const;

export type IneligibilityReason = (typeof INELIGIBILITY_REASONS)[number];

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  if (input.deleted) return { eligible: false, reason: 'deleted' };
  if (input.suppressed) return { eligible: false, reason: 'suppressed' };
  // PRD §17.5 — the product is B2B; a suspected minor is never contacted.
  if (input.believedMinor) return { eligible: false, reason: 'believed_minor' };
  if (input.identityConfidence < input.minIdentityConfidence) {
    return { eligible: false, reason: 'identity_confidence_below_threshold' };
  }
  return { eligible: true };
}

/** Normalises an email into the only form suppression should ever store. */
export async function hashedEmailKey(email: string, salt: string): Promise<SuppressionMatchKey> {
  const normalized = email.trim().toLowerCase();
  const bytes = new TextEncoder().encode(`${salt}:${normalized}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `hashed_email:${hex}`;
}

export function platformKey(network: Network, platformUserId: string): SuppressionMatchKey {
  return `platform:${network}:${platformUserId}`;
}
