/**
 * Turning a spreadsheet into people.
 *
 * Chunked rather than one call, because seventeen thousand rows is not a
 * request. The browser parses the file — it already has the bytes, and
 * uploading megabytes of CSV to be parsed server-side buys nothing — then
 * posts batches. Cleaning still happens *here*, on every row, because a client
 * that decides which rows are real is a client that can be told to lie.
 *
 * Re-running the same file is a merge, not a second copy. That is enforced by
 * the unique index on `person_emails(workspace_id, dedupe_key)` rather than by
 * this module checking first: a check-then-insert is a race, and the race is
 * reachable here because chunks arrive concurrently from the same upload.
 */

import {
  cleanContact,
  newId,
  type CleanContact,
  type RawContact,
  type RejectReason,
} from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';

/**
 * How sure we are that this mailbox belongs to this person.
 *
 * High, and deliberately so. The workspace's `min_outreach_confidence` is 0.85
 * and everything below it may be researched but never contacted — which is
 * correct for a name scraped off a page, and wrong for someone who typed their
 * own address into your own signup form. Importing an opted-in list at the
 * crawler's 0.35 would produce seventeen thousand prospects that the policy
 * engine refuses to contact, which is a worse outcome than not importing them.
 *
 * Not 1.0: the address was self-asserted and may be stale, and leaving a
 * little headroom means a bounce can lower it without special-casing.
 */
const IMPORTED_CONFIDENCE = 0.9;

export interface StartImportInput {
  readonly workspaceId: string;
  readonly campaignId?: string | undefined;
  readonly userId?: string | undefined;
  readonly filename?: string | undefined;
  readonly consentBasis?: string | undefined;
  readonly consentSource?: string | undefined;
}

export async function startContactImport(db: Client, input: StartImportInput): Promise<string> {
  const id = newId('contactImport');
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO contact_imports (id, workspace_id, campaign_id, created_by, filename,
          consent_basis, consent_source, consent_at, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    args: [
      id,
      input.workspaceId,
      input.campaignId ?? null,
      input.userId ?? null,
      input.filename ?? null,
      input.consentBasis ?? 'opt_in',
      input.consentSource ?? null,
      stamp,
      stamp,
      stamp,
    ],
  });

  return id;
}

export interface ChunkResult {
  readonly imported: number;
  readonly merged: number;
  /** Of the merged, how many people the row's newer data changed. */
  readonly updated: number;
  readonly rejected: number;
  readonly personIds: readonly string[];
}

/** True when an insert lost a race against the unique index. */
function isUniqueViolation(error: unknown): boolean {
  const message = String((error as { message?: string })?.message ?? error);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(message);
}

/**
 * Cleans and stores one batch.
 *
 * Rows are processed in order and independently: a row that throws is a
 * rejected row, never a failed chunk. Seventeen thousand records will contain
 * something nobody predicted, and losing the other four hundred and ninety
 * nine in the batch because of it is not an acceptable way to find out.
 */
export async function importContactChunk(
  db: Client,
  importId: string,
  rows: readonly RawContact[],
  options: { readonly startRow?: number } = {},
): Promise<ChunkResult> {
  const batch = await queryOne<{
    workspace_id: string;
    campaign_id: string | null;
    consent_basis: string;
    consent_source: string | null;
  }>(
    db,
    `SELECT workspace_id, campaign_id, consent_basis, consent_source
       FROM contact_imports WHERE id = ?`,
    [importId],
  );

  if (!batch) throw new Error(`no such import: ${importId}`);

  // ---------------------------------------------------------------- clean
  // Pure and local: no database, so five hundred rows cost nothing here.
  const seen = new Set<string>();
  const clean: { row: number; contact: CleanContact }[] = [];
  const rejects: { row: number; email?: string; reason: string; detail: string }[] = [];

  for (const [offset, raw] of rows.entries()) {
    const rowNumber = (options.startRow ?? 0) + offset + 1;
    const result = cleanContact(raw, seen);

    if (!result.ok) {
      rejects.push({
        row: rowNumber,
        ...(raw.email ? { email: raw.email } : {}),
        reason: result.reason,
        detail: result.detail,
      });
      continue;
    }

    seen.add(result.contact.dedupeKey);
    clean.push({ row: rowNumber, contact: result.contact });
  }

  // ------------------------------------------------------------- existing
  // One query for the whole chunk. This was a `SELECT` per row, which is
  // most of why importing seventeen thousand contacts took eighty-five
  // minutes: the work is trivial and the round trip is not.
  const existing = await existingByDedupeKey(
    db,
    batch.workspace_id,
    clean.map((entry) => entry.contact.dedupeKey),
  );

  const fresh = clean.filter((entry) => !existing.has(entry.contact.dedupeKey));
  const known = clean.filter((entry) => existing.has(entry.contact.dedupeKey));

  const personIds: string[] = [];
  const freshIds: string[] = [];
  const statements: { sql: string; args: (string | number | null)[] }[] = [];

  for (const entry of fresh) {
    const personId = newId('person');
    personIds.push(personId);
    freshIds.push(personId);
    statements.push(
      ...insertContactStatements({
        personId,
        importId,
        workspaceId: batch.workspace_id,
        consentBasis: batch.consent_basis,
        consentSource: batch.consent_source,
        contact: entry.contact,
      }),
    );
  }

  for (const entry of known) {
    const personId = existing.get(entry.contact.dedupeKey);
    if (personId) personIds.push(personId);
  }

  for (const reject of rejects) {
    statements.push({
      sql: `INSERT INTO contact_import_rejects (id, import_id, row_number, email, reason, detail,
            created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('contactImportReject'),
        importId,
        reject.row,
        reject.email ?? null,
        reject.reason,
        reject.detail,
        now(),
      ],
    });
  }

  let imported = fresh.length;
  let merged = known.length;
  let rejected = rejects.length;

  // ---------------------------------------------------------------- write
  // One round trip for the chunk. `db.batch` is transactional, so a single
  // unique violation would lose the other four hundred and ninety-nine —
  // hence the fallback, which is the slow path this replaced and is reached
  // only when two imports genuinely race on one address.
  if (statements.length > 0) {
    try {
      await db.batch(statements);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // The slow path stores and patches row by row, so nothing is left for
      // the batched patch below.
      const retried = await storeOneAtATime(db, importId, batch, clean, rejects.length);
      await db.execute({
        sql: `UPDATE contact_imports
                 SET total_rows = total_rows + ?, imported = imported + ?,
                     merged = merged + ?, updated = updated + ?, rejected = rejected + ?,
                     updated_at = ?
               WHERE id = ?`,
        args: [
          rows.length,
          retried.imported,
          retried.merged,
          retried.updated,
          retried.rejected,
          now(),
          importId,
        ],
      });
      return retried;
    }
  }

  // ---------------------------------------------------------------- patch
  // An import is usually the newer data: an enriched export of people we
  // already hold. Every known row patches its person (newest wins, see
  // planPatch), and new people get their company and LinkedIn attached. A
  // handful of reads and one batch for the chunk, however many rows.
  const updated = await patchPeople(
    db,
    known.flatMap((entry) => {
      const personId = existing.get(entry.contact.dedupeKey);
      return personId ? [{ personId, contact: entry.contact }] : [];
    }),
  );
  await patchPeople(
    db,
    fresh.flatMap((entry, index) => {
      const personId = freshIds[index];
      return personId && (entry.contact.companyDomain || entry.contact.linkedinUrl)
        ? [{ personId, contact: entry.contact }]
        : [];
    }),
  );

  await db.execute({
    sql: `UPDATE contact_imports
             SET total_rows = total_rows + ?, imported = imported + ?,
                 merged = merged + ?, updated = updated + ?, rejected = rejected + ?, updated_at = ?
           WHERE id = ?`,
    args: [rows.length, imported, merged, updated, rejected, now(), importId],
  });

  return { imported, merged, updated, rejected, personIds };
}

/**
 * Which of these mailboxes we already hold, in one query.
 *
 * Chunked into groups because a single `IN` list of several thousand is a
 * statement SQLite will refuse to compile. Five hundred is comfortably inside
 * the parameter ceiling and still one round trip per chunk.
 */
async function existingByDedupeKey(
  db: Client,
  workspaceId: string,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (keys.length === 0) return found;

  for (let offset = 0; offset < keys.length; offset += 500) {
    const slice = keys.slice(offset, offset + 500);
    const placeholders = slice.map(() => '?').join(', ');

    const result = await db.execute({
      sql: `SELECT dedupe_key, person_id FROM person_emails
             WHERE workspace_id = ? AND dedupe_key IN (${placeholders})`,
      args: [workspaceId, ...slice],
    });

    for (const row of result.rows) {
      const typed = row as unknown as { dedupe_key: string; person_id: string };
      found.set(String(typed.dedupe_key), String(typed.person_id));
    }
  }

  return found;
}

/** The three writes one new contact needs, as statements rather than calls. */
function insertContactStatements(input: {
  readonly personId: string;
  readonly importId: string;
  readonly workspaceId: string;
  readonly consentBasis: string;
  readonly consentSource: string | null;
  readonly contact: CleanContact;
}): { sql: string; args: (string | number | null)[] }[] {
  const stamp = now();
  const { contact, personId } = input;

  return [
    {
      sql: `INSERT INTO people (id, display_name, first_name, last_name, current_title, location,
            identity_confidence, status, outreach_eligible, created_at, updated_at,
            last_resolved_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
      args: [
        personId,
        contact.displayName,
        contact.firstName ?? null,
        contact.lastName ?? null,
        contact.title ?? null,
        contact.location ?? null,
        IMPORTED_CONFIDENCE,
        stamp,
        stamp,
        stamp,
      ],
    },
    {
      sql: `INSERT INTO person_emails (id, workspace_id, person_id, address, dedupe_key, source,
            verified, created_at) VALUES (?, ?, ?, ?, ?, 'import', 1, ?)`,
      args: [
        newId('personEmail'),
        input.workspaceId,
        personId,
        contact.email,
        contact.dedupeKey,
        stamp,
      ],
    },
    {
      sql: `INSERT INTO person_consent (person_id, workspace_id, basis, source, import_id,
            recorded_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        personId,
        input.workspaceId,
        input.consentBasis,
        input.consentSource,
        input.importId,
        stamp,
      ],
    },
  ];
}

/**
 * The old row-at-a-time path, kept for when the batch loses a race.
 *
 * Slow and correct. Reached only when two imports insert the same address at
 * the same moment, which the unique index catches and which would otherwise
 * cost the whole chunk.
 */
async function storeOneAtATime(
  db: Client,
  importId: string,
  batch: { workspace_id: string; consent_basis: string; consent_source: string | null },
  clean: readonly { row: number; contact: CleanContact }[],
  alreadyRejected: number,
): Promise<ChunkResult> {
  const personIds: string[] = [];
  let imported = 0;
  let merged = 0;
  let updated = 0;
  let rejected = alreadyRejected;

  for (const entry of clean) {
    try {
      const outcome = await storeContact(db, {
        importId,
        workspaceId: batch.workspace_id,
        consentBasis: batch.consent_basis,
        consentSource: batch.consent_source,
        contact: entry.contact,
      });

      if (outcome.created) imported += 1;
      else merged += 1;
      const changed = await patchPeople(db, [
        { personId: outcome.personId, contact: entry.contact },
      ]);
      if (!outcome.created) updated += changed;

      personIds.push(outcome.personId);
    } catch (error) {
      rejected += 1;
      await recordReject(
        db,
        importId,
        entry.row,
        entry.contact.email,
        'malformed_email',
        `could not be stored: ${String(error)}`,
      );
    }
  }

  return { imported, merged, updated, rejected, personIds };
}

async function recordReject(
  db: Client,
  importId: string,
  rowNumber: number,
  email: string | undefined,
  reason: RejectReason | string,
  detail: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO contact_import_rejects (id, import_id, row_number, email, reason, detail,
          created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('contactImportReject'),
      importId,
      rowNumber,
      email ?? null,
      String(reason),
      detail,
      now(),
    ],
  });
}

/**
 * Writes one cleaned contact, or finds the person who already owns the mailbox.
 *
 * The insert into `person_emails` is attempted first and its unique violation
 * is the merge signal. Doing it the other way round — look up, then insert —
 * would be correct only if chunks never overlapped, and they do: the browser
 * posts several at once and the same address can legitimately appear in two of
 * them.
 */
async function storeContact(
  db: Client,
  input: {
    readonly importId: string;
    readonly workspaceId: string;
    readonly consentBasis: string;
    readonly consentSource: string | null;
    readonly contact: CleanContact;
  },
): Promise<{ personId: string; created: boolean }> {
  const existing = await queryOne<{ person_id: string }>(
    db,
    'SELECT person_id FROM person_emails WHERE workspace_id = ? AND dedupe_key = ?',
    [input.workspaceId, input.contact.dedupeKey],
  );

  if (existing) return { personId: existing.person_id, created: false };

  const personId = newId('person');
  const stamp = now();
  const { contact } = input;

  await db.execute({
    sql: `INSERT INTO people (id, display_name, first_name, last_name, current_title, location,
          identity_confidence, status, outreach_eligible, created_at, updated_at, last_resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
    args: [
      personId,
      contact.displayName,
      contact.firstName ?? null,
      contact.lastName ?? null,
      contact.title ?? null,
      contact.location ?? null,
      IMPORTED_CONFIDENCE,
      stamp,
      stamp,
      stamp,
    ],
  });

  try {
    await db.execute({
      sql: `INSERT INTO person_emails (id, workspace_id, person_id, address, dedupe_key, source,
            verified, created_at) VALUES (?, ?, ?, ?, ?, 'import', 1, ?)`,
      args: [
        newId('personEmail'),
        input.workspaceId,
        personId,
        contact.email,
        contact.dedupeKey,
        stamp,
      ],
    });
  } catch (error) {
    // Lost the race: another chunk created this mailbox between the lookup and
    // here. Drop the person we just made and use theirs.
    if (isUniqueViolation(error)) {
      await db.execute({ sql: 'DELETE FROM people WHERE id = ?', args: [personId] });

      const winner = await queryOne<{ person_id: string }>(
        db,
        'SELECT person_id FROM person_emails WHERE workspace_id = ? AND dedupe_key = ?',
        [input.workspaceId, contact.dedupeKey],
      );

      if (winner) return { personId: winner.person_id, created: false };
    }

    throw error;
  }

  await db.execute({
    sql: `INSERT INTO person_consent (person_id, workspace_id, basis, source, import_id,
          recorded_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      personId,
      input.workspaceId,
      input.consentBasis,
      input.consentSource,
      input.importId,
      stamp,
    ],
  });

  return { personId, created: true };
}

/** The fields of a stored person an import can change. */
export interface StoredPerson {
  readonly display_name: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly current_title: string | null;
  readonly location: string | null;
  readonly current_company_id: string | null;
  readonly updated_at: string | null;
}

/**
 * What an imported row changes on a person we already had: column -> value.
 *
 * Newest wins. An import is normally the newer data (an enriched export of
 * people we hold), so a value it carries replaces a different stored one.
 * Two exceptions keep it from downgrading a record:
 *
 *   - a name derived from the address ("dave.mackenzie@" -> Dave Mackenzie)
 *     never replaces a real one, and is never written over one;
 *   - a row dated older than the stored person (an `updated_at` or
 *     `enriched_at` column) only fills blanks.
 *
 * Empty cells never erase anything.
 */
export function planPatch(
  person: StoredPerson,
  contact: CleanContact,
  companyId?: string | undefined,
): Record<string, string> {
  const older = Boolean(
    contact.updatedAt && person.updated_at && contact.updatedAt < person.updated_at,
  );
  const patch: Record<string, string> = {};
  const take = (column: string, stored: string | null, incoming: string | undefined) => {
    if (!incoming || incoming === stored) return;
    if (older && stored) return;
    patch[column] = incoming;
  };

  if (!contact.nameDerived) {
    take('display_name', person.display_name, contact.displayName);
    take('first_name', person.first_name, contact.firstName);
    take('last_name', person.last_name, contact.lastName);
  }
  take('current_title', person.current_title, contact.title);
  take('location', person.location, contact.location);
  take('current_company_id', person.current_company_id, companyId);
  return patch;
}

const IN_CHUNK = 400;

async function rowsIn<T>(
  db: Client,
  sql: (placeholders: string) => string,
  keys: readonly string[],
  extra: readonly string[] = [],
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < keys.length; offset += IN_CHUNK) {
    const slice = keys.slice(offset, offset + IN_CHUNK);
    if (!slice.length) continue;
    const result = await db.execute({
      sql: sql(slice.map(() => '?').join(', ')),
      args: [...extra, ...slice],
    });
    out.push(...(result.rows as unknown as T[]));
  }
  return out;
}

/** The company row for each domain, made when it is new. */
async function companiesFor(
  db: Client,
  wanted: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const domains = [...wanted.keys()];
  const found = new Map<string, string>();
  if (!domains.length) return found;
  const read = async () => {
    for (const row of await rowsIn<{ id: string; domain: string }>(
      db,
      (p) => `SELECT id, domain FROM companies WHERE domain IN (${p})`,
      domains,
    ))
      found.set(String(row.domain), String(row.id));
  };
  await read();
  const missing = domains.filter((d) => !found.has(d));
  if (missing.length) {
    const stamp = now();
    // No conflict target: the domain index is partial, and a bare DO NOTHING
    // reads the same on SQLite and Postgres. A racing import makes the row; we
    // read it back either way.
    await db.batch(
      missing.map((domain) => ({
        sql: `INSERT INTO companies (id, name, domain, technologies, created_at, updated_at)
              VALUES (?, ?, ?, '[]', ?, ?) ON CONFLICT DO NOTHING`,
        args: [newId('company'), wanted.get(domain) ?? domain, domain, stamp, stamp],
      })),
    );
    await read();
  }
  return found;
}

/**
 * Applies each row's newer data to its person, in a few reads and one batch.
 * Returns how many people changed.
 */
async function patchPeople(
  db: Client,
  entries: ReadonlyArray<{ personId: string; contact: CleanContact }>,
): Promise<number> {
  if (!entries.length) return 0;

  const wanted = new Map<string, string>();
  for (const { contact } of entries)
    if (contact.companyDomain && !wanted.has(contact.companyDomain))
      wanted.set(contact.companyDomain, contact.company ?? contact.companyDomain);
  const companies = await companiesFor(db, wanted);

  const ids = [...new Set(entries.map((e) => e.personId))];
  const people = new Map(
    (
      await rowsIn<StoredPerson & { id: string }>(
        db,
        (p) => `SELECT id, display_name, first_name, last_name, current_title, location,
                       current_company_id, updated_at
                  FROM people WHERE id IN (${p})`,
        ids,
      )
    ).map((row) => [String(row.id), row] as const),
  );

  const linked = new Set(
    (
      await rowsIn<{ person_id: string; profile_url: string }>(
        db,
        (p) => `SELECT person_id, profile_url FROM social_identities
                 WHERE network = 'linkedin' AND person_id IN (${p})`,
        ids,
      )
    ).map((row) => `${row.person_id} ${row.profile_url}`),
  );

  const stamp = now();
  const statements: { sql: string; args: (string | number | null)[] }[] = [];
  const changed = new Set<string>();

  for (const { personId, contact } of entries) {
    const person = people.get(personId);
    if (!person) continue;

    const patch = planPatch(
      person,
      contact,
      contact.companyDomain ? companies.get(contact.companyDomain) : undefined,
    );
    const columns = Object.keys(patch);
    if (columns.length) {
      statements.push({
        sql: `UPDATE people SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
               WHERE id = ?`,
        args: [...columns.map((c) => patch[c]!), stamp, personId],
      });
      changed.add(personId);
    }

    const url = contact.linkedinUrl;
    if (url && !linked.has(`${personId} ${url}`)) {
      linked.add(`${personId} ${url}`);
      statements.push({
        sql: `INSERT INTO social_identities (id, person_id, network, handle, profile_url, confidence,
              source_type, verified_by, first_seen_at, last_verified_at)
              VALUES (?, ?, 'linkedin', ?, ?, ?, 'import', ?, ?, ?)`,
        args: [
          newId('socialIdentity'),
          personId,
          decodeURIComponent(url.split('/in/')[1] ?? '') || null,
          url,
          IMPORTED_CONFIDENCE,
          JSON.stringify(['import']),
          stamp,
          stamp,
        ],
      });
      changed.add(personId);
    }
  }

  if (statements.length) await db.batch(statements);
  return changed.size;
}

export async function finishContactImport(db: Client, importId: string): Promise<void> {
  await db.execute({
    sql: `UPDATE contact_imports SET status = 'complete', updated_at = ? WHERE id = ?`,
    args: [now(), importId],
  });
}
