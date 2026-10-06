/**
 * The per-row import report.
 *
 * An import that silently drops rows is an import nobody trusts twice: the
 * list went in with 124 leads, 122 came out, and nobody could say which two or
 * why. So every row that did not simply become a lead is kept with what
 * happened to it, and this reads them back, all of them, as JSON or as a CSV
 * a person can open beside their own file:
 *
 *   - `rejected`: unusable (no address, a malformed one, a placeholder...),
 *     with the column or check that failed;
 *   - `skipped`: usable, but already in this campaign or project, or on a
 *     suppress list;
 *   - `flagged`: imported, and held back from sending by lead screening until
 *     a human allows it.
 */

import type { Context } from 'hono';
import { toCsv } from '@outreachgraph/domain';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';

export interface ImportReportRow {
  readonly row: number | null;
  readonly email: string | null;
  readonly outcome: 'rejected' | 'skipped' | 'flagged';
  readonly reason: string;
  readonly detail: string | null;
}

export interface ImportReport {
  readonly task_id: string;
  readonly campaign_id: string | null;
  readonly filename: string | null;
  readonly total_rows: number;
  readonly imported: number;
  readonly merged: number;
  readonly updated: number;
  readonly rejected: number;
  readonly skipped: number;
  readonly flagged: number;
  readonly rows: readonly ImportReportRow[];
}

/** Column names and what fails them, for the human reading a report. */
const REASON_TEXT: Readonly<Record<string, string>> = {
  no_email: 'required column "email" is empty',
  malformed_email: 'the "email" column is not an address',
  undeliverable_domain: 'the address domain cannot receive mail',
  disposable_domain: 'the address is a throwaway mailbox',
  role_address: 'nobody reads that mailbox',
  placeholder_address: 'a placeholder or test address',
  duplicate: 'the same address appears earlier in the file',
  already_in_campaign: 'already a lead in this campaign',
  already_in_project: 'already a lead in another campaign of this project',
  suppressed: 'on a suppress list',
};

/** A reason as words, for the UI and the CSV `why` column. */
export function reasonText(reason: string): string {
  return reason
    .split('+')
    .map((part) => REASON_TEXT[part] ?? part.replace(/_/g, ' '))
    .join('; ');
}

export async function importReport(
  db: Client,
  workspaceId: string,
  importId: string,
): Promise<ImportReport | undefined> {
  const batch = await queryOne<{
    id: string;
    campaign_id: string | null;
    filename: string | null;
    total_rows: number;
    imported: number;
    merged: number;
    updated: number | null;
    rejected: number;
    skipped: number | null;
    flagged: number | null;
  }>(
    db,
    `SELECT id, campaign_id, filename, total_rows, imported, merged, updated, rejected, skipped,
            flagged
       FROM contact_imports WHERE id = ? AND workspace_id = ?`,
    [importId, workspaceId],
  );
  if (!batch) return undefined;

  const rows = await queryAll<{
    row_number: number | null;
    email: string | null;
    outcome: string | null;
    reason: string;
    detail: string | null;
  }>(
    db,
    `SELECT row_number, email, outcome, reason, detail FROM contact_import_rejects
      WHERE import_id = ? ORDER BY row_number, outcome`,
    [importId],
  );

  return {
    task_id: batch.id,
    campaign_id: batch.campaign_id,
    filename: batch.filename,
    total_rows: Number(batch.total_rows),
    imported: Number(batch.imported),
    merged: Number(batch.merged),
    updated: Number(batch.updated ?? 0),
    rejected: Number(batch.rejected),
    skipped: Number(batch.skipped ?? 0),
    flagged: Number(batch.flagged ?? 0),
    rows: rows.map((row) => ({
      row: row.row_number === null ? null : Number(row.row_number),
      email: row.email,
      outcome: (row.outcome ?? 'rejected') as ImportReportRow['outcome'],
      reason: row.reason,
      detail: row.detail,
    })),
  };
}

/** The report as a download: one line per row, in file order. */
export function importReportCsv(c: Context, report: ImportReport): Response {
  const body = toCsv(
    report.rows.map((row) => ({
      row: row.row,
      email: row.email,
      outcome: row.outcome,
      reason: row.reason,
      why: reasonText(row.reason),
      detail: row.detail,
    })),
    ['row', 'email', 'outcome', 'reason', 'why', 'detail'],
  );
  return c.body(body, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="import-report-${report.task_id}.csv"`,
  });
}
