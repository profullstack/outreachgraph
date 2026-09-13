/**
 * People handed over from a social client.
 *
 * myna (and anything else that follows people on a network) knows a handle,
 * a display name, a bio and a profile URL, and nothing more. That is enough
 * to open a person here and put them in a campaign, so the rest of the
 * machinery can decide whether they are worth an offer: the bio becomes a
 * signal, the profile URL becomes an `openprofile` job that reads what the
 * profile and its home page say, and the recommendation engine re-decides
 * the person once that has landed.
 *
 * What this does not do is raise anybody's identity confidence. A handle the
 * caller followed is still a handle. The job that reads the profile is what
 * finds the rel=me link back and earns the confidence.
 */

import { isNetwork, newId, type Network } from '@outreachgraph/domain';
import { queryOne, type Client } from '@outreachgraph/db';
import { enqueue } from './queue';
import { recordDiscovered } from './stages';

/** Matches `HANDLE_ONLY_CONFIDENCE` in listen.ts: a handle is a claim, not an identity. */
const HANDLE_ONLY_CONFIDENCE = 0.35;
/** A bio is the person describing themselves; it says topic, not fit. */
const BIO_SIGNAL_CONFIDENCE = 0.6;
const BIO_SIGNAL_RELEVANCE = 0.4;

export interface SocialPersonInput {
  readonly network: string;
  readonly handle: string;
  readonly profileUrl?: string | undefined;
  readonly platformUserId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly bio?: string | undefined;
  readonly avatarUrl?: string | undefined;
  readonly followers?: number | undefined;
  /** How the caller came by them: `follow`, `following`, `followers`, `graph`. */
  readonly via?: string | undefined;
}

export interface IntakeDeps {
  readonly db: Client;
  readonly now?: Date;
}

export interface IntakeInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly people: readonly SocialPersonInput[];
  /** The client that sent them, recorded on every signal and provenance row. */
  readonly source: string;
}

export interface IntakePerson {
  readonly id: string;
  readonly network: Network;
  readonly handle: string;
  readonly created: boolean;
  /** False when an openprofile job for them was already outstanding. */
  readonly queued: boolean;
}

export interface IntakeResult {
  readonly people: readonly IntakePerson[];
  readonly created: number;
  readonly existing: number;
  readonly queued: number;
  readonly rejected: readonly { handle: string; reason: string }[];
}

/** The profile URL a network would serve for a bare handle, when we can say. */
export function profileUrlFor(network: Network, handle: string): string | undefined {
  const clean = handle.replace(/^@/, '');
  switch (network) {
    case 'bluesky':
      return `https://bsky.app/profile/${clean}`;
    case 'x':
      return `https://x.com/${clean}`;
    case 'github':
      return `https://github.com/${clean}`;
    case 'reddit':
      return `https://www.reddit.com/user/${clean}`;
    case 'instagram':
      return `https://www.instagram.com/${clean}/`;
    case 'mastodon': {
      const at = clean.indexOf('@');
      return at > 0 ? `https://${clean.slice(at + 1)}/@${clean.slice(0, at)}` : undefined;
    }
    default:
      return undefined;
  }
}

/** Normalise what a client sends: drop the `@`, keep a Fediverse host, refuse junk. */
export function normaliseSocialInput(
  input: SocialPersonInput,
): { network: Network; handle: string; profileUrl?: string | undefined } | { reason: string } {
  const network = String(input.network ?? '')
    .trim()
    .toLowerCase();
  if (!isNetwork(network)) return { reason: `unknown network ${network || '(empty)'}` };

  const handle = String(input.handle ?? '')
    .trim()
    .replace(/^@/, '');
  if (!handle || handle.length > 200 || /[\s<>"']/.test(handle)) return { reason: 'not a handle' };

  let profileUrl = input.profileUrl?.trim() || profileUrlFor(network, handle);
  if (profileUrl) {
    try {
      const parsed = new URL(profileUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') profileUrl = undefined;
    } catch {
      profileUrl = undefined;
    }
  }
  return { network, handle, profileUrl };
}

/**
 * Open (or find) each person, put them in the campaign, keep their bio as a
 * signal, and queue the profile read. Idempotent: the same handle sent twice
 * is one person, one membership, one signal, one outstanding job.
 */
export async function intakeSocialPeople(
  deps: IntakeDeps,
  input: IntakeInput,
): Promise<IntakeResult> {
  const { db } = deps;
  const at = deps.now ?? new Date();
  const stamp = at.toISOString();
  const people: IntakePerson[] = [];
  const rejected: { handle: string; reason: string }[] = [];
  let created = 0;
  let existing = 0;
  let queued = 0;

  for (const raw of input.people) {
    const cleaned = normaliseSocialInput(raw);
    if ('reason' in cleaned) {
      rejected.push({ handle: String(raw.handle ?? ''), reason: cleaned.reason });
      continue;
    }
    const { network, handle, profileUrl } = cleaned;

    const found = await findPerson(db, network, handle, raw.platformUserId);
    let personId = found;
    let isNew = false;
    if (!personId) {
      personId = newId('person');
      isNew = true;
      const avatar = raw.avatarUrl?.trim() || null;
      await db.execute({
        sql: `INSERT INTO people (id, display_name, identity_confidence, status, outreach_eligible,
                                  believed_minor, avatar_url, avatar_source, created_at, updated_at)
              VALUES (?, ?, ?, 'active', 1, 0, ?, ?, ?, ?)`,
        args: [
          personId,
          raw.displayName?.trim() || handle,
          HANDLE_ONLY_CONFIDENCE,
          avatar,
          avatar ? input.source : null,
          stamp,
          stamp,
        ],
      });
      await db.execute({
        sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id, profile_url,
                                             confidence, source_type, verified_by, first_seen_at, last_verified_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'public_web', '[]', ?, ?)`,
        args: [
          newId('socialIdentity'),
          personId,
          network,
          handle,
          raw.platformUserId?.trim() || null,
          profileUrl ?? null,
          HANDLE_ONLY_CONFIDENCE,
          stamp,
          stamp,
        ],
      });
      await recordProvenance(
        db,
        personId,
        'display_name',
        raw.displayName?.trim() || handle,
        input.source,
        profileUrl,
        stamp,
      );
      created += 1;
    } else {
      existing += 1;
      // A person we already had may have arrived without a face or a URL.
      if (raw.avatarUrl?.trim()) {
        await db.execute({
          sql: `UPDATE people SET avatar_url = ?, avatar_source = ?, updated_at = ?
                 WHERE id = ? AND avatar_url IS NULL`,
          args: [raw.avatarUrl.trim(), input.source, stamp, personId],
        });
      }
      if (profileUrl) {
        await db.execute({
          sql: `UPDATE social_identities SET profile_url = ? WHERE person_id = ? AND network = ? AND profile_url IS NULL`,
          args: [profileUrl, personId, network],
        });
      }
    }

    await db.execute({
      sql: `INSERT OR IGNORE INTO campaign_people (campaign_id, person_id, workspace_id, status,
                                                   interaction_state, discovered_at, updated_at)
            VALUES (?, ?, ?, 'discovered', 'never_contacted', ?, ?)`,
      args: [input.campaignId, personId, input.workspaceId, stamp, stamp],
    });
    if (isNew) {
      await recordDiscovered(db, {
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        personId,
        at: stamp,
      });
    }

    const bio = raw.bio?.trim();
    if (bio)
      await writeBioSignal(db, {
        workspaceId: input.workspaceId,
        personId,
        network,
        handle,
        bio,
        profileUrl,
        stamp,
      });

    const job = await enqueue(db, {
      workspaceId: input.workspaceId,
      kind: 'openprofile',
      payload: {
        personId,
        campaignId: input.campaignId,
        ...(profileUrl ? { profileUrl } : {}),
        source: input.source,
        via: raw.via ?? null,
      },
      dedupeKey: `openprofile:${personId}`,
    });
    if (job.queued) queued += 1;

    people.push({ id: personId, network, handle, created: isNew, queued: job.queued });
  }

  return { people, created, existing, queued, rejected };
}

async function findPerson(
  db: Client,
  network: Network,
  handle: string,
  platformUserId?: string,
): Promise<string | undefined> {
  if (platformUserId?.trim()) {
    const byId = await queryOne<{ person_id: string }>(
      db,
      `SELECT si.person_id FROM social_identities si JOIN people p ON p.id = si.person_id
        WHERE si.network = ? AND si.platform_user_id = ? AND p.status != 'deleted'
        ORDER BY si.confidence DESC LIMIT 1`,
      [network, platformUserId.trim()],
    );
    if (byId) return byId.person_id;
  }
  const byHandle = await queryOne<{ person_id: string }>(
    db,
    `SELECT si.person_id FROM social_identities si JOIN people p ON p.id = si.person_id
      WHERE si.network = ? AND si.handle = ? COLLATE NOCASE AND p.status != 'deleted'
      ORDER BY si.confidence DESC LIMIT 1`,
    [network, handle],
  );
  return byHandle?.person_id;
}

async function recordProvenance(
  db: Client,
  personId: string,
  field: string,
  value: string,
  provider: string,
  sourceUrl: string | undefined,
  stamp: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO field_provenance (id, entity_kind, entity_id, field, value, source_type, provider,
                                        source_record_id, license_class, confidence, observed_at, created_at)
          VALUES (?, 'person', ?, ?, ?, 'public_web', ?, ?, 'public', ?, ?, ?)`,
    args: [
      newId('fieldProvenance'),
      personId,
      field,
      value,
      provider,
      sourceUrl ?? null,
      HANDLE_ONLY_CONFIDENCE,
      stamp,
      stamp,
    ],
  });
}

/**
 * The bio as a `content_topic` signal, so the recommendation engine has a
 * trigger to weigh. One per network: the same bio sent again is the same
 * signal, not a fresher one.
 */
async function writeBioSignal(
  db: Client,
  input: {
    workspaceId: string;
    personId: string;
    network: Network;
    handle: string;
    bio: string;
    profileUrl?: string | undefined;
    stamp: string;
  },
): Promise<void> {
  const sourceUrl = input.profileUrl ?? `${input.network}:${input.handle}`;
  // One bio per network per person. A handle sent again in another case, or
  // with a slightly different profile URL, is the same person saying the same
  // thing, not a fresher signal.
  const already = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM signals WHERE workspace_id = ? AND person_id = ? AND subtype = 'social_bio' AND network = ? LIMIT 1`,
    [input.workspaceId, input.personId, input.network],
  );
  if (already) return;

  await db.execute({
    sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, subtype, summary, evidence,
                               source_url, source_timestamp, observed_at, confidence, relevance, sentiment)
          VALUES (?, ?, ?, ?, 'content_topic', 'social_bio', ?, ?, ?, ?, ?, ?, ?, 'neutral')`,
    args: [
      newId('signal'),
      input.workspaceId,
      input.personId,
      input.network,
      `${input.handle}: ${input.bio.slice(0, 180)}`,
      input.bio.slice(0, 2000),
      sourceUrl,
      input.stamp,
      input.stamp,
      BIO_SIGNAL_CONFIDENCE,
      BIO_SIGNAL_RELEVANCE,
    ],
  });
}
