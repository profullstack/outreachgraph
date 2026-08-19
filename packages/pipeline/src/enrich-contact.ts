/**
 * Finding the rest of an imported contact.
 *
 * An import gives you a mailbox and, if you are lucky, a name. That is enough
 * to send email and nothing else — no handle to reply to, no site to read, no
 * company to reason about. This is the step that turns a row into a person the
 * rest of the product can work with.
 *
 * Two sources, both free and both consented-to in the ordinary sense:
 *
 *   - **Gravatar**, keyed on the address, which returns whatever the owner
 *     chose to publish about themselves — frequently a GitHub handle, a
 *     Mastodon account, a personal site.
 *   - **The email domain**, for anyone not on a mailbox provider, which is the
 *     company and is already crawlable by machinery that exists.
 *
 * What is deliberately absent is anything that guesses. This product already
 * has a module that derives plausible addresses from a learned domain shape
 * and puts them in front of a human to confirm; inventing social handles by
 * the same trick would produce identities nobody can confirm, attached to
 * people who never published them.
 */

import { newId, isFreemailDomain, webPresenceFor } from '@outreachgraph/domain';
import { GRAVATAR_NETWORKS, lookupGravatar, type GravatarOptions } from '@outreachgraph/providers';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { enqueue } from './queue';
import { crawlDedupeKey } from './auto-approve';

/**
 * How much to believe a Gravatar-published account.
 *
 * High, because the link is self-published by the address's owner: they logged
 * into Gravatar and attached that GitHub account themselves. It is a stronger
 * claim than anything the crawler produces, and weaker than a reply from the
 * account, which is what the remaining headroom is for.
 */
const GRAVATAR_CONFIDENCE = 0.8;

/**
 * How many people one sweep looks up, and how many at once.
 *
 * Gravatar is a network round trip and nothing else: the work is entirely
 * waiting, so running it one at a time wastes the whole interval. Ten at once
 * against a public API that asks callers to identify themselves is polite
 * rather than aggressive, and two hundred a tick clears seventeen thousand in
 * roughly an hour and a half without a queue row per person.
 */
const SWEEP_SIZE = 200;
const SWEEP_CONCURRENCY = 10;

export interface SweepResult {
  readonly looked: number;
  readonly found: number;
  readonly identities: number;
  readonly remaining: number;
  /** Pages queued to read, deduplicated by host. */
  readonly pagesQueued: number;
  /** Addresses that point at no page at all — mailbox providers. */
  readonly noPresence: number;
}

/**
 * Looks up the next batch of imported people who have never been looked up.
 *
 * The set is derived — everyone with an imported address and no
 * `contact_enriched_at` — rather than materialised as jobs. Seventeen thousand
 * queue rows written inside one request is what made `finish` never return,
 * and a derived set cannot drift from the people who actually exist.
 *
 * A miss still stamps the timestamp. Most addresses have no published profile,
 * and a sweep that only recorded successes would retry those forever.
 */
export async function sweepContactEnrichment(
  db: Client,
  input: { readonly workspaceId: string; readonly limit?: number },
  options: GravatarOptions = {},
): Promise<SweepResult> {
  const limit = input.limit ?? SWEEP_SIZE;

  const rows = await queryAll<{ person_id: string; address: string }>(
    db,
    `SELECT pe.person_id, min(pe.address) AS address
       FROM person_emails pe
       JOIN people p ON p.id = pe.person_id
      WHERE pe.workspace_id = ? AND p.contact_enriched_at IS NULL AND p.status = 'active'
      GROUP BY pe.person_id
      ORDER BY min(pe.created_at)
      LIMIT ?`,
    [input.workspaceId, limit],
  );

  let found = 0;
  let identities = 0;
  let pagesQueued = 0;
  let noPresence = 0;

  // Fixed-size waves rather than one promise per person: seventeen thousand
  // concurrent fetches would be a denial of service on somebody else's free
  // API, and on our own event loop.
  for (let offset = 0; offset < rows.length; offset += SWEEP_CONCURRENCY) {
    const wave = rows.slice(offset, offset + SWEEP_CONCURRENCY);

    const results = await Promise.all(
      wave.map(async (row) => {
        try {
          return await enrichContact(
            db,
            { workspaceId: input.workspaceId, personId: row.person_id },
            options,
          );
        } catch {
          // One bad lookup costs that person, not the sweep. The timestamp is
          // still stamped below so it is not retried forever.
          return undefined;
        }
      }),
    );

    for (const result of results) {
      if (result?.found) found += 1;
      identities += result?.identities ?? 0;
    }

    // Reading the page the address points at is where the rest comes from.
    // Gravatar answers for about one person in a hundred; a Substack handle or
    // a company domain is a page that exists by construction, and the crawler
    // already knows how to pull a bio, a title and published social links out
    // of one.
    for (const row of wave) {
      const presence = webPresenceFor(row.address);

      if (!presence) {
        noPresence += 1;
        continue;
      }

      const queued = await enqueue(db, {
        workspaceId: input.workspaceId,
        kind: 'crawl_site',
        payload: { url: presence.url },
        // The same key everything else uses, so four hundred people at one
        // company read that company's site once — the lesson from #63, which
        // cost 226 identical crawls of accenture.com to learn.
        dedupeKey: crawlDedupeKey(presence.url),
      });

      if (queued.queued) pagesQueued += 1;
    }

    await db.batch(
      wave.map((row) => ({
        sql: 'UPDATE people SET contact_enriched_at = ? WHERE id = ?',
        args: [now(), row.person_id] as (string | number | null)[],
      })),
    );
  }

  const left = await queryOne<{ n: number }>(
    db,
    `SELECT count(DISTINCT pe.person_id) AS n
       FROM person_emails pe
       JOIN people p ON p.id = pe.person_id
      WHERE pe.workspace_id = ? AND p.contact_enriched_at IS NULL AND p.status = 'active'`,
    [input.workspaceId],
  );

  return {
    looked: rows.length,
    found,
    identities,
    pagesQueued,
    noPresence,
    remaining: Number(left?.n ?? 0),
  };
}

/** Workspaces with imported people still waiting to be looked up. */
export async function workspacesAwaitingEnrichment(db: Client): Promise<string[]> {
  const rows = await queryAll<{ workspace_id: string }>(
    db,
    `SELECT DISTINCT pe.workspace_id
       FROM person_emails pe
       JOIN people p ON p.id = pe.person_id
      WHERE p.contact_enriched_at IS NULL AND p.status = 'active'`,
  );

  return rows.map((row) => row.workspace_id);
}

export interface EnrichContactResult {
  readonly personId: string;
  readonly found: boolean;
  readonly identities: number;
  readonly filledName: boolean;
  readonly companyDomain?: string;
}

/**
 * Enriches one imported person.
 *
 * Never throws for a miss — most addresses have no Gravatar, and a queue of
 * seventeen thousand must treat that as the ordinary case rather than as
 * seventeen thousand failures to retry.
 */
export async function enrichContact(
  db: Client,
  input: { readonly workspaceId: string; readonly personId: string },
  options: GravatarOptions = {},
): Promise<EnrichContactResult> {
  const row = await queryOne<{ address: string }>(
    db,
    `SELECT address FROM person_emails WHERE workspace_id = ? AND person_id = ?
      ORDER BY created_at LIMIT 1`,
    [input.workspaceId, input.personId],
  );

  if (!row) return { personId: input.personId, found: false, identities: 0, filledName: false };

  const domain = row.address.slice(row.address.lastIndexOf('@') + 1);
  const companyDomain = isFreemailDomain(domain) ? undefined : domain;

  const profile = await lookupGravatar(row.address, options);

  if (!profile) {
    return {
      personId: input.personId,
      found: false,
      identities: 0,
      filledName: false,
      ...(companyDomain ? { companyDomain } : {}),
    };
  }

  let identities = 0;

  for (const account of profile.accounts) {
    const network = GRAVATAR_NETWORKS[account.service];
    // An account on something we cannot act through is still true, but storing
    // it as an identity would claim a channel we do not have.
    if (!network) continue;

    const inserted = await recordIdentity(db, {
      personId: input.personId,
      network,
      url: account.url,
      ...(account.handle ? { handle: account.handle } : {}),
    });

    if (inserted) identities += 1;
  }

  const filledName = await fillGaps(db, input.personId, profile);

  return {
    personId: input.personId,
    found: true,
    identities,
    filledName,
    ...(companyDomain ? { companyDomain } : {}),
  };
}

/**
 * Stores one published account, once.
 *
 * Keyed on (person, network, url) by hand rather than by index, because
 * `social_identities` only has a unique index where `platform_user_id` is
 * known and Gravatar does not supply one. Re-running enrichment is expected —
 * profiles change — so this has to be idempotent without it.
 */
async function recordIdentity(
  db: Client,
  input: {
    readonly personId: string;
    readonly network: string;
    readonly url: string;
    readonly handle?: string;
  },
): Promise<boolean> {
  const existing = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM social_identities WHERE person_id = ? AND network = ? AND profile_url = ?`,
    [input.personId, input.network, input.url],
  );

  if (existing) {
    await db.execute({
      sql: 'UPDATE social_identities SET last_verified_at = ? WHERE id = ?',
      args: [now(), existing.id],
    });
    return false;
  }

  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, profile_url, confidence,
          source_type, verified_by, first_seen_at, last_verified_at)
          VALUES (?, ?, ?, ?, ?, ?, 'self_published', ?, ?, ?)`,
    args: [
      newId('socialIdentity'),
      input.personId,
      input.network,
      input.handle ?? null,
      input.url,
      GRAVATAR_CONFIDENCE,
      JSON.stringify(['gravatar']),
      now(),
      now(),
    ],
  });

  return true;
}

/**
 * Fills in what the import could not, without overwriting what it did.
 *
 * A name derived from an address (`Dave Mackenzie` out of `dave.mackenzie@`)
 * is a guess; the one on a Gravatar profile is what the person calls
 * themselves. So the profile wins over a derived name and loses to a supplied
 * one — which is why `nameDerived` is recorded at import time rather than
 * thrown away.
 */
async function fillGaps(
  db: Client,
  personId: string,
  profile: { displayName?: string; fullName?: string; location?: string; job?: string },
): Promise<boolean> {
  const person = await queryOne<{
    display_name: string;
    current_title: string | null;
    location: string | null;
  }>(db, 'SELECT display_name, current_title, location FROM people WHERE id = ?', [personId]);

  if (!person) return false;

  const updates: string[] = [];
  const args: unknown[] = [];
  const published = profile.fullName ?? profile.displayName;

  // Only when what we hold looks derived: a local part with no space in it.
  const looksDerived = !person.display_name.includes(' ');

  if (published && looksDerived && published !== person.display_name) {
    updates.push('display_name = ?');
    args.push(published);
  }
  if (!person.current_title && profile.job) {
    updates.push('current_title = ?');
    args.push(profile.job);
  }
  if (!person.location && profile.location) {
    updates.push('location = ?');
    args.push(profile.location);
  }

  if (updates.length === 0) return false;

  updates.push('updated_at = ?');
  args.push(now(), personId);

  await db.execute({
    sql: `UPDATE people SET ${updates.join(', ')} WHERE id = ?`,
    args: args as never[],
  });

  return updates.some((clause) => clause.startsWith('display_name'));
}
