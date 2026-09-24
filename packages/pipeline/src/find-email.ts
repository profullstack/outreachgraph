/**
 * The `find_email` job: a sendable address for someone we can only reach by
 * hand.
 *
 * About ninety people in production are reachable on LinkedIn and nowhere
 * else. Every LinkedIn action is `manual_only`, so each of them holds a card a
 * human has to carry out in another tab — and the point of importing a list is
 * that nobody has to. This works out where to email them instead.
 *
 * The routes already ruled out stay ruled out (see `enrich.ts`): crawling
 * deeper finds only role mailboxes, and commit metadata is off the table. What
 * is left, and what this does:
 *
 *   1. **Their employer's domain** — the company we hold them against, a
 *      current employment row, a domain a provider attributed to them, or the
 *      company named on their profile when exactly one company we know by that
 *      name has a domain. The first that is a real company domain wins.
 *   2. **The domain's pattern**, learned from any address already known at it
 *      — imported, published on the site, or confirmed by a human. That is the
 *      strongest evidence there is. Without one, the common shapes.
 *   3. **The mail servers' opinion.** MX is required. An SMTP RCPT probe runs
 *      when the host allows port 25, which cloud hosts mostly do not; a domain
 *      that accepts a made-up recipient is catch-all and its yes is worth less.
 *
 * Every candidate is recorded in `email_candidates` with its evidence. The best
 * is promoted to `person_emails` — the table the sender reads — only above a
 * confidence floor a bare guess cannot reach: it takes a mailbox the server
 * confirmed, or a pattern learned from a real colleague's address. Promotion
 * is recorded as `decided_by = 'find_email'`, never as a human.
 *
 * After a promotion the person is re-decided at once, so the LinkedIn card is
 * replaced by an email one on the same tick.
 */

import {
  emailDedupeKey,
  isLikelyRoleAccount,
  newId,
  splitPersonName,
  webPresenceFor,
  type SplitName,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  candidateAddresses,
  inferPatterns,
  verifyDomainCandidates,
  type AddressCandidate,
  type DomainVerification,
  type EmailPattern,
  type MxRecord,
  type SmtpProber,
} from '@outreachgraph/providers';
import { markEmailSearched } from './find-email-queue';
import { regenerateFor } from './pipeline';
import { domainMatchKey, emailMatchKey, matchKeysForPerson } from './suppression-keys';

/**
 * The floor for writing an address the sender will use unattended.
 *
 * Chosen against the scores below rather than in the abstract: a bare guess
 * tops out at 0.35, so no amount of MX can lift one over it. A server-confirmed
 * mailbox (0.95) clears it, and so does a single pattern learned from a real
 * colleague's address even when nobody could be asked (0.9 × 0.9) or the domain
 * accepts everything (0.9 × 0.85) — a catch-all does not bounce, so the risk
 * there is reaching nobody, not burning the sending domain.
 */
export const PROMOTE_THRESHOLD = 0.75;

/** A mailbox the server said exists, on a domain that refuses made-up ones. */
const VERIFIED_CONFIDENCE = 0.95;
/** Discount when the server could not be asked at all. */
const UNPROBED_FACTOR = 0.9;
/** Discount when the server says yes to everyone. */
const CATCH_ALL_FACTOR = 0.85;

/**
 * Addresses probed per person. The derived ones come first, so this only ever
 * trims guesses — and each RCPT is one more question a server may count
 * against us.
 */
const MAX_PROBED = 6;

export interface FindEmailDeps {
  readonly db: Client;
  /** Injected so tests never touch DNS. Defaults to `node:dns`. */
  readonly resolveMx?: (domain: string) => Promise<readonly MxRecord[]>;
  /** Omit to verify by MX alone, e.g. where port 25 is known to be blocked. */
  readonly smtp?: SmtpProber;
  /** Passed through to the re-decision, as for every other chain entry. */
  readonly emailSendingEnabled?: boolean;
  readonly threshold?: number;
}

export type FindEmailOutcome =
  | 'promoted'
  | 'below_threshold'
  | 'no_mx'
  | 'no_domain'
  | 'no_name'
  | 'suppressed'
  | 'already_reachable'
  | 'ineligible';

export interface FindEmailResult {
  readonly personId: string;
  readonly outcome: FindEmailOutcome;
  readonly domain?: string;
  readonly address?: string;
  readonly confidence?: number;
  readonly candidates: number;
  /** How the mail servers were asked: probed, unavailable (and why), skipped. */
  readonly smtp?: string;
  /** New cards written by the re-decision after a promotion. */
  readonly recommendationIds: readonly string[];
}

interface PersonRow {
  readonly id: string;
  readonly display_name: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly current_company_id: string | null;
  readonly status: string;
  readonly kind: string;
  readonly outreach_eligible: number;
}

/**
 * Runs one search. Throws only for a transient DNS failure, so the queue
 * retries it; every other miss is an answer and completes the job.
 */
export async function findEmail(
  deps: FindEmailDeps,
  input: { readonly workspaceId: string; readonly personId: string },
): Promise<FindEmailResult> {
  const { db } = deps;
  const { workspaceId, personId } = input;
  const base = { personId, candidates: 0, recommendationIds: [] as string[] };

  const person = await queryOne<PersonRow>(
    db,
    `SELECT id, display_name, first_name, last_name, current_company_id, status, kind,
            outreach_eligible
       FROM people WHERE id = ?`,
    [personId],
  );

  if (
    !person ||
    person.status !== 'active' ||
    person.kind !== 'person' ||
    person.outreach_eligible !== 1
  ) {
    return { ...base, outcome: 'ineligible' };
  }

  // Stamped before any network work, so a job that dies half way is still not
  // re-queued by the sweep every tick. The job's own retries ignore the stamp.
  await markEmailSearched(db, personId);

  if (await hasPersonalEmail(db, personId)) return { ...base, outcome: 'already_reachable' };

  // A name is half the address. `webmaster` has none, and neither does anything
  // else the role-account rule catches — the same rule the pipeline applies
  // before a crawl result can become a person at all.
  if (isLikelyRoleAccount(person.display_name)) return { ...base, outcome: 'no_name' };
  const name = nameOf(person);
  if (!name) return { ...base, outcome: 'no_name' };

  const domain = await employerDomain(db, person);
  if (!domain) return { ...base, outcome: 'no_domain' };

  // Suppression outranks everything, as in the pipeline: a person, their
  // company's domain, or (below) the specific address can each be on a list.
  const personKeys = await matchKeysForPerson(db, personId);
  if (await anySuppressed(db, workspaceId, [...personKeys, domainMatchKey(domain)])) {
    return { ...base, outcome: 'suppressed', domain };
  }

  const learned = await learnDomainPatterns(db, workspaceId, domain, personId);
  const proposals = candidateAddresses(name, domain, learned.patterns)
    .filter((candidate) => !looksLikeRoleMailbox(candidate.address))
    .slice(0, MAX_PROBED);

  if (proposals.length === 0) return { ...base, outcome: 'no_name', domain };

  const verification = await verifyDomainCandidates(
    domain,
    proposals.map((candidate) => candidate.address),
    {
      ...(deps.resolveMx ? { resolveMx: deps.resolveMx } : {}),
      ...(deps.smtp ? { smtp: deps.smtp } : {}),
    },
  );

  const smtp =
    verification.smtp === 'unavailable'
      ? `unavailable (${verification.smtpReason ?? 'unknown'})`
      : verification.smtp;

  // No mail exchanger means every address here bounces. Nothing is recorded:
  // a page of zero-confidence proposals for a domain that takes no mail would
  // only be noise in the review queue.
  if (verification.mx.length === 0) {
    return { ...base, outcome: 'no_mx', domain, smtp };
  }

  // Addresses already turned down — by a human, or by the server on an earlier
  // run — or that belong to somebody else in this workspace, are recorded as
  // evidence but never promoted.
  const decided = await decidedAddresses(db, workspaceId, personId);
  const companyInbox = await companyInboxFor(db, person.current_company_id);

  let best: { candidate: AddressCandidate; confidence: number; verified: boolean } | undefined;

  for (const candidate of proposals) {
    const verdict = verification.verdicts.get(candidate.address) ?? 'unknown';
    const confidence = scoreCandidate(candidate, verdict, verification);

    await recordCandidate(db, {
      workspaceId,
      personId,
      candidate,
      confidence,
      basis: describeBasis(candidate, domain, learned.from, verdict, verification),
      evidence: evidenceFor(verification, candidate.address, learned.from),
      rejectedByServer: verdict === 'rejected',
    });

    if (verdict === 'rejected') continue;
    if (decided.rejected.has(candidate.address)) continue;
    if (candidate.address === companyInbox) continue;
    if (await heldByAnotherPerson(db, workspaceId, personId, candidate.address)) continue;
    if (await anySuppressed(db, workspaceId, [emailMatchKey(candidate.address)])) continue;

    if (!best || confidence > best.confidence) {
      best = { candidate, confidence, verified: verdict === 'accepted' };
    }
  }

  const threshold = deps.threshold ?? PROMOTE_THRESHOLD;

  if (!best || best.confidence < threshold) {
    return {
      ...base,
      outcome: 'below_threshold',
      domain,
      smtp,
      candidates: proposals.length,
      ...(best ? { address: best.candidate.address, confidence: best.confidence } : {}),
    };
  }

  await promote(db, {
    workspaceId,
    personId,
    address: best.candidate.address,
    verified: best.verified,
  });

  const recommendationIds = await redecide(deps, workspaceId, personId);

  return {
    personId,
    outcome: 'promoted',
    domain,
    smtp,
    address: best.candidate.address,
    confidence: best.confidence,
    candidates: proposals.length,
    recommendationIds,
  };
}

/**
 * One number per candidate, from what the pattern and the server each said.
 *
 * The server's word wins when it can be trusted: a strict domain accepting the
 * mailbox is as good as it gets without a reply, and refusing it is final. In
 * every other case the pattern's own confidence stands, discounted for the
 * question we could not ask or the answer we cannot believe.
 */
export function scoreCandidate(
  candidate: AddressCandidate,
  verdict: 'accepted' | 'rejected' | 'unknown',
  verification: Pick<DomainVerification, 'smtp' | 'catchAll'>,
): number {
  if (verdict === 'rejected') return 0;
  if (verdict === 'accepted') return VERIFIED_CONFIDENCE;
  const factor = verification.catchAll === true ? CATCH_ALL_FACTOR : UNPROBED_FACTOR;
  return round(candidate.confidence * factor);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Prefers the stored parts when they exist, and falls back to the display name. */
function nameOf(person: PersonRow): SplitName | undefined {
  if (person.first_name?.trim()) {
    return {
      firstName: person.first_name.trim(),
      ...(person.last_name?.trim() ? { lastName: person.last_name.trim() } : {}),
    };
  }
  return splitPersonName(person.display_name);
}

/**
 * A local part that reads as a mailbox for a function rather than a person.
 *
 * Belt and braces: the name already passed the role-account rule, but the
 * `last` shape of someone surnamed "Sales" would still produce `sales@`, which
 * is a shared inbox by any other name. Written as words so the rule sees
 * `Sales` rather than a lowercase login it would reject for being a login.
 */
function looksLikeRoleMailbox(address: string): boolean {
  const local = address.slice(0, address.indexOf('@'));
  const words = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.length === 0 || isLikelyRoleAccount(words.join(' '));
}

async function hasPersonalEmail(db: Client, personId: string): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT (SELECT count(*) FROM person_emails WHERE person_id = ?)
          + (SELECT count(*) FROM social_identities
              WHERE person_id = ? AND network = 'email'
                AND handle IS NOT NULL AND trim(handle) <> '') AS n`,
    [personId, personId],
  );
  return Number(row?.n ?? 0) > 0;
}

/** `https://www.Acme.com/about` → `acme.com`, or nothing for a non-company host. */
function companyDomain(value: string | null | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#:].*$/, '');
  if (!host.includes('.')) return undefined;
  // The same test the contact sweep uses to decide a domain is a company
  // rather than a mailbox provider or a publishing platform: guessing
  // `jane.doe@gmail.com` from a name would be a guess at a stranger's inbox.
  const presence = webPresenceFor(`probe@${host}`);
  return presence?.kind === 'company' ? host : undefined;
}

/**
 * Where this person works, as a mail domain.
 *
 * In order of how directly the fact is about them: the company we hold them
 * against; a current employment row; a domain a provider attributed to them
 * personally; and last, a company name some provider recorded for them, but
 * only when exactly one company we know by that name has a domain — two
 * "Acme"s is a coin toss, and a coin toss is not a domain.
 *
 * LinkedIn experience is not stored anywhere to read; what the profile said
 * reaches us only as that recorded company name.
 */
async function employerDomain(db: Client, person: PersonRow): Promise<string | undefined> {
  if (person.current_company_id) {
    const row = await queryOne<{ domain: string | null }>(
      db,
      'SELECT domain FROM companies WHERE id = ?',
      [person.current_company_id],
    );
    const domain = companyDomain(row?.domain);
    if (domain) return domain;
  }

  const employment = await queryAll<{ domain: string | null }>(
    db,
    `SELECT co.domain FROM person_employment pe
       JOIN companies co ON co.id = pe.company_id
      WHERE pe.person_id = ? AND co.domain IS NOT NULL
   ORDER BY pe.is_current DESC, pe.started_at DESC`,
    [person.id],
  );
  for (const row of employment) {
    const domain = companyDomain(row.domain);
    if (domain) return domain;
  }

  const personal = await queryAll<{ value: string }>(
    db,
    `SELECT value FROM field_provenance
      WHERE entity_kind = 'person' AND entity_id = ? AND field = 'personalDomain'
   ORDER BY observed_at DESC`,
    [person.id],
  );
  for (const row of personal) {
    const domain = companyDomain(row.value);
    if (domain) return domain;
  }

  const named = await queryAll<{ domain: string }>(
    db,
    `SELECT DISTINCT co.domain FROM field_provenance fp
       JOIN companies co ON lower(trim(co.name)) = lower(trim(fp.value))
      WHERE fp.entity_kind = 'person' AND fp.entity_id = ? AND fp.field = 'companyName'
        AND co.domain IS NOT NULL AND trim(co.domain) <> ''`,
    [person.id],
  );
  if (named.length === 1) return companyDomain(named[0]?.domain);

  return undefined;
}

/**
 * The address shapes this domain is known to use, and how many addresses said
 * so.
 *
 * Wider than `knownPatternsForDomain` in `enrich.ts`, which reads only human
 * confirmations: an imported address is one the person typed themselves, and
 * one published on the company site is the company's own word. Both are real
 * addresses at the domain, which is all the inference needs. What it must not
 * learn from is its own output — an unverified pattern promotion teaching the
 * next colleague would be one guess vouching for another.
 */
async function learnDomainPatterns(
  db: Client,
  workspaceId: string,
  domain: string,
  excludePersonId: string,
): Promise<{ patterns: readonly EmailPattern[]; from: number }> {
  const suffix = `%@${domain}`;

  const rows = await queryAll<{ address: string; display_name: string }>(
    db,
    `SELECT lower(trim(si.handle)) AS address, p.display_name
       FROM social_identities si
       JOIN people p ON p.id = si.person_id
      WHERE si.network = 'email' AND lower(trim(si.handle)) LIKE ?
        AND p.id <> ?
        AND EXISTS (SELECT 1 FROM campaign_people cp
                     WHERE cp.person_id = p.id AND cp.workspace_id = ?)
     UNION
     SELECT lower(trim(pe.address)) AS address, p.display_name
       FROM person_emails pe
       JOIN people p ON p.id = pe.person_id
      WHERE pe.workspace_id = ? AND lower(trim(pe.address)) LIKE ?
        AND p.id <> ?
        AND NOT (pe.source = 'pattern' AND pe.verified = 0)`,
    [suffix, excludePersonId, workspaceId, workspaceId, suffix, excludePersonId],
  );

  // Counted per pattern, so one odd address (an alias, a founder's vanity
  // mailbox) is outvoted by the shape most colleagues actually have.
  const votes = new Map<EmailPattern, number>();
  let from = 0;

  for (const row of rows) {
    const name = splitPersonName(row.display_name);
    if (!name) continue;
    const matched = inferPatterns(row.address, name, domain);
    if (matched.length === 0) continue;
    from += 1;
    for (const pattern of matched) votes.set(pattern, (votes.get(pattern) ?? 0) + 1);
  }

  if (votes.size === 0) return { patterns: [], from: 0 };

  const top = Math.max(...votes.values());
  const patterns = [...votes.entries()]
    .filter(([, count]) => count === top)
    .map(([pattern]) => pattern);

  return { patterns, from };
}

async function decidedAddresses(
  db: Client,
  workspaceId: string,
  personId: string,
): Promise<{ rejected: Set<string> }> {
  const rows = await queryAll<{ address: string }>(
    db,
    `SELECT address FROM email_candidates
      WHERE workspace_id = ? AND person_id = ? AND status = 'rejected'`,
    [workspaceId, personId],
  );
  return { rejected: new Set(rows.map((row) => row.address)) };
}

async function companyInboxFor(db: Client, companyId: string | null): Promise<string | undefined> {
  if (!companyId) return undefined;
  const row = await queryOne<{ contact_email: string | null }>(
    db,
    'SELECT contact_email FROM companies WHERE id = ?',
    [companyId],
  );
  return row?.contact_email?.trim().toLowerCase() || undefined;
}

/**
 * True when the address is already someone else's in this workspace.
 *
 * Two J. Smiths at one company both derive `jsmith@`. The one we already hold
 * it for is the one it belongs to, and `person_emails` would refuse the second
 * anyway — this just says so before trying.
 */
async function heldByAnotherPerson(
  db: Client,
  workspaceId: string,
  personId: string,
  address: string,
): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT (SELECT count(*) FROM person_emails
              WHERE workspace_id = ? AND dedupe_key = ? AND person_id <> ?)
          + (SELECT count(*) FROM social_identities
              WHERE network = 'email' AND lower(trim(handle)) = ? AND person_id <> ?) AS n`,
    [workspaceId, emailDedupeKey(address), personId, address, personId],
  );
  return Number(row?.n ?? 0) > 0;
}

async function anySuppressed(
  db: Client,
  workspaceId: string,
  keys: readonly string[],
): Promise<boolean> {
  if (keys.length === 0) return false;
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM suppression_keys
      WHERE match_key IN (${keys.map(() => '?').join(', ')})
        AND (scope = 'global' OR workspace_id = ?)`,
    [...keys, workspaceId],
  );
  return Number(row?.n ?? 0) > 0;
}

function describeBasis(
  candidate: AddressCandidate,
  domain: string,
  learnedFrom: number,
  verdict: 'accepted' | 'rejected' | 'unknown',
  verification: DomainVerification,
): string {
  const shape = candidate.derived
    ? `${domain} writes addresses as ${candidate.pattern}, learned from ${learnedFrom} ` +
      `known address${learnedFrom === 1 ? '' : 'es'} there.`
    : `No known address at ${domain}, so this is the common ${candidate.pattern} shape.`;

  const server =
    verdict === 'accepted'
      ? ' Its mail server confirmed the mailbox.'
      : verdict === 'rejected'
        ? ' Its mail server said the mailbox does not exist.'
        : verification.catchAll === true
          ? ' The domain accepts any recipient, so its mail server cannot confirm this one.'
          : verification.smtp === 'probed'
            ? ' Its mail server gave no clear answer.'
            : ' The domain takes mail; its server could not be asked about the mailbox.';

  return shape + server;
}

function evidenceFor(
  verification: DomainVerification,
  address: string,
  learnedFrom: number,
): string {
  return JSON.stringify({
    mx: verification.mx.slice(0, 3),
    smtp: verification.smtp,
    ...(verification.smtpReason ? { smtpReason: verification.smtpReason } : {}),
    ...(verification.catchAll === undefined ? {} : { catchAll: verification.catchAll }),
    ...(verification.codes.has(address) ? { rcpt: verification.codes.get(address) } : {}),
    learnedFrom,
    checkedAt: now(),
  });
}

/**
 * Writes one candidate, leaving any human decision alone.
 *
 * The same guard as `enrich.ts`: an undecided row is refreshed, a decided one
 * is not. A mailbox the server refused is recorded as rejected by this job, so
 * the review queue does not offer an address already known to bounce — and it
 * stays rejected on a later run that could not reach the server to ask again.
 */
async function recordCandidate(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly personId: string;
    readonly candidate: AddressCandidate;
    readonly confidence: number;
    readonly basis: string;
    readonly evidence: string;
    readonly rejectedByServer: boolean;
  },
): Promise<void> {
  const stamp = now();
  const status = input.rejectedByServer ? 'rejected' : 'proposed';

  await db.execute({
    sql: `INSERT INTO email_candidates (id, workspace_id, person_id, address, pattern,
          derived, confidence, status, basis, evidence_json, created_at, updated_at,
          decided_by, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, person_id, address) DO UPDATE
            SET pattern = excluded.pattern,
                derived = excluded.derived,
                confidence = excluded.confidence,
                basis = excluded.basis,
                evidence_json = excluded.evidence_json,
                status = excluded.status,
                decided_by = excluded.decided_by,
                decided_at = excluded.decided_at,
                updated_at = excluded.updated_at
          WHERE email_candidates.status = 'proposed'`,
    args: [
      newId('emailCandidate'),
      input.workspaceId,
      input.personId,
      input.candidate.address,
      input.candidate.pattern,
      input.candidate.derived ? 1 : 0,
      input.confidence,
      status,
      input.basis,
      input.evidence,
      stamp,
      stamp,
      input.rejectedByServer ? 'find_email' : null,
      input.rejectedByServer ? stamp : null,
    ],
  });
}

/**
 * Makes the address the one the sender uses.
 *
 * `person_emails` rather than `social_identities`: it is what the autopilot,
 * the approval send and the suppression keys all already read for imported
 * contacts, and `source = 'pattern'` keeps it distinguishable from an address
 * the person gave us. `verified` is 1 only when a mail server confirmed it.
 *
 * `ON CONFLICT DO NOTHING` because the unique index is the final word on whose
 * mailbox this is; losing a race to a colleague means it was theirs.
 */
async function promote(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly personId: string;
    readonly address: string;
    readonly verified: boolean;
  },
): Promise<void> {
  const stamp = now();

  await db.batch([
    {
      sql: `INSERT INTO person_emails (id, workspace_id, person_id, address, dedupe_key, source,
            verified, created_at)
            VALUES (?, ?, ?, ?, ?, 'pattern', ?, ?)
            ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`,
      args: [
        newId('personEmail'),
        input.workspaceId,
        input.personId,
        input.address,
        emailDedupeKey(input.address),
        input.verified ? 1 : 0,
        stamp,
      ],
    },
    {
      sql: `UPDATE email_candidates
               SET status = 'confirmed', decided_by = 'find_email', decided_at = ?, updated_at = ?
             WHERE workspace_id = ? AND person_id = ? AND address = ?
               AND status = 'proposed'`,
      args: [stamp, stamp, input.workspaceId, input.personId, input.address],
    },
  ]);
}

/**
 * Asks the engine again, now that the person has an address.
 *
 * Every campaign where they hold a card that could be improved on — a held
 * `manual_only` one, or an internal research card. `regenerateFor` supersedes
 * those itself and never touches a card that can already run.
 */
async function redecide(
  deps: FindEmailDeps,
  workspaceId: string,
  personId: string,
): Promise<string[]> {
  const campaigns = await queryAll<{ campaign_id: string }>(
    deps.db,
    `SELECT DISTINCT campaign_id FROM recommendations
      WHERE workspace_id = ? AND person_id = ? AND status = 'pending'
        AND (policy_status = 'manual_only' OR action IN ('refresh_research', 'observe', 'wait'))`,
    [workspaceId, personId],
  );

  const created: string[] = [];
  for (const { campaign_id: campaignId } of campaigns) {
    const id = await regenerateFor(
      {
        db: deps.db,
        workspaceId,
        campaignId,
        providers: [],
        ...(deps.emailSendingEnabled === undefined
          ? {}
          : { emailSendingEnabled: deps.emailSendingEnabled }),
      },
      personId,
    );
    if (id) created.push(id);
  }
  return created;
}
