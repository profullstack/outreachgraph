/**
 * The discovery-to-queue pipeline (PRD §8).
 *
 * Walks one prospect from a bare handle to a card in the approval queue:
 *
 *   enrich → resolve identities → collect signals → score → recommend
 *
 * Each stage persists before the next runs, so a crash resumes from the last
 * completed stage rather than restarting the whole chain — and so a partially
 * enriched prospect is still inspectable in the UI.
 */

import { newId, type Network, type SignalType } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { resolveIdentity, type EvidenceInput } from '@outreachgraph/identity';
import {
  deriveEvidence,
  extractSignals,
  findIdentities,
  GitHubProvider,
  GitHubRateLimitError,
  type ExtractedSignal,
  type PersonCandidate,
  type PersonEnrichmentProvider,
  type ProviderCapabilities,
} from '@outreachgraph/providers';
import { generateRecommendation, type CandidateSignal } from '@outreachgraph/recommend';
import { draftForRecommendation, type TextModel } from '@outreachgraph/ai';
import { rescoreProspect } from './jobs';
import { recordDiscovered, recordStatus } from './stages';

export interface PipelineOptions {
  readonly db: Client;
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly providers: readonly PersonEnrichmentProvider[];
  /** Supplies GitHub activity. Omit to skip signal collection. */
  readonly github?: GitHubProvider;
  /**
   * Writes the message. Omit to run the pipeline with no LLM at all — the
   * recommendation still reaches the queue, just without a draft.
   */
  readonly model?: TextModel;
  /**
   * Whether this deployment can actually put an email on the wire.
   *
   * `email/send_email` is `customer_managed` in the capability matrix, and
   * that mode requires a connected account — otherwise the policy engine
   * correctly returns `manual_only`, because a channel nothing can send
   * through is a channel the human has to use themselves. The sending domain
   * *is* that account, so the flag is true when a mailer is configured.
   */
  readonly emailSendingEnabled?: boolean;
  readonly now?: Date;
}

export interface PipelineResult {
  readonly personId?: string;
  readonly stage: 'enriched' | 'resolved' | 'researched' | 'scored' | 'recommended' | 'stopped';
  readonly identitiesLinked: number;
  readonly signalsStored: number;
  readonly recommendationId?: string;
  readonly draftId?: string;
  readonly stoppedBecause?: string;
}

/**
 * Runs the full chain for one GitHub handle.
 *
 * GitHub-first was the launch wedge: it is free and its profiles carry
 * self-declared cross-links (PRD §45). It is now one way in among others —
 * this resolves a handle to a candidate and hands over to the shared chain.
 */
export async function runPipeline(
  options: PipelineOptions,
  handle: string,
): Promise<PipelineResult> {
  const github = options.github ?? new GitHubProvider();
  const enrichment = await github.enrich({ handles: { github: handle } });

  if (!enrichment.candidate) {
    return {
      stage: 'stopped',
      identitiesLinked: 0,
      signalsStored: 0,
      stoppedBecause: `no GitHub profile for ${handle}`,
    };
  }

  return runPipelineForCandidate(options, enrichment.candidate, {
    capabilities: github.capabilities(),
    // The GitHub account this run started from is the anchor: it is the person,
    // not an inference about them, so it links without a confidence test.
    anchorNetwork: 'github',
    githubHandle: handle,
  });
}

export interface CandidateOrigin {
  /** Whose data this is, for provenance and evidence weighting. */
  readonly capabilities: ProviderCapabilities;
  /** A network whose identity *is* the person, rather than a match for them. */
  readonly anchorNetwork?: Network;
  /** Enables the GitHub research stage when the candidate has a handle. */
  readonly githubHandle?: string;
  /**
   * The page this candidate was read off, when there was one.
   *
   * Turned into a stored signal, which is what lets a person found on a
   * company site reach an outbound recommendation at all — see
   * `storeSiteSignal`.
   */
  readonly sourceUrl?: string;
}

/**
 * The chain, from a candidate onwards.
 *
 * This is the part that does not care where the person came from. A GitHub
 * handle, a name lifted off a company homepage and an enrichment vendor's
 * record all arrive here as the same normalised candidate, and everything after
 * this point — suppression, resolution, research, scoring, recommendation,
 * drafting — is identical for all three.
 */
export async function runPipelineForCandidate(
  options: PipelineOptions,
  candidate: PersonCandidate,
  origin: CandidateOrigin,
): Promise<PipelineResult> {
  const { db, workspaceId, campaignId } = options;
  const stamp = now();

  const personId = await upsertPerson(db, candidate, stamp);

  await recordProvenance(db, personId, candidate, origin, stamp);
  await ensureCampaignMembership(db, campaignId, personId, workspaceId, stamp);

  // Suppression outranks everything: a suppressed person is never researched
  // or scored, only recorded as excluded (PRD §6.6, §17.3).
  if (await isSuppressed(db, workspaceId, personId)) {
    await setStatus(db, campaignId, personId, 'suppressed', 'matched a suppression key');
    return {
      personId,
      stage: 'stopped',
      identitiesLinked: 0,
      signalsStored: 0,
      stoppedBecause: 'suppressed',
    };
  }

  // -------------------------------------------------------------- resolve
  //
  // Ask the other configured providers what else they can vouch for before
  // resolving. Nothing is merged here — the fan-out gathers claims and the
  // resolver below decides which of them are the same person.
  const fanned =
    options.providers.length > 0 ? await findIdentities(candidate, options.providers) : undefined;

  const enriched = fanned?.candidate ?? candidate;

  // The page they were named on is itself an identity for them.
  //
  // Recorded *before* resolution so it counts toward identity confidence.
  // Without it a person read off a company site ends the run at confidence 0 —
  // the aggregate of no identities at all — and the policy engine then denies
  // every outbound action, correctly, on the grounds that we cannot say who
  // they are. That is the last thing standing between the URL and keyword
  // paths and any outreach whatsoever: 82 real people, fully researched and
  // scored, all permanently uncontactable.
  //
  // A company naming its own staff on its own site is first-party evidence,
  // and it is not a merge — nothing is being matched to anything. It says only
  // "this named person is presented here as part of this company", which is
  // exactly the claim any message to them would rest on.
  if (origin.sourceUrl) await storeSiteIdentity(db, personId, enriched, origin, stamp);

  const linked = await linkIdentities(db, personId, enriched, origin, stamp);

  // An address published beside this person's own name on their employer's
  // site. Stored as an identity rather than a column so it inherits deletion,
  // suppression and provenance from the machinery that already handles every
  // other way of reaching someone.
  if (enriched.email) await storeEmailIdentity(db, personId, enriched.email, origin, stamp);

  await setStatus(db, campaignId, personId, 'resolved');

  // ------------------------------------------------------------- research
  //
  // Only GitHub produces signals today, so a candidate with no GitHub identity
  // reaches the queue with evidence but no activity. That is a real limitation
  // rather than a bug: the card still carries the prospect and its source, and
  // the composer refuses to invent a reason it cannot ground.
  const researchHandle =
    origin.githubHandle ??
    candidate.identities.find((identity) => identity.network === 'github')?.handle;

  let stored = 0;

  // The page itself is evidence.
  //
  // This closes the gap that made the URL path produce nothing: the
  // recommendation engine refuses to propose an outbound action with no
  // trigger signal behind it, and only GitHub ever produced signals. So
  // everyone found by crawling a company site — which is now the main way in —
  // reached "scored" and stopped, with the honest-looking reason "no permitted
  // action" and no indication that the real problem was having nothing to say.
  //
  // A published team page stating someone's role is a genuine, citable,
  // grounded fact about them, which is exactly what the composer needs and all
  // it is allowed to use. It is not a buying signal and is not scored like
  // one — its relevance is deliberately middling — but it is enough to open a
  // message that is about them rather than about nobody.
  stored += await storeSiteSignal(db, workspaceId, personId, enriched, origin, stamp);

  if (researchHandle) {
    const github = options.github ?? new GitHubProvider();
    try {
      const activity = await github.activity(researchHandle);
      const context = await extractionContext(db, campaignId);
      const extracted = extractSignals(activity.events, activity.repos, context);
      stored += await storeSignals(db, workspaceId, personId, extracted, stamp);
      await setStatus(db, campaignId, personId, 'researching');
    } catch (error) {
      // A quota wall is not a prospect failure — keep what we have and let the
      // next tick resume research.
      if (!(error instanceof GitHubRateLimitError)) throw error;
    }
  }

  // ---------------------------------------------------------------- score
  await rescoreProspect(db, campaignId, personId);
  await setStatus(db, campaignId, personId, 'qualified');

  // ------------------------------------------------------------ recommend
  const recommendationId = await createRecommendation(db, options, personId);

  if (!recommendationId) {
    return {
      personId,
      stage: 'scored',
      identitiesLinked: linked,
      signalsStored: stored,
      stoppedBecause: 'no permitted action',
    };
  }

  // ---------------------------------------------------------------- draft
  // A failed or absent draft is not a pipeline failure. The card still shows
  // the prospect, the evidence and the recommended action; the reviewer
  // writes the message. That beats showing a fabricated one.
  let draftId: string | undefined;
  if (options.model) {
    const draft = await draftForRecommendation(db, options.model, recommendationId);
    if (draft.ok) draftId = draft.draftId;
    else console.log(`no draft for ${recommendationId}: ${draft.reason}`);
  }

  await setStatus(db, campaignId, personId, 'awaiting_approval');

  return {
    personId,
    stage: 'recommended',
    identitiesLinked: linked,
    signalsStored: stored,
    recommendationId,
    ...(draftId ? { draftId } : {}),
  };
}

/**
 * Stores "their own site says this is their role" as a signal.
 *
 * Confidence is high — the company published it about its own staff — while
 * relevance is deliberately mid. It is a fact worth citing, not evidence that
 * anyone is in the market for anything, and scoring it as intent would put
 * every receptionist on a team page at the top of the queue.
 *
 * Deduped on the source URL like every other signal, so re-crawling a site on
 * a later tick does not accumulate one of these per run.
 */
async function storeSiteSignal(
  db: Client,
  workspaceId: string,
  personId: string,
  candidate: PersonCandidate,
  origin: CandidateOrigin,
  stamp: string,
): Promise<number> {
  if (!origin.sourceUrl || !candidate.title) return 0;

  const existing = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM signals WHERE workspace_id = ? AND person_id = ? AND source_url = ?
        AND signal_type = 'content_topic' AND subtype = 'site_role'`,
    [workspaceId, personId, origin.sourceUrl],
  );
  if (existing) return 0;

  const where = candidate.companyName ? ` at ${candidate.companyName}` : '';
  const summary = `Listed as ${candidate.title}${where} on the company website.`;
  const evidence = `${candidate.fullName} — ${candidate.title}`;

  await db.execute({
    sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, subtype,
          summary, evidence, source_url, source_timestamp, observed_at, confidence,
          relevance, sentiment)
          VALUES (?, ?, ?, 'website', 'content_topic', 'site_role', ?, ?, ?, ?, ?, 0.9, 0.5,
                  'neutral')`,
    args: [
      newId('signal'),
      workspaceId,
      personId,
      summary,
      evidence,
      origin.sourceUrl,
      stamp,
      stamp,
    ],
  });

  return 1;
}

/**
 * Records "named on this company's own site" as a website identity.
 *
 * Confidence is 0.9: high, because the employer published it about their own
 * staff, and short of certain, because a page can be stale and a name can be
 * shared. That clears the default 0.85 outreach threshold while still sitting
 * below the 1.0 an anchor identity gets, and a workspace that wants a stricter
 * bar can raise `min_outreach_confidence` and exclude these outright.
 *
 * `platform_user_id` is domain-plus-name rather than the URL, so re-crawling a
 * deeper page on the same site recognises the same person instead of creating
 * a second identity for them.
 */
async function storeSiteIdentity(
  db: Client,
  personId: string,
  candidate: PersonCandidate,
  origin: CandidateOrigin,
  stamp: string,
): Promise<void> {
  if (!origin.sourceUrl) return;

  const host = (() => {
    try {
      return new URL(origin.sourceUrl).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return undefined;
    }
  })();

  if (!host) return;

  const slug = candidate.fullName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (!slug) return;

  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
          profile_url, confidence, source_type, verified_by, first_seen_at, last_verified_at)
          VALUES (?, ?, 'website', ?, ?, ?, 0.9, ?, '["named_on_company_site"]', ?, ?)
          ON CONFLICT(network, platform_user_id) WHERE platform_user_id IS NOT NULL
          DO UPDATE SET last_verified_at = excluded.last_verified_at`,
    args: [
      newId('socialIdentity'),
      personId,
      candidate.fullName,
      `${host}:${slug}`,
      origin.sourceUrl,
      origin.capabilities.sourceType,
      stamp,
      stamp,
    ],
  });
}

/**
 * Records a personal email address as an identity on this person.
 *
 * `platform_user_id` is the address itself, which makes the existing unique
 * index on `(network, platform_user_id)` do real work: two people resolved
 * from two pages cannot both end up owning `jane@acme.com`, so nobody is ever
 * written to twice under two names.
 *
 * Confidence is high but not certain. The address was published next to this
 * person's name on their own employer's site, which is strong evidence and
 * still not proof — shared initials and a departed employee's forwarded
 * mailbox both produce the same page.
 */
async function storeEmailIdentity(
  db: Client,
  personId: string,
  email: string,
  origin: CandidateOrigin,
  stamp: string,
): Promise<void> {
  const address = email.trim().toLowerCase();
  if (!address.includes('@')) return;

  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
          profile_url, confidence, source_type, verified_by, first_seen_at, last_verified_at)
          VALUES (?, ?, 'email', ?, ?, ?, 0.88, ?, '["published_on_company_site"]', ?, ?)
          ON CONFLICT(network, platform_user_id) DO UPDATE
            SET last_verified_at = excluded.last_verified_at`,
    args: [
      newId('socialIdentity'),
      personId,
      address,
      address,
      `mailto:${address}`,
      origin.capabilities.sourceType,
      stamp,
      stamp,
    ],
  });
}

/** Matches on the stable platform id, never the renameable handle. */
async function upsertPerson(
  db: Client,
  candidate: PersonCandidate,
  stamp: string,
): Promise<string> {
  // Match on the stable platform id wherever the provider supplied one — it
  // survives a rename and is the strongest key available.
  for (const identity of candidate.identities) {
    if (!identity.platformUserId) continue;
    const byId = await queryOne<{ person_id: string }>(
      db,
      'SELECT person_id FROM social_identities WHERE network = ? AND platform_user_id = ?',
      [identity.network, identity.platformUserId],
    );
    if (byId) return byId.person_id;
  }

  // Then by handle. A crawl never has a platform id — a company page gives
  // `github.com/alexchen`, not GitHub's numeric id — so without this every
  // re-crawl of the same site created a second copy of everyone on it.
  //
  // The trade is real and is taken deliberately: handles are renameable, so a
  // freed-and-reused handle could match the wrong person. But that only
  // compares against handles already linked to a person *with evidence*, and
  // the alternative is guaranteed duplicates on every crawl, which corrupts
  // the queue rather than merely risking it.
  for (const identity of candidate.identities) {
    if (!identity.handle) continue;
    const byHandle = await queryOne<{ person_id: string }>(
      db,
      `SELECT person_id FROM social_identities
        WHERE network = ? AND handle = ? COLLATE NOCASE`,
      [identity.network, identity.handle],
    );
    if (byHandle) return byHandle.person_id;
  }

  const companyId = candidate.companyName ? await upsertCompany(db, candidate, stamp) : undefined;

  const personId = newId('person');
  await db.execute({
    sql: `INSERT INTO people (id, display_name, first_name, last_name, current_company_id,
          current_title, location, identity_confidence, status, outreach_eligible,
          believed_minor, created_at, updated_at, last_resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', 1, 0, ?, ?, ?)`,
    args: [
      personId,
      candidate.fullName,
      candidate.firstName ?? null,
      candidate.lastName ?? null,
      companyId ?? null,
      candidate.title ?? null,
      candidate.location ?? null,
      stamp,
      stamp,
      stamp,
    ],
  });

  return personId;
}

async function upsertCompany(
  db: Client,
  candidate: PersonCandidate,
  stamp: string,
): Promise<string> {
  if (candidate.companyDomain) {
    const existing = await queryOne<{ id: string }>(
      db,
      'SELECT id FROM companies WHERE domain = ?',
      [candidate.companyDomain],
    );
    if (existing) return existing.id;
  }

  const id = newId('company');
  await db.execute({
    sql: `INSERT INTO companies (id, name, domain, employee_count, industry, technologies,
          created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
    args: [
      id,
      candidate.companyName ?? 'Unknown',
      candidate.companyDomain ?? null,
      candidate.employeeCount ?? null,
      candidate.industry ?? null,
      stamp,
      stamp,
    ],
  });
  return id;
}

/**
 * Scores each discovered identity and stores only those clearing the
 * workspace's auto-merge threshold. Anything in the candidate band becomes a
 * review row instead of a silent link (PRD §9.4).
 */
async function linkIdentities(
  db: Client,
  personId: string,
  candidate: PersonCandidate,
  origin: CandidateOrigin,
  stamp: string,
): Promise<number> {
  const workspace = await queryOne<{ auto_merge_threshold: number; candidate_threshold: number }>(
    db,
    `SELECT w.auto_merge_threshold, w.candidate_threshold FROM workspaces w LIMIT 1`,
  );

  const thresholds = {
    autoMerge: workspace?.auto_merge_threshold ?? 0.9,
    candidate: workspace?.candidate_threshold ?? 0.7,
  };

  // Handles the page or provider *declared* for this person — a `sameAs` entry,
  // a `rel="me"`, an account returned on their own profile record. These are
  // what make a cross-link, rather than an inference.
  //
  // Identities read off layout are deliberately absent. Every entry here is
  // also weighed against this list, so being in it means an identity
  // corroborates itself at full strength. That is the right answer for a link
  // the site stated — the statement is the evidence — and the wrong one for a
  // link we merely found near a name, which would otherwise auto-merge on the
  // strength of our own guess. "Identity precision beats recall" is exactly
  // this distinction.
  const declared = candidate.identities
    .filter((i) => !i.inferred)
    .map((i) => i.handle)
    .filter((h): h is string => typeof h === 'string');

  let linked = 0;

  for (const identity of candidate.identities) {
    const evidence: EvidenceInput[] = deriveEvidence({
      identity,
      candidate,
      capabilities: origin.capabilities,
      crossLinkedHandles: declared,
      ...(candidate.companyName ? { platformEmployer: candidate.companyName } : {}),
    });

    // The anchor identity *is* the person the run started from, not an
    // inference about them, so it links without a confidence test. A crawl has
    // no anchor: every identity on a company page is a claim to be resolved.
    const resolution =
      origin.anchorNetwork && identity.network === origin.anchorNetwork
        ? { decision: 'merge' as const, score: 1, verifiedBy: ['provider_asserted_link'] }
        : resolveIdentity(evidence, { thresholds });

    if (resolution.decision === 'merge') {
      await db.execute({
        sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
              profile_url, confidence, source_type, verified_by, first_seen_at, last_verified_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              -- The uniqueness index is partial, so the conflict target has to
              -- repeat its WHERE clause or SQLite refuses to match it.
              ON CONFLICT(network, platform_user_id) WHERE platform_user_id IS NOT NULL
              DO NOTHING`,
        args: [
          newId('socialIdentity'),
          personId,
          identity.network,
          identity.handle ?? null,
          identity.platformUserId ?? null,
          identity.profileUrl ?? null,
          resolution.score,
          origin.capabilities.sourceType,
          JSON.stringify(resolution.verifiedBy),
          stamp,
          stamp,
        ],
      });
      linked += 1;
    } else if (resolution.decision === 'candidate') {
      await db.execute({
        sql: `INSERT INTO identity_candidates (id, workspace_id, person_id, network, handle,
              platform_user_id, profile_url, score, status, created_at)
              VALUES (?, (SELECT id FROM workspaces LIMIT 1), ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        args: [
          newId('identityCandidate'),
          personId,
          identity.network,
          identity.handle ?? null,
          identity.platformUserId ?? null,
          identity.profileUrl ?? null,
          resolution.score,
          stamp,
        ],
      });
    }
  }

  // The person is only as trustworthy as their weakest confirmed link.
  const scores = await queryAll<{ confidence: number }>(
    db,
    'SELECT confidence FROM social_identities WHERE person_id = ?',
    [personId],
  );

  const aggregate = scores.length === 0 ? 0 : Math.min(...scores.map((s) => s.confidence));

  await db.execute({
    sql: 'UPDATE people SET identity_confidence = ?, last_resolved_at = ? WHERE id = ?',
    args: [aggregate, stamp, personId],
  });

  return linked;
}

async function storeSignals(
  db: Client,
  workspaceId: string,
  personId: string,
  extracted: readonly ExtractedSignal[],
  stamp: string,
): Promise<number> {
  let stored = 0;

  for (const signal of extracted) {
    // The source URL is the natural dedupe key: re-running research must not
    // duplicate the same public event.
    if (signal.sourceUrl) {
      const existing = await queryOne<{ id: string }>(
        db,
        'SELECT id FROM signals WHERE workspace_id = ? AND person_id = ? AND source_url = ? AND signal_type = ?',
        [workspaceId, personId, signal.sourceUrl, signal.type],
      );
      if (existing) continue;
    }

    await db.execute({
      sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, subtype,
            summary, evidence, source_url, source_timestamp, observed_at, confidence,
            relevance, sentiment)
            VALUES (?, ?, ?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('signal'),
        workspaceId,
        personId,
        signal.type,
        signal.subtype ?? null,
        signal.summary,
        signal.evidence ?? null,
        signal.sourceUrl ?? null,
        signal.sourceTimestamp,
        stamp,
        signal.confidence,
        signal.relevance,
        signal.sentiment,
      ],
    });
    stored += 1;
  }

  return stored;
}

async function createRecommendation(
  db: Client,
  options: PipelineOptions,
  personId: string,
): Promise<string | undefined> {
  const { db: _db, workspaceId, campaignId } = options;
  void _db;

  const person = await queryOne<{
    identity_confidence: number;
    status: string;
    believed_minor: number;
  }>(db, 'SELECT identity_confidence, status, believed_minor FROM people WHERE id = ?', [personId]);
  if (!person) return undefined;

  const campaign = await queryOne<{ approval_mode: string; budget_json: string }>(
    db,
    'SELECT approval_mode, budget_json FROM campaigns WHERE id = ?',
    [campaignId],
  );
  if (!campaign) return undefined;

  const workspace = await queryOne<{ min_outreach_confidence: number }>(
    db,
    'SELECT min_outreach_confidence FROM workspaces WHERE id = ?',
    [workspaceId],
  );

  const signalRows = await queryAll<{
    id: string;
    network: string;
    signal_type: string;
    summary: string;
    evidence: string | null;
    source_url: string | null;
    source_timestamp: string | null;
    observed_at: string;
    confidence: number;
    relevance: number;
    expires_at: string | null;
  }>(
    db,
    `SELECT id, network, signal_type, summary, evidence, source_url, source_timestamp,
            observed_at, confidence, relevance, expires_at
       FROM signals WHERE workspace_id = ? AND person_id = ?`,
    [workspaceId, personId],
  );

  const signals: CandidateSignal[] = signalRows.map((row) => ({
    id: row.id,
    network: row.network as Network,
    type: row.signal_type as SignalType,
    summary: row.summary,
    ...(row.evidence ? { evidence: row.evidence } : {}),
    ...(row.source_url ? { sourceUrl: row.source_url } : {}),
    ...(row.source_timestamp ? { sourceTimestamp: row.source_timestamp } : {}),
    observedAt: row.observed_at,
    confidence: row.confidence,
    relevance: row.relevance,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  }));

  const identities = await queryAll<{ network: string }>(
    db,
    'SELECT DISTINCT network FROM social_identities WHERE person_id = ?',
    [personId],
  );

  const reachable = identities.map((identity) => identity.network as Network);

  // Their employer's published inbox counts as a way to reach them.
  //
  // Without this the whole keyword path dead-ends. `reachableNetworks` was
  // built purely from a person's own identities, so `email` was only ever
  // reachable for someone whose *personal* address appeared on the page — and
  // small-business sites, which is what "dental practices in Austin" returns,
  // almost never publish those. They name their staff and publish one shared
  // `info@`. Every one of those leads reached "Researched" and stopped, with
  // no permitted action and nothing to explain why.
  //
  // The address is real, published, and reaches the named person in practice,
  // so it is honest to call the network reachable. What it is not is private:
  // the send records `toSharedInbox`, so nothing downstream can mistake a
  // shared mailbox for the individual.
  if (!reachable.includes('email')) {
    const inbox = await queryOne<{ contact_email: string }>(
      db,
      `SELECT co.contact_email
         FROM people p
         JOIN companies co ON co.id = p.current_company_id
        WHERE p.id = ? AND co.contact_email IS NOT NULL`,
      [personId],
    );

    if (inbox?.contact_email) reachable.push('email');
  }

  const score = await queryOne<{ opportunity: number }>(
    db,
    'SELECT opportunity FROM scores WHERE campaign_id = ? AND person_id = ?',
    [campaignId, personId],
  );

  const budget = safeJson(campaign.budget_json);
  const counts = await actionCounts(db, workspaceId, personId);
  const flags = await featureFlags(db, workspaceId);
  const connected = await connectedNetworks(db, workspaceId);

  const result = generateRecommendation({
    personId,
    campaignId,
    signals,
    reachableNetworks: reachable,
    opportunity: score?.opportunity ?? 0,
    ...(options.now ? { now: options.now } : {}),
    policy: {
      approvalMode: campaign.approval_mode as 'draft_and_approve',
      // Resolved per-network below by the engine's own policy calls; this is
      // the workspace-wide answer for the common case.
      hasConnectedAccount: connected.size > 0 || options.emailSendingEnabled === true,
      personSuppressed: person.status === 'suppressed',
      personBelievedMinor: person.believed_minor === 1,
      personDeleted: person.status === 'deleted',
      identityConfidence: person.identity_confidence,
      minIdentityConfidence: workspace?.min_outreach_confidence ?? 0.85,
      actionsToday: counts.today,
      maxActionsPerDay: numberOr(budget.maxActionsPerDay, 50),
      actionsToThisProspectThisWeek: counts.thisProspect,
      maxActionsPerProspectPerWeek: numberOr(budget.maxActionsPerProspectPerWeek, 1),
      featureFlags: flags,
    },
  });

  if (!result.ok) return undefined;

  const recommendation = result.recommendation;
  const id = newId('recommendation');

  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
          priority, reason, trigger_signal_id, policy_status, policy_version, expected_goal,
          status, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    args: [
      id,
      workspaceId,
      campaignId,
      personId,
      recommendation.action,
      recommendation.network,
      recommendation.priority,
      recommendation.reason,
      recommendation.triggerSignalId ?? null,
      recommendation.policyDecision,
      recommendation.policyVersion,
      recommendation.expectedGoal,
      now(),
      recommendation.expiresAt ?? null,
    ],
  });

  return id;
}

async function recordProvenance(
  db: Client,
  personId: string,
  candidate: PersonCandidate,
  origin: CandidateOrigin,
  stamp: string,
): Promise<void> {
  const fields: [string, string | undefined][] = [
    ['fullName', candidate.fullName],
    ['companyName', candidate.companyName],
    ['location', candidate.location],
    ['personalDomain', candidate.personalDomain],
  ];

  for (const [field, value] of fields) {
    if (!value) continue;
    await db.execute({
      // Attribution follows the provider that actually supplied the value.
      // Hardcoding GitHub's here was harmless while GitHub was the only source;
      // with a crawl in the mix it would label a scraped name as an API fact
      // and mis-classify what may be retained and exported (PRD §35).
      sql: `INSERT INTO field_provenance (id, entity_kind, entity_id, field, value, source_type,
            provider, source_record_id, license_class, confidence, observed_at, created_at)
            VALUES (?, 'person', ?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?)`,
      args: [
        newId('fieldProvenance'),
        personId,
        field,
        value,
        origin.capabilities.sourceType,
        origin.capabilities.slug,
        candidate.sourceRecordId ?? null,
        origin.capabilities.licenseClass,
        candidate.observedAt,
        stamp,
      ],
    });
  }
}

async function ensureCampaignMembership(
  db: Client,
  campaignId: string,
  personId: string,
  workspaceId: string,
  stamp: string,
): Promise<void> {
  const result = await db.execute({
    sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status,
          interaction_state, discovered_at, updated_at)
          VALUES (?, ?, ?, 'discovered', 'never_contacted', ?, ?)
          ON CONFLICT(campaign_id, person_id) DO NOTHING`,
    args: [campaignId, personId, workspaceId, stamp, stamp],
  });

  // Only when the insert actually inserted. Re-crawling a site returns the
  // same people, and stamping them all back to the top of the funnel every
  // time would make the chart a record of how often the crawler ran.
  if (result.rowsAffected > 0) {
    await recordDiscovered(db, { workspaceId, campaignId, personId, at: stamp });
  }
}

/**
 * Moves a lead and records the move.
 *
 * The workspace is looked up rather than threaded through every call site
 * because the stage event needs it and `campaign_people` already knows it —
 * changing five signatures to carry a value the row holds would be noise.
 */
async function setStatus(
  db: Client,
  campaignId: string,
  personId: string,
  status: string,
  reason?: string,
): Promise<void> {
  const membership = await queryOne<{ workspace_id: string }>(
    db,
    `SELECT workspace_id FROM campaign_people WHERE campaign_id = ? AND person_id = ?`,
    [campaignId, personId],
  );

  if (!membership) return;

  await recordStatus(db, {
    workspaceId: membership.workspace_id,
    campaignId,
    personId,
    status,
    ...(reason ? { reason } : {}),
  });
}

async function isSuppressed(db: Client, workspaceId: string, personId: string): Promise<boolean> {
  const identities = await queryAll<{ network: string; platform_user_id: string | null }>(
    db,
    'SELECT network, platform_user_id FROM social_identities WHERE person_id = ?',
    [personId],
  );

  const keys = [`person:${personId}`];
  for (const identity of identities) {
    if (identity.platform_user_id) {
      keys.push(`platform:${identity.network}:${identity.platform_user_id}`);
    }
  }

  const placeholders = keys.map(() => '?').join(', ');
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM suppression_keys
      WHERE match_key IN (${placeholders}) AND (scope = 'global' OR workspace_id = ?)`,
    [...keys, workspaceId],
  );

  return Number(row?.n ?? 0) > 0;
}

async function extractionContext(db: Client, campaignId: string) {
  const filters = await queryOne<{ technologies: string; keywords: string }>(
    db,
    'SELECT technologies, keywords FROM campaign_filters WHERE campaign_id = ?',
    [campaignId],
  );

  const offering = await queryOne<{ competitors: string }>(
    db,
    `SELECT o.competitors FROM offerings o
       JOIN campaigns c ON c.offering_id = o.id WHERE c.id = ?`,
    [campaignId],
  );

  return {
    technologies: parseArray(filters?.technologies),
    keywords: parseArray(filters?.keywords),
    competitors: parseArray(offering?.competitors),
  };
}

async function actionCounts(db: Client, workspaceId: string, personId: string) {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const today = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM actions WHERE workspace_id = ? AND created_at >= ?`,
    [workspaceId, dayAgo],
  );
  const week = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM actions WHERE workspace_id = ? AND person_id = ? AND created_at >= ?`,
    [workspaceId, personId, weekAgo],
  );

  return { today: Number(today?.n ?? 0), thisProspect: Number(week?.n ?? 0) };
}

async function featureFlags(db: Client, workspaceId: string): Promise<Record<string, boolean>> {
  const rows = await queryAll<{ key: string; enabled: number }>(
    db,
    'SELECT key, enabled FROM feature_flags WHERE workspace_id IS NULL OR workspace_id = ?',
    [workspaceId],
  );

  const flags: Record<string, boolean> = {};
  for (const row of rows) flags[row.key] = row.enabled === 1;
  return flags;
}

async function connectedNetworks(db: Client, workspaceId: string): Promise<Set<string>> {
  const rows = await queryAll<{ network: string }>(
    db,
    `SELECT DISTINCT network FROM integration_accounts WHERE workspace_id = ? AND status = 'active'`,
    [workspaceId],
  );
  return new Set(rows.map((r) => r.network));
}

function parseArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
