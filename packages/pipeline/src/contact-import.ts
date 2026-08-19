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
  const statements: { sql: string; args: (string | number | null)[] }[] = [];

  for (const entry of fresh) {
    const personId = newId('person');
    personIds.push(personId);
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

      const retried = await storeOneAtATime(db, importId, batch, clean, rejects.length);
      imported = retried.imported;
      merged = retried.merged;
      rejected = retried.rejected;
      personIds.length = 0;
      personIds.push(...retried.personIds);
    }
  }

  // Gap-filling for people we already had is deliberately *not* batched into
  // the above: it reads each person to avoid overwriting what is already
  // known, and doing that for a chunk that is mostly re-imports is the one
  // case where the extra round trips buy something. Bounded so a re-import of
  // seventeen thousand does not become the old behaviour by another route.
  for (const entry of known.slice(0, MERGE_ENRICH_LIMIT)) {
    const personId = existing.get(entry.contact.dedupeKey);
    if (personId) await enrichExistingPerson(db, personId, entry.contact);
  }

  await db.execute({
    sql: `UPDATE contact_imports
             SET total_rows = total_rows + ?, imported = imported + ?,
                 merged = merged + ?, rejected = rejected + ?, updated_at = ?
           WHERE id = ?`,
    args: [rows.length, imported, merged, rejected, now(), importId],
  });

  return { imported, merged, rejected, personIds };
}

/**
 * How many already-known people get their gaps filled per chunk.
 *
 * Gap-filling reads the stored person first so it cannot overwrite a better
 * value, which is a round trip each. Worth it for a handful; for a re-import
 * of seventeen thousand it would restore exactly the cost this change
 * removed. The rest keep what they have, which is what a merge means anyway.
 */
const MERGE_ENRICH_LIMIT = 50;

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
): Promise<{ imported: number; merged: number; rejected: number; personIds: string[] }> {
  const personIds: string[] = [];
  let imported = 0;
  let merged = 0;
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

  return { imported, merged, rejected, personIds };
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

  if (existing) {
    await enrichExistingPerson(db, existing.person_id, input.contact);
    return { personId: existing.person_id, created: false };
  }

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

/**
 * Fills gaps on a person we already had, without overwriting what we know.
 *
 * A second import must not downgrade a record. If the existing name came from
 * a real source and this row derived one from the address, keeping the
 * existing one is right — and the reverse is right too, which is why the
 * derived flag travels this far.
 */
async function enrichExistingPerson(
  db: Client,
  personId: string,
  contact: CleanContact,
): Promise<void> {
  const person = await queryOne<{
    display_name: string;
    first_name: string | null;
    last_name: string | null;
    current_title: string | null;
    location: string | null;
  }>(
    db,
    `SELECT display_name, first_name, last_name, current_title, location
       FROM people WHERE id = ?`,
    [personId],
  );

  if (!person) return;

  const updates: string[] = [];
  const args: unknown[] = [];

  if (!contact.nameDerived && contact.displayName && contact.displayName !== person.display_name) {
    updates.push('display_name = ?');
    args.push(contact.displayName);
  }
  if (!person.first_name && contact.firstName) {
    updates.push('first_name = ?');
    args.push(contact.firstName);
  }
  if (!person.last_name && contact.lastName) {
    updates.push('last_name = ?');
    args.push(contact.lastName);
  }
  if (!person.current_title && contact.title) {
    updates.push('current_title = ?');
    args.push(contact.title);
  }
  if (!person.location && contact.location) {
    updates.push('location = ?');
    args.push(contact.location);
  }

  if (updates.length === 0) return;

  updates.push('updated_at = ?');
  args.push(now(), personId);

  await db.execute({
    sql: `UPDATE people SET ${updates.join(', ')} WHERE id = ?`,
    args: args as never[],
  });
}

export async function finishContactImport(db: Client, importId: string): Promise<void> {
  await db.execute({
    sql: `UPDATE contact_imports SET status = 'complete', updated_at = ? WHERE id = ?`,
    args: [now(), importId],
  });
}
