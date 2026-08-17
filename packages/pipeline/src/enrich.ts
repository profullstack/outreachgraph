/**
 * Finding a way to reach a prospect as themselves.
 *
 * The whole product stops at the same wall: 213 people in production, every
 * one with a name and a company and no personal address, so every message
 * resolves to a shared `support@`. The address limits added after one inbox
 * received fourteen messages are working exactly as intended, and the result
 * is a queue where nothing can be approved — not because the limits are wrong,
 * but because there is nowhere else to send.
 *
 * The routes that do not work, each ruled out on evidence rather than taste:
 *
 *   - **Crawling deeper.** `/team`, `/about` and `/contact` were fetched for
 *     eight of these companies. Every published address was a role mailbox.
 *     Modern SaaS does not put staff addresses on the marketing site.
 *   - **Commit metadata.** The addresses are public and the platforms that
 *     publish them forbid using them for unsolicited mail. Not a gap to close.
 *   - **A licensed provider.** Works, costs money per lookup, and is somebody
 *     else's decision to make. `PersonEnrichmentProvider` and the waterfall
 *     already exist for exactly this, so it drops in beside this module rather
 *     than replacing it.
 *
 * What is left is what this does: learn the shape a company writes addresses
 * in from one address already known to be right, and apply it to colleagues.
 *
 * The safety property that makes it defensible is that **nothing here can send
 * anything**. Proposals live in `email_candidates`; the sender reads
 * `social_identities`, which only `confirmCandidate` writes to, and only when
 * a human has said yes. A derived address is a question put to the operator,
 * never an answer the machine acts on.
 *
 * The loop this creates is the point. Confirming one address at a company
 * turns its colleagues from guesses into derivations — 17 people behind
 * `support@userlist.com` become 17 one-click confirmations, each of which
 * sharpens the next.
 */

import { newId, splitPersonName, type SplitName } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  candidateAddresses,
  inferPatterns,
  type AddressCandidate,
  type EmailPattern,
} from '@outreachgraph/providers';

/** How many proposals to keep per person. Beyond a few it is noise to review. */
const MAX_PER_PERSON = 4;

/**
 * A shape check, not a validation.
 *
 * Enough to reject a stray word or a pasted name; deliberately not an attempt
 * to encode RFC 5322, which rejects real addresses far more often than it
 * catches typos. Whether the mailbox exists is a question this cannot answer
 * and does not pretend to.
 */
const LOOKS_LIKE_ADDRESS = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export interface EnrichCandidateRow {
  readonly id: string;
  readonly person_id: string;
  readonly address: string;
  readonly pattern: string;
  readonly derived: number;
  readonly confidence: number;
  readonly status: string;
  readonly basis: string | null;
}

/**
 * The address shapes already confirmed at a domain.
 *
 * Reads only identities a human confirmed or a provider vouched for, and
 * re-derives the pattern from each rather than storing it: the person's name
 * is the other half of the inference, and names get corrected.
 *
 * A domain with several confirmations that disagree keeps all of them. That is
 * honest — plenty of companies genuinely run two shapes after an acquisition —
 * and `candidateAddresses` already divides confidence between them.
 */
export async function knownPatternsForDomain(
  db: Client,
  workspaceId: string,
  domain: string,
): Promise<readonly EmailPattern[]> {
  const rows = await queryAll<{ handle: string; display_name: string }>(
    db,
    `SELECT si.handle, p.display_name
       FROM social_identities si
       JOIN people p ON p.id = si.person_id
       JOIN companies co ON co.id = p.current_company_id
       JOIN campaign_people cp ON cp.person_id = p.id AND cp.workspace_id = ?
      WHERE si.network = 'email'
        AND si.handle IS NOT NULL AND trim(si.handle) <> ''
        AND lower(trim(co.domain)) = ?
      GROUP BY si.id`,
    [workspaceId, domain.trim().toLowerCase()],
  );

  const patterns = new Set<EmailPattern>();

  for (const row of rows) {
    const name = splitPersonName(row.display_name);
    if (!name) continue;
    for (const pattern of inferPatterns(row.handle, name, domain)) patterns.add(pattern);
  }

  return [...patterns];
}

/** Why this address was proposed, in the words the reviewer sees. */
function describeBasis(candidate: AddressCandidate, domain: string, learnedFrom: number): string {
  if (candidate.derived) {
    return (
      `${domain} writes addresses as ${candidate.pattern}, learned from ` +
      `${learnedFrom} confirmed address${learnedFrom === 1 ? '' : 'es'} at this company.`
    );
  }
  return (
    `No confirmed address at ${domain} yet, so this is the common ` +
    `${candidate.pattern} shape and nothing more. Worth checking before use.`
  );
}

export interface ProposeResult {
  readonly considered: number;
  readonly proposed: number;
  readonly skipped: number;
  /** Domains that produced derived rather than guessed candidates. */
  readonly domainsLearned: readonly string[];
}

interface PersonRow {
  readonly id: string;
  readonly display_name: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly domain: string;
}

/**
 * Proposes addresses for everyone in the workspace who has no way to be reached.
 *
 * Only people with no personal email identity, whose company has a domain, and
 * whose name actually splits. A role account like `webmaster` splits into
 * nothing and is passed over, which is the correct answer rather than a
 * limitation — there is no first name there to build an address from.
 *
 * Re-running is safe and is the intended usage: a decision already recorded is
 * never overwritten, so a rejected address stays rejected and a confirmed one
 * stays confirmed, while proposals are refreshed against whatever has been
 * learned since.
 */
export async function proposeAddresses(
  db: Client,
  workspaceId: string,
  options: { readonly personId?: string } = {},
): Promise<ProposeResult> {
  const people = await queryAll<PersonRow>(
    db,
    `SELECT DISTINCT p.id, p.display_name, p.first_name, p.last_name,
            lower(trim(co.domain)) AS domain
       FROM people p
       JOIN campaign_people cp ON cp.person_id = p.id AND cp.workspace_id = ?
       JOIN companies co ON co.id = p.current_company_id
      WHERE co.domain IS NOT NULL AND trim(co.domain) <> ''
        AND p.status = 'active'
        ${options.personId ? 'AND p.id = ?' : ''}
        AND NOT EXISTS (
          SELECT 1 FROM social_identities si
           WHERE si.person_id = p.id AND si.network = 'email'
             AND si.handle IS NOT NULL AND trim(si.handle) <> ''
        )`,
    options.personId ? [workspaceId, options.personId] : [workspaceId],
  );

  // Learned once per domain, not once per person: seventeen colleagues share
  // one answer, and the query behind it is the expensive part.
  const patternCache = new Map<string, readonly EmailPattern[]>();
  const domainsLearned = new Set<string>();

  let proposed = 0;
  let skipped = 0;

  for (const person of people) {
    const name = nameOf(person);
    if (!name) {
      skipped += 1;
      continue;
    }

    let known = patternCache.get(person.domain);
    if (known === undefined) {
      known = await knownPatternsForDomain(db, workspaceId, person.domain);
      patternCache.set(person.domain, known);
    }
    if (known.length > 0) domainsLearned.add(person.domain);

    // Splitting the name is also the moment to record it. Production stores
    // the whole name in `display_name` and leaves both parts null for 212 of
    // 213 people, and everything downstream that wants a first name — this
    // module, and any greeting — has been going without.
    if (!person.first_name || (name.lastName && !person.last_name)) {
      await db.execute({
        sql: `UPDATE people SET first_name = ?, last_name = ?, updated_at = ? WHERE id = ?`,
        args: [name.firstName, name.lastName ?? null, now(), person.id],
      });
    }

    const candidates = candidateAddresses(name, person.domain, known).slice(0, MAX_PER_PERSON);

    for (const candidate of candidates) {
      const inserted = await upsertProposal(db, {
        workspaceId,
        personId: person.id,
        candidate,
        basis: describeBasis(candidate, person.domain, known.length),
      });
      if (inserted) proposed += 1;
    }
  }

  return {
    considered: people.length,
    proposed,
    skipped,
    domainsLearned: [...domainsLearned],
  };
}

/** Prefers the stored parts when they exist, and falls back to the display name. */
function nameOf(person: PersonRow): SplitName | undefined {
  if (person.first_name && person.first_name.trim()) {
    return {
      firstName: person.first_name.trim(),
      ...(person.last_name?.trim() ? { lastName: person.last_name.trim() } : {}),
    };
  }
  return splitPersonName(person.display_name);
}

/**
 * Writes one proposal, leaving any decision already made alone.
 *
 * `ON CONFLICT ... WHERE status = 'proposed'` is the whole guard: re-running
 * the stage refreshes an undecided row's confidence and basis as the domain is
 * learned, and cannot resurrect an address the operator has already rejected.
 */
async function upsertProposal(
  db: Client,
  input: {
    workspaceId: string;
    personId: string;
    candidate: AddressCandidate;
    basis: string;
  },
): Promise<boolean> {
  const stamp = now();

  const result = await db.execute({
    sql: `INSERT INTO email_candidates (id, workspace_id, person_id, address, pattern,
          derived, confidence, status, basis, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)
          ON CONFLICT (workspace_id, person_id, address) DO UPDATE
            SET pattern = excluded.pattern,
                derived = excluded.derived,
                confidence = excluded.confidence,
                basis = excluded.basis,
                updated_at = excluded.updated_at
          WHERE email_candidates.status = 'proposed'`,
    args: [
      newId('emailCandidate'),
      input.workspaceId,
      input.personId,
      input.candidate.address,
      input.candidate.pattern,
      input.candidate.derived ? 1 : 0,
      input.candidate.confidence,
      input.basis,
      stamp,
      stamp,
    ],
  });

  return Number(result.rowsAffected ?? 0) > 0;
}

/** Everything proposed for one person, best first. */
export async function candidatesForPerson(
  db: Client,
  workspaceId: string,
  personId: string,
): Promise<readonly EnrichCandidateRow[]> {
  return queryAll<EnrichCandidateRow>(
    db,
    `SELECT id, person_id, address, pattern, derived, confidence, status, basis
       FROM email_candidates
      WHERE workspace_id = ? AND person_id = ? AND status <> 'rejected'
   ORDER BY derived DESC, confidence DESC`,
    [workspaceId, personId],
  );
}

export interface DecisionInput {
  readonly workspaceId: string;
  readonly personId: string;
  readonly address: string;
  readonly actorId: string;
}

/**
 * Accepts an address, and only here does a proposal become reachable.
 *
 * Two writes, and the second is the one that matters: the `social_identities`
 * row is what `pickEmailRecipient` reads, so confirming is exactly the moment
 * a prospect stops resolving to their company's shared inbox. Because the
 * address is personal rather than shared, the address limits stop counting
 * them against seventeen colleagues too.
 *
 * `source_type` is `human` on purpose. The operator is the evidence — that is
 * what makes this a grounded claim rather than the guess it started as.
 */
export async function confirmCandidate(
  db: Client,
  input: DecisionInput,
): Promise<{ confirmed: boolean; identityId?: string }> {
  const address = input.address.trim().toLowerCase();
  const stamp = now();

  if (!LOOKS_LIKE_ADDRESS.test(address)) return { confirmed: false };

  let candidate = await queryOne<{ id: string; status: string }>(
    db,
    `SELECT id, status FROM email_candidates
      WHERE workspace_id = ? AND person_id = ? AND address = ?`,
    [input.workspaceId, input.personId, address],
  );

  // An address the operator simply knows is the most valuable input there is,
  // and refusing it because this module did not think of it first would be
  // perverse: it is the one that teaches the domain's shape to everybody else.
  // So a confirmation of something unproposed records it rather than rejecting
  // it — the human is the source either way.
  if (!candidate) {
    const id = newId('emailCandidate');
    await db.execute({
      sql: `INSERT INTO email_candidates (id, workspace_id, person_id, address, pattern,
            derived, confidence, status, basis, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'supplied', 0, 1.0, 'proposed', ?, ?, ?)`,
      args: [
        id,
        input.workspaceId,
        input.personId,
        address,
        'Supplied by the operator rather than derived.',
        stamp,
        stamp,
      ],
    });
    candidate = { id, status: 'proposed' };
  }

  const identityId = newId('socialIdentity');

  await db.batch([
    {
      sql: `UPDATE email_candidates
               SET status = 'confirmed', decided_by = ?, decided_at = ?, updated_at = ?
             WHERE id = ?`,
      args: [input.actorId, stamp, stamp, candidate.id],
    },
    // Everything else this person had proposed is moot once one is right.
    {
      sql: `UPDATE email_candidates
               SET status = 'rejected', decided_by = ?, decided_at = ?, updated_at = ?
             WHERE workspace_id = ? AND person_id = ? AND id <> ? AND status = 'proposed'`,
      args: [input.actorId, stamp, stamp, input.workspaceId, input.personId, candidate.id],
    },
    {
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
            profile_url, confidence, source_type, verified_by, first_seen_at, last_verified_at)
            VALUES (?, ?, 'email', ?, ?, NULL, 0.95, 'human', '["human"]', ?, ?)`,
      args: [identityId, input.personId, address, address, stamp, stamp],
    },
  ]);

  return { confirmed: true, identityId };
}

/** Records that an address is wrong, so it is never proposed again. */
export async function rejectCandidate(db: Client, input: DecisionInput): Promise<boolean> {
  const stamp = now();

  const result = await db.execute({
    sql: `UPDATE email_candidates
             SET status = 'rejected', decided_by = ?, decided_at = ?, updated_at = ?
           WHERE workspace_id = ? AND person_id = ? AND address = ? AND status = 'proposed'`,
    args: [
      input.actorId,
      stamp,
      stamp,
      input.workspaceId,
      input.personId,
      input.address.trim().toLowerCase(),
    ],
  });

  return Number(result.rowsAffected ?? 0) > 0;
}
