/**
 * The `openprofile` job: read what a person's public profiles say, write
 * their OpenProfile.md, keep what the sources corroborate, and re-decide them.
 *
 * Order of trust, and why it matters here: the network's own API is the
 * person describing themselves; the site their profile links to is a page
 * they control; a `rel="me"` from that site back to the profile is the
 * person confirming, in two places, that both are theirs. Only that last
 * case raises identity confidence past the handle-only floor, because only
 * it is two sources agreeing rather than one source repeated.
 *
 * Nothing here sends anything. The most it does is queue a recommendation,
 * which the same approval path as every other card still gates.
 */

import { newId, type Network } from '@outreachgraph/domain';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  buildOpenProfile,
  extractProfilePage,
  fetchPage,
  mergeFacts,
  networkForUrl,
  readBlueskyProfile,
  readMastodonProfile,
  readPublishedOpenProfile,
  wellKnownOpenProfile,
  type FetchLike,
  type ProfileAccount,
  type ProfileFacts,
} from '@outreachgraph/providers';
import { regenerateFor } from './pipeline';
import type { QueuedJob } from './queue';

/** Two sources agreed: the profile names the site and the site names the profile. */
const CORROBORATED_CONFIDENCE = 0.9;
/** The network answered for the handle with a real profile. One source, but a live one. */
const PROFILE_SEEN_CONFIDENCE = 0.5;
/** A link the person put in their own profile, unverified by the other end. */
const LINKED_CONFIDENCE = 0.6;

export interface OpenProfileDeps {
  readonly db: Client;
  readonly fetchImpl?: FetchLike;
  readonly now?: Date;
  /** Skip the recommendation step, for callers that only want the file. */
  readonly regenerate?: boolean;
}

export interface OpenProfileResult {
  readonly personId: string;
  readonly outcome: 'ok' | 'published' | 'unreadable' | 'skipped';
  /** Accounts the profile now lists, `me` and `link` together. */
  readonly accounts: number;
  /** Identities added to the person from what was read. */
  readonly identities: number;
  readonly corroborated: boolean;
  readonly recommendationId?: string | undefined;
  readonly detail?: string | undefined;
}

interface IdentityRow {
  id: string;
  network: Network;
  handle: string;
  platform_user_id: string | null;
  profile_url: string | null;
  confidence: number;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function sameProfile(a: string, b: string): boolean {
  const norm = (url: string) =>
    url
      .replace(/^https?:\/\/(www\.)?/i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  return norm(a) === norm(b);
}

/** Read the profile itself, by whichever door the network leaves open. */
async function readProfile(
  identity: IdentityRow,
  profileUrl: string | undefined,
  deps: OpenProfileDeps,
): Promise<ProfileFacts | undefined> {
  const options = { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };
  if (identity.network === 'bluesky') return readBlueskyProfile(identity.handle, options);
  if (identity.network === 'mastodon')
    return readMastodonProfile(profileUrl ?? identity.handle, options);
  if (!profileUrl) return undefined;
  const page = await fetchPage(profileUrl, options);
  if (page.outcome !== 'ok' || !page.html) return undefined;
  return extractProfilePage(page.html, page.finalUrl);
}

/** The person's home page: OpenGraph, rel=me links, and their own OpenProfile.md if any. */
async function readSite(
  web: string,
  deps: OpenProfileDeps,
): Promise<{ facts?: ProfileFacts; published?: { url: string; markdown: string } }> {
  const options = { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };
  const page = await fetchPage(web, options);
  const facts =
    page.outcome === 'ok' && page.html ? extractProfilePage(page.html, page.finalUrl) : undefined;

  const candidates = [facts?.openprofileUrl, wellKnownOpenProfile(page.finalUrl ?? web)].filter(
    (url): url is string => Boolean(url),
  );
  const published = await readPublishedOpenProfile(candidates, options);
  return { ...(facts ? { facts } : {}), ...(published ? { published } : {}) };
}

/**
 * Keep every account the sources named as a social identity, at a confidence
 * that says how it was found. Handle-and-network duplicates are skipped; an
 * existing row is only ever raised, never lowered.
 */
async function recordIdentities(
  db: Client,
  personId: string,
  accounts: readonly ProfileAccount[],
  stamp: string,
): Promise<number> {
  const existing = await queryAll<{
    network: string;
    handle: string;
    confidence: number;
    id: string;
  }>(db, 'SELECT id, network, handle, confidence FROM social_identities WHERE person_id = ?', [
    personId,
  ]);
  const known = new Map(existing.map((row) => [`${row.network}:${row.handle.toLowerCase()}`, row]));
  let added = 0;

  for (const entry of accounts) {
    let network: Network | undefined;
    let handle: string | undefined;
    if (/^mailto:/i.test(entry.url)) {
      network = 'email';
      handle = entry.url
        .replace(/^mailto:/i, '')
        .split('?')[0]
        ?.trim()
        .toLowerCase();
    } else {
      network = entry.network ?? (entry.relation === 'me' ? 'website' : undefined);
      handle = entry.network ? handleOf(entry.url) : hostOf(entry.url);
    }
    if (!network || !handle) continue;

    const confidence = entry.relation === 'me' ? CORROBORATED_CONFIDENCE : LINKED_CONFIDENCE;
    const key = `${network}:${handle.toLowerCase()}`;
    const found = known.get(key);
    if (found) {
      if (confidence > found.confidence) {
        await db.execute({
          sql: 'UPDATE social_identities SET confidence = ?, last_verified_at = ? WHERE id = ?',
          args: [confidence, stamp, found.id],
        });
      }
      continue;
    }
    await db.execute({
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id, profile_url,
                                           confidence, source_type, verified_by, first_seen_at, last_verified_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?, 'public_web', ?, ?, ?)`,
      args: [
        newId('socialIdentity'),
        personId,
        network,
        handle,
        /^mailto:/i.test(entry.url) ? null : entry.url,
        confidence,
        JSON.stringify(entry.relation === 'me' ? ['rel=me'] : []),
        stamp,
        stamp,
      ],
    });
    known.set(key, { id: '', network, handle, confidence });
    added += 1;
  }
  return added;
}

function handleOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (networkForUrl(url) === 'mastodon') {
      const user = parsed.pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '');
      return user ? (user.includes('@') ? user : `${user}@${parsed.hostname}`) : undefined;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    const first = segments[0];
    if (!first) return undefined;
    const nested = /^(in|profile|user|u|c|channel)$/i.test(first) ? segments[1] : first;
    return nested?.replace(/^@/, '');
  } catch {
    return undefined;
  }
}

export async function runOpenProfileJob(
  deps: OpenProfileDeps,
  job: QueuedJob,
): Promise<OpenProfileResult> {
  const { db } = deps;
  const stamp = (deps.now ?? new Date()).toISOString();
  const payload = job.payload as { personId?: string; profileUrl?: string; campaignId?: string };
  const personId = payload.personId;
  if (!personId) throw new Error('openprofile needs personId');

  const person = await queryOne<{
    id: string;
    display_name: string;
    identity_confidence: number;
    avatar_url: string | null;
    status: string;
  }>(
    db,
    'SELECT id, display_name, identity_confidence, avatar_url, status FROM people WHERE id = ?',
    [personId],
  );
  if (!person || person.status === 'deleted')
    return {
      personId,
      outcome: 'skipped',
      accounts: 0,
      identities: 0,
      corroborated: false,
      detail: 'no such person',
    };

  const identities = await queryAll<IdentityRow>(
    db,
    `SELECT id, network, handle, platform_user_id, profile_url, confidence FROM social_identities
      WHERE person_id = ? ORDER BY confidence DESC, first_seen_at ASC`,
    [personId],
  );
  const primary =
    identities.find(
      (row) =>
        payload.profileUrl && row.profile_url && sameProfile(row.profile_url, payload.profileUrl),
    ) ??
    identities.find((row) => row.network !== 'email' && row.network !== 'website') ??
    identities[0];
  if (!primary)
    return {
      personId,
      outcome: 'skipped',
      accounts: 0,
      identities: 0,
      corroborated: false,
      detail: 'no social identity',
    };

  const profileUrl = payload.profileUrl ?? primary.profile_url ?? undefined;
  const profile = await readProfile(primary, profileUrl, deps);
  if (!profile) {
    return {
      personId,
      outcome: 'unreadable',
      accounts: 0,
      identities: 0,
      corroborated: false,
      detail: `could not read ${profileUrl ?? primary.handle}`,
    };
  }
  const sources: string[] = [profile.source];
  const facts: ProfileFacts[] = [profile];

  // The home page, when the profile names one: its card, and whether it points back.
  let corroborated = false;
  let published: { url: string; markdown: string } | undefined;
  const web =
    profile.web ??
    profile.accounts.find((entry) => !entry.network && !/^mailto:/i.test(entry.url))?.url;
  if (web) {
    const site = await readSite(web, deps);
    if (site.facts) {
      sources.push(site.facts.source);
      const profileHost = hostOf(profile.source);
      corroborated = site.facts.accounts.some(
        (entry) =>
          entry.relation === 'me' &&
          (sameProfile(entry.url, profile.source) ||
            (profileUrl && sameProfile(entry.url, profileUrl)) ||
            (entry.network === primary.network &&
              hostOf(entry.url) === profileHost &&
              handleOf(entry.url)?.toLowerCase() === primary.handle.toLowerCase())),
      );
      // A page that vouches for the profile is one whose links we take as the
      // person's; one that does not is still their card, but its other links
      // are only links.
      facts.push(
        corroborated
          ? site.facts
          : {
              ...site.facts,
              accounts: site.facts.accounts.map((entry) => ({
                ...entry,
                relation: 'link' as const,
              })),
            },
      );
    }
    if (site.published) {
      published = site.published;
      sources.push(site.published.url);
    }
  }

  const merged = mergeFacts(primary.handle, profile.source, facts);
  const markdown = published?.markdown ?? buildOpenProfile({ ...merged, web: merged.web ?? web });

  await db.execute({
    sql: `INSERT INTO openprofiles (person_id, markdown, sources_json, published_url, generated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(person_id) DO UPDATE SET markdown = excluded.markdown, sources_json = excluded.sources_json,
                                              published_url = excluded.published_url, generated_at = excluded.generated_at`,
    args: [personId, markdown, JSON.stringify(sources), published?.url ?? null, stamp],
  });

  // What the sources corroborate, kept where the rest of the product reads it.
  const identitiesAdded = await recordIdentities(
    db,
    personId,
    merged.accounts.concat(
      merged.email
        ? [
            {
              url: `mailto:${merged.email}`,
              relation: corroborated ? 'me' : 'link',
              label: 'Email',
            },
          ]
        : [],
    ),
    stamp,
  );

  const confidence = Math.max(
    person.identity_confidence,
    corroborated ? CORROBORATED_CONFIDENCE : PROFILE_SEEN_CONFIDENCE,
  );
  const displayName =
    person.display_name === primary.handle && merged.name && merged.name !== primary.handle
      ? merged.name
      : person.display_name;
  await db.execute({
    sql: `UPDATE people SET display_name = ?, identity_confidence = ?, avatar_url = COALESCE(avatar_url, ?),
                            avatar_source = CASE WHEN avatar_url IS NULL AND ? IS NOT NULL THEN 'profile' ELSE avatar_source END,
                            last_resolved_at = ?, updated_at = ?
           WHERE id = ?`,
    args: [
      displayName,
      confidence,
      merged.avatar ?? null,
      merged.avatar ?? null,
      stamp,
      stamp,
      personId,
    ],
  });
  await db.execute({
    sql: 'UPDATE social_identities SET confidence = MAX(confidence, ?), last_verified_at = ?, platform_user_id = COALESCE(platform_user_id, ?) WHERE id = ?',
    args: [confidence, stamp, profile.platformUserId ?? null, primary.id],
  });

  let recommendationId: string | undefined;
  if (deps.regenerate !== false) {
    const campaignId =
      payload.campaignId ??
      (
        await queryOne<{ campaign_id: string }>(
          db,
          `SELECT campaign_id FROM campaign_people WHERE person_id = ? AND workspace_id = ? ORDER BY updated_at DESC LIMIT 1`,
          [personId, job.workspaceId],
        )
      )?.campaign_id;
    if (campaignId) {
      recommendationId = await regenerateFor(
        { db, workspaceId: job.workspaceId, campaignId, providers: [] },
        personId,
      );
    }
  }

  return {
    personId,
    outcome: published ? 'published' : 'ok',
    accounts: merged.accounts.length,
    identities: identitiesAdded,
    corroborated,
    recommendationId,
  };
}
