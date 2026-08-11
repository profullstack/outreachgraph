/**
 * Provenance (PRD §10.3, §48 Decision 3).
 *
 * Every material fact used in scoring or messaging carries the record of where
 * it came from. Provenance is structural rather than appended later, because
 * deletion, licensing enforcement and provider migration all need to trace a
 * value back to the record that produced it.
 */

import type { PrefixedId } from './ids';
import type { Network } from './networks';

export const SOURCE_TYPES = [
  'provider',
  'official_api',
  'public_web',
  'customer_data',
  'user_input',
  'derived',
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * Licence class governs retention and export. A field sourced from a licensed
 * enrichment provider may not be exportable on the same terms as a field the
 * customer supplied themselves (PRD §35, §47.18).
 */
export const LICENSE_CLASSES = [
  'licensed_enrichment',
  'public_api',
  'public_web',
  'customer_owned',
  'derived_inference',
] as const;

export type LicenseClass = (typeof LICENSE_CLASSES)[number];

/**
 * A single attributed value. `T` is the value type of the field being
 * attributed, so `Provenanced<string>` reads naturally for a name.
 */
export interface Provenanced<T> {
  readonly value: T;
  readonly sourceType: SourceType;
  /** Provider slug, e.g. `apollo`. Absent for user input and derivations. */
  readonly provider?: string;
  /** Identifier of the upstream record, for re-fetch and deletion tracing. */
  readonly sourceRecordId?: string;
  readonly sourceUrl?: string;
  /** When the source asserted this value. */
  readonly observedAt: string;
  readonly licenseClass: LicenseClass;
  readonly retentionPolicy?: string;
  readonly confidence: number;
}

/** Row form of the same idea, for the `field_provenance` table (PRD §21). */
export interface FieldProvenance {
  readonly id: PrefixedId<'fieldProvenance'>;
  readonly entityKind: 'person' | 'company' | 'social_identity';
  readonly entityId: string;
  readonly field: string;
  readonly value: string;
  readonly sourceType: SourceType;
  readonly provider?: string;
  readonly sourceRecordId?: string;
  readonly sourceUrl?: string;
  readonly observedAt: string;
  readonly licenseClass: LicenseClass;
  readonly retentionPolicy?: string;
  readonly confidence: number;
  readonly createdAt: string;
}

/**
 * A retained source artifact — a post, a page, an API payload. Retention is
 * minimised by default (PRD §35); `availability` flips to `unavailable` when
 * the source is deleted upstream so derived claims stop citing it (PRD §17.6).
 */
export interface SourceDocument {
  readonly id: PrefixedId<'sourceDocument'>;
  readonly workspaceId: PrefixedId<'workspace'>;
  readonly network: Network;
  readonly url?: string;
  readonly title?: string;
  /** Normalised text. May be dropped on retention expiry while the row lives on. */
  readonly excerpt?: string;
  readonly publishedAt?: string;
  readonly fetchedAt: string;
  readonly availability: SourceAvailability;
  readonly licenseClass: LicenseClass;
  readonly contentHash?: string;
  readonly expiresAt?: string;
}

export const SOURCE_AVAILABILITY = ['available', 'unavailable', 'expired'] as const;
export type SourceAvailability = (typeof SOURCE_AVAILABILITY)[number];

/**
 * A source can ground a generated claim only while it is available. The
 * composer's grounding check (PRD §14.1) calls this.
 */
export function canGroundClaims(doc: Pick<SourceDocument, 'availability' | 'excerpt'>): boolean {
  return (
    doc.availability === 'available' && typeof doc.excerpt === 'string' && doc.excerpt.length > 0
  );
}
