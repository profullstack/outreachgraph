/**
 * Job posts: a list of postings, and the people behind each one.
 *
 * The flow is three steps, each usable on its own:
 *
 *   1. **Collect.** Paste posting URLs, or search the job boards by keyword
 *      ("senior software engineer (remote)") through ValueSERP. Either way a
 *      posting is one row per canonical URL.
 *   2. **Resolve.** Read the posting from the board's public API, then search
 *      LinkedIn through ValueSERP for the company's founders, engineering
 *      leaders and recruiters. A result is kept only when it names the company
 *      as itself (`linkedInContactFrom`), and the search result is stored as
 *      the evidence. An address the company published on its own site is
 *      attached to the person whose name it is.
 *   3. **Promote.** Put a contact into a campaign through `intakeSocialPeople`,
 *      the path every other stranger takes, so the policy engine and human
 *      approval apply unchanged. Nothing here sends.
 */

import {
  addressBelongsTo,
  companyDomainFrom,
  contactSearchQuery,
  emailDedupeKey,
  isAgencyPosting,
  isJobPostStatus,
  jobSearchQueries,
  linkedInContactFrom,
  namedOnPage,
  namesCompany,
  newId,
  parseJobUrl,
  rankContact,
  JOB_BOARDS,
  MAX_SEARCH_RESULTS,
  type JobBoard,
  type JobPostStatus,
  type JobSource,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  readJobPosting,
  readCompanySite,
  type JobPosting,
  type JobReaderOptions,
  type WebSearcher,
} from '@outreachgraph/providers';
import { enqueue } from './queue';
import { enqueueFindEmail } from './find-email-queue';
import { intakeSocialPeople } from './social-intake';

export interface JobPostContact {
  readonly id: string;
  readonly name: string;
  readonly network: string;
  readonly handle: string;
  readonly profileUrl: string;
  readonly headline?: string | undefined;
  readonly snippet?: string | undefined;
  readonly role: string;
  readonly score: number;
  readonly email?: string | undefined;
  readonly emailSource?: string | undefined;
  /** The company's own site names them. */
  readonly onCompanySite: boolean;
  readonly personId?: string | undefined;
}

export interface JobPost {
  readonly id: string;
  readonly workspaceId: string;
  readonly campaignId?: string | undefined;
  readonly url: string;
  readonly source: JobSource;
  readonly title?: string | undefined;
  readonly company?: string | undefined;
  readonly companyDomain?: string | undefined;
  readonly location?: string | undefined;
  readonly remote?: boolean | undefined;
  readonly salary?: string | undefined;
  readonly postedAt?: string | undefined;
  readonly description?: string | undefined;
  readonly agency: boolean;
  readonly publishedEmails: readonly string[];
  readonly keyword?: string | undefined;
  readonly status: JobPostStatus;
  readonly notes?: string | undefined;
  readonly lastError?: string | undefined;
  readonly resolvedAt?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contacts: readonly JobPostContact[];
}

interface PostRow {
  id: string;
  workspace_id: string;
  campaign_id: string | null;
  url: string;
  source: string;
  account: string | null;
  board_job_id: string | null;
  title: string | null;
  company: string | null;
  company_domain: string | null;
  location: string | null;
  remote: number | null;
  salary: string | null;
  posted_at: string | null;
  description: string | null;
  agency: number;
  published_emails_json: string;
  keyword: string | null;
  status: string;
  notes: string | null;
  last_error: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ContactRow {
  id: string;
  job_post_id: string;
  name: string;
  network: string;
  handle: string;
  profile_url: string;
  headline: string | null;
  snippet: string | null;
  role: string;
  score: number;
  email: string | null;
  email_source: string | null;
  on_company_site?: number | null;
  person_id: string | null;
}

const SELECT_POST = `SELECT id, workspace_id, campaign_id, url, source, account, board_job_id, title,
                            company, company_domain, location, remote, salary, posted_at,
                            description, agency, published_emails_json, keyword, status, notes,
                            last_error, resolved_at, created_at, updated_at
                       FROM job_posts`;

const SELECT_CONTACT = `SELECT id, job_post_id, name, network, handle, profile_url, headline, snippet,
                               role, score, email, email_source, on_company_site, person_id
                          FROM job_post_contacts`;

function contactFrom(row: ContactRow): JobPostContact {
  return {
    id: row.id,
    name: row.name,
    network: row.network,
    handle: row.handle,
    profileUrl: row.profile_url,
    ...(row.headline ? { headline: row.headline } : {}),
    ...(row.snippet ? { snippet: row.snippet } : {}),
    role: row.role,
    score: Number(row.score),
    ...(row.email ? { email: row.email } : {}),
    ...(row.email_source ? { emailSource: row.email_source } : {}),
    onCompanySite: Number(row.on_company_site ?? 0) === 1,
    ...(row.person_id ? { personId: row.person_id } : {}),
  };
}

function postFrom(row: PostRow, contacts: readonly JobPostContact[]): JobPost {
  let publishedEmails: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.published_emails_json);
    if (Array.isArray(parsed)) publishedEmails = parsed.map(String);
  } catch {
    // A hand-edited column must not break the list.
  }
  const source = (['workable', 'greenhouse', 'lever', 'ashby'] as const).find(
    (s) => s === row.source,
  );
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.campaign_id ? { campaignId: row.campaign_id } : {}),
    url: row.url,
    source: source ?? 'other',
    ...(row.title ? { title: row.title } : {}),
    ...(row.company ? { company: row.company } : {}),
    ...(row.company_domain ? { companyDomain: row.company_domain } : {}),
    ...(row.location ? { location: row.location } : {}),
    ...(row.remote === null ? {} : { remote: Number(row.remote) === 1 }),
    ...(row.salary ? { salary: row.salary } : {}),
    ...(row.posted_at ? { postedAt: row.posted_at } : {}),
    ...(row.description ? { description: row.description } : {}),
    agency: Number(row.agency) === 1,
    publishedEmails,
    ...(row.keyword ? { keyword: row.keyword } : {}),
    status: isJobPostStatus(row.status) ? row.status : 'new',
    ...(row.notes ? { notes: row.notes } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contacts,
  };
}

async function contactsFor(
  db: Client,
  postIds: readonly string[],
): Promise<Map<string, JobPostContact[]>> {
  const byPost = new Map<string, JobPostContact[]>();
  if (postIds.length === 0) return byPost;
  const rows = await queryAll<ContactRow>(
    db,
    `${SELECT_CONTACT} WHERE job_post_id IN (${postIds.map(() => '?').join(', ')})
      ORDER BY score DESC, name`,
    [...postIds],
  );
  for (const row of rows) {
    const list = byPost.get(row.job_post_id) ?? [];
    list.push(contactFrom(row));
    byPost.set(row.job_post_id, list);
  }
  return byPost;
}

// ------------------------------------------------------------------- storage

export interface ListJobPostsOptions {
  readonly status?: JobPostStatus | undefined;
  readonly campaignId?: string | undefined;
  readonly limit?: number | undefined;
}

export async function listJobPosts(
  db: Client,
  workspaceId: string,
  options: ListJobPostsOptions = {},
): Promise<JobPost[]> {
  const where = ['workspace_id = ?'];
  const args: (string | number)[] = [workspaceId];
  if (options.status) {
    where.push('status = ?');
    args.push(options.status);
  }
  if (options.campaignId) {
    where.push('campaign_id = ?');
    args.push(options.campaignId);
  }
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const rows = await queryAll<PostRow>(
    db,
    `${SELECT_POST} WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`,
    args,
  );
  const contacts = await contactsFor(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => postFrom(row, contacts.get(row.id) ?? []));
}

export async function getJobPost(
  db: Client,
  workspaceId: string,
  id: string,
): Promise<JobPost | undefined> {
  const row = await queryOne<PostRow>(db, `${SELECT_POST} WHERE workspace_id = ? AND id = ?`, [
    workspaceId,
    id,
  ]);
  if (!row) return undefined;
  const contacts = await contactsFor(db, [row.id]);
  return postFrom(row, contacts.get(row.id) ?? []);
}

export interface SaveJobPostsInput {
  readonly workspaceId: string;
  readonly urls: readonly string[];
  readonly campaignId?: string | undefined;
  /** The search that found them; omitted when a human pasted them. */
  readonly keyword?: string | undefined;
  /** What the search result said, so a row has a title before it is read. */
  readonly hints?: ReadonlyMap<string, { title?: string | undefined }>;
}

export interface SaveJobPostsResult {
  readonly saved: readonly JobPost[];
  /** Already in the list: the existing row is left as it is. */
  readonly duplicates: readonly string[];
  readonly rejected: readonly { url: string; reason: string }[];
}

/**
 * Add postings to the list, and queue each new one to be resolved.
 *
 * A URL already in the list is a duplicate, not an error: a paste of fifty
 * with one repeat must save forty-nine.
 */
export async function saveJobPosts(
  db: Client,
  input: SaveJobPostsInput,
): Promise<SaveJobPostsResult> {
  const saved: JobPost[] = [];
  const duplicates: string[] = [];
  const rejected: { url: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const raw of input.urls) {
    const parsed = parseJobUrl(String(raw ?? ''));
    if ('reason' in parsed) {
      rejected.push({ url: String(raw), reason: parsed.reason });
      continue;
    }
    if (seen.has(parsed.url)) continue;
    seen.add(parsed.url);

    const existing = await queryOne<{ id: string }>(
      db,
      'SELECT id FROM job_posts WHERE workspace_id = ? AND url = ?',
      [input.workspaceId, parsed.url],
    );
    if (existing) {
      duplicates.push(parsed.url);
      continue;
    }

    const id = newId('jobPost');
    const stamp = now();
    const title = input.hints?.get(raw)?.title?.trim() || null;
    await db.execute({
      sql: `INSERT INTO job_posts (id, workspace_id, campaign_id, url, source, account, board_job_id,
                                   title, keyword, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
            ON CONFLICT (workspace_id, url) DO NOTHING`,
      args: [
        id,
        input.workspaceId,
        input.campaignId ?? null,
        parsed.url,
        parsed.source,
        parsed.account ?? null,
        parsed.jobId ?? null,
        title,
        input.keyword ?? null,
        stamp,
        stamp,
      ],
    });
    await enqueueResolve(db, input.workspaceId, id);

    const post = await getJobPost(db, input.workspaceId, id);
    if (post) saved.push(post);
    else duplicates.push(parsed.url);
  }

  return { saved, duplicates, rejected };
}

/** Queue one posting to be read and searched. Idempotent per posting. */
export async function enqueueResolve(
  db: Client,
  workspaceId: string,
  jobPostId: string,
): Promise<boolean> {
  const result = await enqueue(db, {
    workspaceId,
    kind: 'resolve_job_post',
    payload: { jobPostId },
    dedupeKey: `resolve_job_post:${jobPostId}`,
    maxAttempts: 3,
  });
  return result.queued;
}

export interface UpdateJobPostInput {
  readonly status?: JobPostStatus | undefined;
  readonly notes?: string | null | undefined;
  readonly campaignId?: string | null | undefined;
}

export async function updateJobPost(
  db: Client,
  workspaceId: string,
  id: string,
  input: UpdateJobPostInput,
): Promise<JobPost | undefined> {
  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (input.status !== undefined) {
    sets.push('status = ?');
    args.push(input.status);
  }
  if (input.notes !== undefined) {
    sets.push('notes = ?');
    args.push(input.notes?.trim() ? input.notes.trim() : null);
  }
  if (input.campaignId !== undefined) {
    sets.push('campaign_id = ?');
    args.push(input.campaignId);
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    args.push(now());
    await db.execute({
      sql: `UPDATE job_posts SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`,
      args: [...args, workspaceId, id],
    });
  }
  return getJobPost(db, workspaceId, id);
}

export async function deleteJobPost(db: Client, workspaceId: string, id: string): Promise<boolean> {
  // Contacts go with the posting; a person already promoted stays a person,
  // because they are in a campaign now and owe nothing to this row.
  await db.execute({
    sql: 'DELETE FROM job_post_contacts WHERE workspace_id = ? AND job_post_id = ?',
    args: [workspaceId, id],
  });
  const result = await db.execute({
    sql: 'DELETE FROM job_posts WHERE workspace_id = ? AND id = ?',
    args: [workspaceId, id],
  });
  return Number(result.rowsAffected ?? 0) > 0;
}

// -------------------------------------------------------------------- search

export interface SearchJobPostsInput {
  readonly workspaceId: string;
  readonly keyword: string;
  readonly boards?: readonly JobBoard[] | undefined;
  readonly campaignId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface SearchJobPostsResult extends SaveJobPostsResult {
  readonly queries: readonly string[];
  /** Results that were postings at all, before de-duplication. */
  readonly found: number;
}

/**
 * Search the job boards by keyword and add what comes back to the list.
 *
 * One query per board (see `jobSearchQueries`). A result that is not a
 * posting — a company's job list, a search page — is dropped silently: it is
 * Google being Google, not something the operator typed wrong.
 */
export async function searchJobPosts(
  deps: { readonly db: Client; readonly searcher: WebSearcher },
  input: SearchJobPostsInput,
): Promise<SearchJobPostsResult> {
  const boards = input.boards && input.boards.length > 0 ? input.boards : JOB_BOARDS;
  const queries = jobSearchQueries(input.keyword, boards);
  if (queries.length === 0) throw new Error('enter a keyword to search for');
  const limit = Math.min(Math.max(input.limit ?? 20, 1), MAX_SEARCH_RESULTS);

  const pages = await Promise.all(queries.map(({ q }) => deps.searcher.search(q, { num: 20 })));

  // Interleave the boards so a limit of ten is not ten Workable postings.
  const urls: string[] = [];
  const hints = new Map<string, { title?: string | undefined }>();
  let found = 0;
  for (let i = 0; i < 20; i += 1) {
    for (const page of pages) {
      const result = page[i];
      if (!result?.link) continue;
      const parsed = parseJobUrl(result.link);
      if ('reason' in parsed || parsed.source === 'other') continue;
      found += 1;
      if (urls.length >= limit || hints.has(result.link)) continue;
      urls.push(result.link);
      hints.set(result.link, { title: result.title?.split(/\s+[-|@]\s+/)[0] });
    }
  }

  const saved = await saveJobPosts(deps.db, {
    workspaceId: input.workspaceId,
    urls,
    keyword: input.keyword.trim(),
    hints,
    ...(input.campaignId ? { campaignId: input.campaignId } : {}),
  });

  return { ...saved, queries: queries.map(({ q }) => q), found };
}

// ------------------------------------------------------------------- resolve

export interface ResolveJobPostDeps {
  readonly db: Client;
  /** Without one, the posting is read but nobody is searched for. */
  readonly searcher?: WebSearcher | undefined;
  readonly reader?: JobReaderOptions | undefined;
}

export interface ResolveJobPostResult {
  readonly post: JobPost;
  readonly contacts: number;
  readonly promoted?: string | undefined;
}

/** A contact must reach this to be promoted into the posting's campaign unasked. */
export const AUTO_PROMOTE_SCORE = 0.6;
/** Contacts kept per posting: the best few, not every recruiter who ever worked there. */
const MAX_CONTACTS = 8;

/**
 * Read one posting and find the people behind it.
 *
 * Throws only for what a retry could fix (a board timing out, the search API
 * refusing). A posting that names nobody findable completes as `no_contact`.
 */
export async function resolveJobPost(
  deps: ResolveJobPostDeps,
  workspaceId: string,
  jobPostId: string,
): Promise<ResolveJobPostResult> {
  const { db } = deps;
  const post = await getJobPost(db, workspaceId, jobPostId);
  if (!post) throw new Error(`job post ${jobPostId} not found`);

  const parsed = parseJobUrl(post.url);
  if ('reason' in parsed) throw new Error(`stored url no longer parses: ${parsed.reason}`);

  let posting: JobPosting;
  try {
    posting = await readJobPosting(parsed, deps.reader);
  } catch (error) {
    await fail(db, post, error);
    throw error;
  }

  const company = posting.company?.trim() || post.company;
  let domain = posting.companyDomain ?? post.companyDomain;
  const agency = isAgencyPosting(`${posting.description ?? ''}`);
  const stamp = now();

  if (!domain && company && deps.searcher) {
    domain = await findCompanyDomain(deps.searcher, company);
  }

  const site = domain ? await readCompanySite(domain, deps.reader) : undefined;
  const publishedEmails = site?.emails ?? [];
  const siteText = site?.text ?? '';

  await db.execute({
    sql: `UPDATE job_posts
             SET url = ?, title = COALESCE(?, title), company = COALESCE(?, company),
                 company_domain = COALESCE(?, company_domain), location = ?, remote = ?,
                 salary = ?, posted_at = ?, description = ?, agency = ?,
                 published_emails_json = ?, last_error = NULL, updated_at = ?
           WHERE id = ?`,
    args: [
      posting.canonicalUrl ?? post.url,
      posting.title ?? null,
      company ?? null,
      domain ?? null,
      posting.location ?? null,
      posting.remote === undefined ? null : posting.remote ? 1 : 0,
      posting.salary ?? null,
      posting.postedAt ?? null,
      posting.description ?? null,
      agency ? 1 : 0,
      JSON.stringify(publishedEmails),
      stamp,
      post.id,
    ],
  });

  let kept = 0;
  if (company && deps.searcher) {
    let results;
    try {
      results = await deps.searcher.search(contactSearchQuery(company), { num: 20 });
    } catch (error) {
      await fail(db, post, error);
      throw error;
    }

    const found = results
      .map((result) => linkedInContactFrom(result, company))
      .filter((contact): contact is NonNullable<typeof contact> => contact !== undefined)
      .map((contact) => ({
        ...contact,
        ...rankContact(contact.headline, contact.snippet, agency),
        email: publishedEmails.find((address) => addressBelongsTo(address, contact.name)),
        onCompanySite: siteText ? namedOnPage(siteText, contact.name) : false,
      }));

    // Once the company's site names anybody, it is the roster: a search
    // result it does not name may be a namesake company ("Founded Raydar as a
    // full-service music…"), so it sinks below everyone the site vouches for.
    const siteNamesAnyone = found.some((contact) => contact.onCompanySite);
    const contacts = found
      .map((contact) => {
        let score = contact.score;
        // The company publishing someone's address is the company naming its
        // point of contact, which a headline never says as plainly ("David
        // Phillips - Raydar" never mentions founding it).
        if (contact.email) score = Math.max(score, 0.9);
        if (contact.onCompanySite) score = Math.max(score, 0.85);
        // Only someone whose own headline does not claim the company: "CTO at
        // Brigit" off a homepage that names only the founder is still the
        // CTO, while "Music Executive" with Raydar in the snippet is not.
        else if (siteNamesAnyone && !namesCompany(contact.headline, company)) score = score * 0.6;
        return { ...contact, score: Math.round(score * 100) / 100 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CONTACTS);

    const seen = new Set<string>();
    for (const contact of contacts) {
      if (seen.has(contact.handle)) continue;
      seen.add(contact.handle);
      await db.execute({
        sql: `INSERT INTO job_post_contacts (id, job_post_id, workspace_id, name, network, handle,
                                             profile_url, headline, snippet, role, score, email,
                                             email_source, on_company_site, created_at)
              VALUES (?, ?, ?, ?, 'linkedin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (job_post_id, network, handle) DO UPDATE
                 SET name = excluded.name, headline = excluded.headline,
                     snippet = excluded.snippet, role = excluded.role, score = excluded.score,
                     on_company_site = excluded.on_company_site,
                     email = COALESCE(excluded.email, job_post_contacts.email),
                     email_source = COALESCE(excluded.email_source, job_post_contacts.email_source)`,
        args: [
          newId('jobPostContact'),
          post.id,
          workspaceId,
          contact.name,
          contact.handle,
          contact.profileUrl,
          contact.headline || null,
          contact.snippet || null,
          contact.role,
          contact.score,
          contact.email ?? null,
          contact.email ? 'company_site' : null,
          contact.onCompanySite ? 1 : 0,
          stamp,
        ],
      });
      kept += 1;
    }
  }

  const total = await queryOne<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM job_post_contacts WHERE job_post_id = ?',
    [post.id],
  );
  const found = Number(total?.n ?? 0) > 0;
  // The operator's own statuses are theirs; only the machine's get replaced.
  const status = ['new', 'contact_found', 'no_contact', 'failed'].includes(post.status)
    ? found
      ? 'contact_found'
      : 'no_contact'
    : post.status;
  await db.execute({
    sql: `UPDATE job_posts SET status = ?, resolved_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    args: [
      status,
      stamp,
      deps.searcher ? null : 'no VALUESERP_API_KEY: the posting was read, nobody was searched for',
      stamp,
      post.id,
    ],
  });

  let promoted: string | undefined;
  const fresh = await getJobPost(db, workspaceId, post.id);
  if (!fresh) throw new Error(`job post ${post.id} vanished while resolving`);

  const best = fresh.contacts[0];
  if (fresh.campaignId && best && best.score >= AUTO_PROMOTE_SCORE && !best.personId) {
    promoted = (await promoteJobPostContact(db, workspaceId, best.id, fresh.campaignId)).personId;
  }

  const final = promoted ? await getJobPost(db, workspaceId, post.id) : fresh;
  return { post: final ?? fresh, contacts: kept, ...(promoted ? { promoted } : {}) };
}

async function fail(db: Client, post: JobPost, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.execute({
    sql: `UPDATE job_posts SET status = CASE WHEN status IN ('new', 'failed') THEN 'failed' ELSE status END,
                 last_error = ?, updated_at = ? WHERE id = ?`,
    args: [message.slice(0, 500), now(), post.id],
  });
}

/**
 * The company's own site, by search, when the board did not say.
 *
 * Only a result whose host carries a word of the company's name is accepted:
 * the first result for "Close" is not necessarily close.com, but a host that
 * does not even contain the name is certainly not theirs.
 */
export async function findCompanyDomain(
  searcher: WebSearcher,
  company: string,
): Promise<string | undefined> {
  const words = company
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
  if (words.length === 0) return undefined;

  let results;
  try {
    results = await searcher.search(`"${company.replace(/"/g, '')}" official site`, { num: 10 });
  } catch {
    return undefined;
  }
  for (const result of results) {
    const domain = companyDomainFrom(result.link);
    if (!domain) continue;
    const stem = domain
      .split('.')
      .slice(0, -1)
      .join('')
      .replace(/[^a-z0-9]/g, '');
    if (words.some((word) => stem.includes(word)) || stem === words.join('')) return domain;
  }
  return undefined;
}

// ------------------------------------------------------------------- promote

export interface PromoteResult {
  readonly personId: string;
  readonly created: boolean;
  /** True when an address the company published was attached. */
  readonly email: boolean;
  /** True when no address was known and a `find_email` search was queued. */
  readonly findEmailQueued: boolean;
}

/**
 * Put one contact into a campaign.
 *
 * Through `intakeSocialPeople`, exactly as a social client hand-off arrives,
 * so a LinkedIn handle stays a handle: identity confidence, the policy engine
 * and human approval decide what happens next. What this adds is the two
 * facts the posting gave us — who employs them, and any address the company
 * published under their name — so `find_email` has a domain to work with.
 */
export async function promoteJobPostContact(
  db: Client,
  workspaceId: string,
  contactId: string,
  campaignId: string,
): Promise<PromoteResult> {
  const contact = await queryOne<
    ContactRow & { company: string | null; company_domain: string | null }
  >(
    db,
    `SELECT c.id, c.job_post_id, c.name, c.network, c.handle, c.profile_url, c.headline,
            c.snippet, c.role, c.score, c.email, c.email_source, c.person_id,
            p.company, p.company_domain
       FROM job_post_contacts c JOIN job_posts p ON p.id = c.job_post_id
      WHERE c.workspace_id = ? AND c.id = ?`,
    [workspaceId, contactId],
  );
  if (!contact) throw new Error('contact not found');

  const intake = await intakeSocialPeople(
    { db },
    {
      workspaceId,
      campaignId,
      source: 'job_post',
      people: [
        {
          network: contact.network,
          handle: contact.handle,
          profileUrl: contact.profile_url,
          displayName: contact.name,
          bio: [contact.headline, contact.snippet].filter(Boolean).join(' · ') || undefined,
          via: 'job_post',
        },
      ],
    },
  );
  const person = intake.people[0];
  if (!person) {
    throw new Error(`could not add ${contact.name}: ${intake.rejected[0]?.reason ?? 'rejected'}`);
  }

  const stamp = now();
  const domain = companyDomainFrom(contact.company_domain ?? undefined);
  if (domain) {
    let company = await queryOne<{ id: string }>(db, 'SELECT id FROM companies WHERE domain = ?', [
      domain,
    ]);
    if (!company) {
      company = { id: newId('company') };
      await db.execute({
        sql: `INSERT INTO companies (id, name, domain, technologies, created_at, updated_at)
              VALUES (?, ?, ?, '[]', ?, ?)`,
        args: [company.id, contact.company ?? domain, domain, stamp, stamp],
      });
    }
    await db.execute({
      sql: `UPDATE people SET current_company_id = COALESCE(current_company_id, ?), updated_at = ?
             WHERE id = ?`,
      args: [company.id, stamp, person.id],
    });
  }

  let email = false;
  if (contact.email) {
    // The company published it on its own site, beside the person's name.
    const result = await db.execute({
      sql: `INSERT INTO person_emails (id, workspace_id, person_id, address, dedupe_key, source,
                                       verified, created_at)
            VALUES (?, ?, ?, ?, ?, 'site', 0, ?)
            ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`,
      args: [
        newId('personEmail'),
        workspaceId,
        person.id,
        contact.email,
        emailDedupeKey(contact.email),
        stamp,
      ],
    });
    email = Number(result.rowsAffected ?? 0) > 0;
  }

  const findEmailQueued =
    !contact.email && domain
      ? await enqueueFindEmail(db, { workspaceId, personId: person.id })
      : false;

  await db.execute({
    sql: 'UPDATE job_post_contacts SET person_id = ? WHERE id = ?',
    args: [person.id, contact.id],
  });
  await db.execute({
    sql: `UPDATE job_posts SET campaign_id = COALESCE(campaign_id, ?), updated_at = ? WHERE id = ?`,
    args: [campaignId, stamp, contact.job_post_id],
  });

  return { personId: person.id, created: person.created, email, findEmailQueued };
}
