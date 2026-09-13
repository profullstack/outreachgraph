/**
 * A face for each lead.
 *
 * The digest and the queue list people by name and title, and a name is a
 * poor handle on a stranger: "Mark Ramsey — Global Senior Pastor at Citipointe
 * Church" reads as a line item, the same line with a photograph reads as a
 * person. Gravatar supplies one for about a person in a hundred; for the rest
 * a search finds the picture on their LinkedIn profile or their company's own
 * team page, and only those — see `@outreachgraph/providers` for why the page
 * matters more than the picture.
 *
 * Bounded twice, because every lookup costs money and most of them miss:
 *
 *   - **Per tick.** A small batch, so a workspace that just enrolled a
 *     thousand people does not spend a thousand credits in one minute.
 *   - **Per day.** A ceiling on lookups per workspace per day, counted from
 *     the `photo_looked_up_at` stamps rather than from memory so a restart
 *     cannot reset it.
 *
 * And scoped to people the workspace is actually working — members of an
 * active campaign — rather than everyone ever imported. A picture of someone
 * nobody will write to is a credit spent on nothing.
 */

import { newId } from '@outreachgraph/domain';
import type { ProfilePhotoFinder } from '@outreachgraph/providers';
import { isLinkedInProfile } from '@outreachgraph/providers';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';

/** Lookups per workspace per tick. */
const SWEEP_SIZE = 20;
/** Lookups per workspace per day, absent a configured ceiling. */
const DEFAULT_DAILY_CAP = 300;

/**
 * How much to believe a LinkedIn URL found by search.
 *
 * Below the outreach floor on purpose. The result carried the person's name
 * and the company we already had for them, which is enough to show a human
 * the profile as research and nowhere near enough to act on it. Confirmation
 * comes from the human, in LinkedIn's own interface.
 */
const SEARCH_IDENTITY_CONFIDENCE = 0.6;

export interface PhotoSweepDeps {
  readonly db: Client;
  readonly finder: ProfilePhotoFinder;
  readonly limit?: number;
  readonly dailyCap?: number;
  readonly now?: Date;
}

export interface PhotoSweepResult {
  readonly looked: number;
  readonly found: number;
  /** LinkedIn profiles recorded as research identities along the way. */
  readonly profiles: number;
  /** Lookups left under today's ceiling after this run. */
  readonly remainingToday: number;
}

interface Subject {
  readonly person_id: string;
  readonly display_name: string;
  readonly current_title: string | null;
  readonly company_name: string | null;
  readonly company_domain: string | null;
}

/**
 * Looks up the next batch of people in this workspace's campaigns who have no
 * picture and have never been looked up.
 *
 * People with a message waiting to go out come first: they are the ones about
 * to appear in the digest as "written to", and the ones a reviewer is about to
 * open in the queue.
 */
export async function sweepProfilePhotos(
  deps: PhotoSweepDeps,
  input: { readonly workspaceId: string },
): Promise<PhotoSweepResult> {
  const at = deps.now ?? new Date();
  const dailyCap = deps.dailyCap ?? DEFAULT_DAILY_CAP;
  const dayStart = `${at.toISOString().slice(0, 10)}T00:00:00.000Z`;

  const spent = await queryOne<{ n: number }>(
    deps.db,
    `SELECT count(*) AS n FROM people p
      WHERE p.photo_looked_up_at >= ?
        AND EXISTS (SELECT 1 FROM campaign_people cp
                     WHERE cp.person_id = p.id AND cp.workspace_id = ?)`,
    [dayStart, input.workspaceId],
  );

  const room = Math.max(dailyCap - Number(spent?.n ?? 0), 0);
  const limit = Math.min(deps.limit ?? SWEEP_SIZE, room);

  if (limit === 0) return { looked: 0, found: 0, profiles: 0, remainingToday: 0 };

  const subjects = await queryAll<Subject>(
    deps.db,
    `SELECT p.id AS person_id, p.display_name, p.current_title,
            co.name AS company_name, co.domain AS company_domain
       FROM people p
       JOIN campaign_people cp ON cp.person_id = p.id
       JOIN campaigns c ON c.id = cp.campaign_id
       LEFT JOIN companies co ON co.id = p.current_company_id
      WHERE cp.workspace_id = ? AND c.status IN ('active', 'running')
        AND p.status = 'active' AND p.kind = 'person'
        AND p.avatar_url IS NULL AND p.photo_looked_up_at IS NULL
      GROUP BY p.id
      ORDER BY EXISTS (SELECT 1 FROM recommendations r
                        WHERE r.person_id = p.id AND r.status = 'pending'
                          AND r.action NOT IN ('refresh_research', 'observe', 'wait')) DESC,
               cp.updated_at DESC
      LIMIT ?`,
    [input.workspaceId, limit],
  );

  let found = 0;
  let profiles = 0;

  for (const subject of subjects) {
    const photo = await deps.finder
      .findProfilePhoto({
        name: subject.display_name,
        title: subject.current_title ?? undefined,
        company: subject.company_name ?? undefined,
        companyDomain: subject.company_domain ?? undefined,
      })
      .catch(() => undefined);

    // A miss is stamped so it is not retried forever; only a hit fills the URL.
    if (!photo) {
      await deps.db.execute({
        sql: 'UPDATE people SET photo_looked_up_at = ? WHERE id = ?',
        args: [now(), subject.person_id],
      });
      continue;
    }

    found += 1;
    await deps.db.execute({
      sql: `UPDATE people SET avatar_url = ?, avatar_source = ?, photo_looked_up_at = ?,
                              updated_at = ?
             WHERE id = ? AND avatar_url IS NULL`,
      args: [
        photo.photoUrl,
        photo.source === 'linkedin' ? 'search' : 'site',
        now(),
        now(),
        subject.person_id,
      ],
    });

    // The profile the picture came from is the more useful half of the
    // answer: it is the page the human will open to act. Recorded as research,
    // once, and never at a confidence that could let a machine use it.
    if (
      photo.source === 'linkedin' &&
      (await recordProfile(deps.db, subject.person_id, photo.pageUrl))
    ) {
      profiles += 1;
    }
  }

  return {
    looked: subjects.length,
    found,
    profiles,
    remainingToday: Math.max(room - subjects.length, 0),
  };
}

/** Workspaces with campaign members still waiting for a picture. */
export async function workspacesAwaitingPhotos(db: Client): Promise<string[]> {
  const rows = await queryAll<{ workspace_id: string }>(
    db,
    `SELECT DISTINCT cp.workspace_id
       FROM campaign_people cp
       JOIN campaigns c ON c.id = cp.campaign_id
       JOIN people p ON p.id = cp.person_id
      WHERE c.status IN ('active', 'running') AND p.status = 'active'
        AND p.avatar_url IS NULL AND p.photo_looked_up_at IS NULL`,
  );

  return rows.map((row) => row.workspace_id);
}

async function recordProfile(db: Client, personId: string, pageUrl: string): Promise<boolean> {
  let host: string;
  let path: string;
  try {
    const url = new URL(pageUrl);
    host = url.hostname.toLowerCase();
    path = url.pathname;
  } catch {
    return false;
  }
  if (!isLinkedInProfile(host, path)) return false;

  const existing = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM social_identities WHERE person_id = ? AND network = 'linkedin' LIMIT 1`,
    [personId],
  );
  if (existing) return false;

  const handle = path.split('/').filter(Boolean)[1] ?? null;
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, profile_url, confidence,
          source_type, verified_by, first_seen_at, last_verified_at)
          VALUES (?, ?, 'linkedin', ?, ?, ?, 'public_web', ?, ?, ?)`,
    args: [
      newId('socialIdentity'),
      personId,
      handle,
      `https://${host}${path}`,
      SEARCH_IDENTITY_CONFIDENCE,
      JSON.stringify(['search']),
      stamp,
      stamp,
    ],
  });

  return true;
}
