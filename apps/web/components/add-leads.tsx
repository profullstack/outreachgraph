'use client';

import { useRouter } from 'next/navigation';
import { useState, type ChangeEvent } from 'react';
import { mapHeaders } from '@outreachgraph/domain';
import { applyMapping, parseCsv, type MappedRow } from '../lib/csv';

/**
 * Adding leads from a CSV to a campaign that is already running.
 *
 * The thing Explee cannot do (every import there is a new campaign), and the
 * thing that burned us there: rows vanishing without a word. So the result
 * is the report, not a count. Every row that did not become a lead is listed
 * with the column or check behind it, the whole list downloads as a CSV to
 * open beside the original file, and the leads screening is holding back are
 * named as such rather than quietly sent to or quietly dropped.
 */

/** The most one file may hold. Sent in chunks, so this is not a request size. */
const MAX_ROWS = 100_000;

/** Rows per request: the API takes at most 5,000 leads per call. */
const CHUNK_ROWS = 5_000;

interface ReportRow {
  readonly row: number | null;
  readonly email: string | null;
  readonly outcome: 'rejected' | 'skipped' | 'flagged';
  readonly reason: string;
  readonly why: string;
  readonly detail: string | null;
}

interface AppendResult {
  readonly received: number;
  readonly added: number;
  readonly imported: number;
  readonly merged: number;
  readonly updated: number;
  readonly rejected: number;
  readonly skipped: number;
  readonly flagged: number;
  readonly flagged_held: number;
  readonly report: readonly ReportRow[];
  readonly report_truncated: boolean;
  /** Absent when the file went up in several chunks; the report is built here instead. */
  readonly report_url?: string;
}

/** Adds one chunk's result to the running total, row numbers shifted to the file's. */
function mergeResults(total: AppendResult | undefined, next: AppendResult, offset: number) {
  const shifted = next.report.map((row) => ({
    ...row,
    row: row.row === null ? null : row.row + offset,
  }));
  if (!total) return { ...next, report: shifted };
  return {
    received: total.received + next.received,
    added: total.added + next.added,
    imported: total.imported + next.imported,
    merged: total.merged + next.merged,
    updated: total.updated + next.updated,
    rejected: total.rejected + next.rejected,
    skipped: total.skipped + next.skipped,
    flagged: total.flagged + next.flagged,
    flagged_held: total.flagged_held + next.flagged_held,
    report: [...total.report, ...shifted],
    report_truncated: total.report_truncated || next.report_truncated,
  } satisfies AppendResult;
}

/** The combined report as a CSV, for a file sent in several chunks. */
function reportCsv(report: readonly ReportRow[]): string {
  const cell = (value: string | number | null) => {
    const text = value === null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    'row,email,outcome,reason,why,detail',
    ...report.map((r) =>
      [r.row, r.email, r.outcome, r.reason, r.why, r.detail].map(cell).join(','),
    ),
  ].join('\n');
}

const OUTCOME_LABEL: Readonly<Record<ReportRow['outcome'], string>> = {
  rejected: 'Not usable',
  skipped: 'Skipped',
  flagged: 'Held by screening',
};

export function AddLeads({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<MappedRow[]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [headers, setHeaders] = useState<string[]>([]);
  const [filename, setFilename] = useState('');
  const [consentSource, setConsentSource] = useState('');
  const [allowFlagged, setAllowFlagged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AppendResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [progress, setProgress] = useState<string | undefined>();

  function onFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(undefined);
    setResult(undefined);
    setFilename(file.name);

    const reader = new FileReader();
    reader.onload = () => {
      const [head, ...body] = parseCsv(String(reader.result ?? ''));
      if (!head) {
        setError('That file has no rows.');
        return;
      }
      const found = mapHeaders(head);
      setHeaders(head);
      if (found.email === undefined) {
        setRows([]);
        setError(`No email column. Columns seen: ${head.join(', ')}. Rename one to "email".`);
        return;
      }
      if (body.length > MAX_ROWS) {
        setRows([]);
        setError(
          `${body.length.toLocaleString()} rows: the most one file can hold is ${MAX_ROWS.toLocaleString()}.`,
        );
        return;
      }
      setMapping(found);
      setRows(applyMapping(body, found));
    };
    reader.readAsText(file);
  }

  async function run(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    let total: AppendResult | undefined;
    const chunks = Math.ceil(rows.length / CHUNK_ROWS);
    try {
      // One request per 5,000 rows, in order. Re-running after a failure is
      // safe: leads already added are skipped.
      for (let i = 0; i < chunks; i += 1) {
        const offset = i * CHUNK_ROWS;
        const chunk = rows.slice(offset, offset + CHUNK_ROWS);
        if (chunks > 1) {
          setProgress(
            `Sending rows ${(offset + 1).toLocaleString()}-${(offset + chunk.length).toLocaleString()} of ${rows.length.toLocaleString()}…`,
          );
        }
        const response = await fetch(
          `/api/v1/autogtm/campaigns/${encodeURIComponent(campaignId)}/leads`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              filename,
              consent_source: consentSource,
              allow_flagged: allowFlagged,
              leads: chunk.map((row) => ({
                email: row.email,
                name: row.name,
                first_name: row.firstName,
                last_name: row.lastName,
                company: row.company,
                company_domain: row.companyDomain,
                job_title: row.title,
                location: row.location,
                linkedin_url: row.linkedinUrl,
                updated_at: row.updatedAt,
              })),
            }),
          },
        );
        const payload = (await response.json().catch(() => ({}))) as AppendResult & {
          error?: { message?: string };
        };
        if (!response.ok) {
          if (total) setResult(total);
          setError(
            `${payload.error?.message ?? `That failed (${response.status}).`}` +
              (i > 0 ? ` Stopped at row ${(offset + 1).toLocaleString()}; re-run to finish.` : ''),
          );
          return;
        }
        total = mergeResults(total, payload, offset);
      }
      if (total && chunks > 1) {
        const { report_url: _single, ...combined } = total;
        void _single;
        total = combined;
      }
      setResult(total);
      setRows([]);
      router.refresh();
    } catch {
      if (total) setResult(total);
      setError('Lost the connection. Re-running is safe: leads already added are skipped.');
    } finally {
      setProgress(undefined);
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border-border mb-2 rounded-xl border px-3 py-1.5 text-sm font-medium"
      >
        Add leads from a CSV
      </button>
    );
  }

  return (
    <div className="border-border bg-surface-raised mb-3 rounded-xl border p-3 text-sm">
      <p className="text-ink-muted text-xs">
        A CSV with an email column; names, company domain, job title and LinkedIn are used when
        present. People already in this product, and anyone on a suppress list, are skipped. Every
        row that does not become a lead is reported with the reason.
      </p>

      <input
        type="file"
        accept=".csv,text/csv"
        onChange={onFile}
        disabled={busy}
        aria-label="CSV file"
        className="border-border bg-surface mt-2 w-full rounded-xl border p-2 text-sm"
      />

      {rows.length > 0 ? (
        <>
          <p className="mt-2">
            {rows.length.toLocaleString()} rows in {filename}.
          </p>
          <p className="text-ink-muted mt-1 text-xs">
            {Object.entries(mapping)
              .map(([field, index]) => `${field} ← ${headers[index]}`)
              .join(' · ')}
          </p>
          <input
            value={consentSource}
            onChange={(event) => setConsentSource(event.target.value)}
            placeholder="Where these people came from (e.g. app signups)"
            disabled={busy}
            className="border-border bg-surface mt-2 w-full rounded-xl border p-2 text-sm"
          />
          <label className="text-ink-muted mt-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={allowFlagged}
              onChange={(event) => setAllowFlagged(event.target.checked)}
            />
            Send to screened leads too (generated names, relay and temp-mail addresses, bots, role
            inboxes). Off by default: they are imported and held for you to review.
          </label>
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy || !consentSource.trim()}
            className="bg-accent mt-3 rounded-xl px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Adding…' : `Add ${rows.length.toLocaleString()} leads`}
          </button>
        </>
      ) : null}

      {progress ? <p className="text-ink-muted mt-2 text-xs">{progress}</p> : null}

      {result ? <ImportReportView result={result} /> : null}

      {error ? (
        <p role="alert" className="text-hot mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ImportReportView({ result }: { result: AppendResult }) {
  const groups = new Map<string, { outcome: ReportRow['outcome']; why: string; n: number }>();
  for (const row of result.report) {
    const key = `${row.outcome}:${row.reason}`;
    const group = groups.get(key) ?? { outcome: row.outcome, why: row.why, n: 0 };
    group.n += 1;
    groups.set(key, group);
  }

  return (
    <div className="border-border mt-3 rounded-xl border p-3">
      <p>
        <span className="font-medium">{result.added.toLocaleString()}</span> of{' '}
        {result.received.toLocaleString()} added
        {result.skipped > 0 ? `, ${result.skipped.toLocaleString()} skipped` : ''}
        {result.rejected > 0 ? `, ${result.rejected.toLocaleString()} not usable` : ''}
        {result.flagged > 0
          ? `, ${result.flagged.toLocaleString()} flagged by screening${
              result.flagged_held > 0 ? ' and held back from sending' : ' (sending anyway)'
            }`
          : ''}
        .
      </p>
      {groups.size > 0 ? (
        <ul className="text-ink-muted mt-2 flex flex-col gap-1 text-xs">
          {[...groups.values()].map((group) => (
            <li key={`${group.outcome}:${group.why}`}>
              <span className="font-medium">{group.n.toLocaleString()}</span>{' '}
              {OUTCOME_LABEL[group.outcome].toLowerCase()}: {group.why}
            </li>
          ))}
        </ul>
      ) : null}
      {result.report.length > 0 ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer">Every row ({result.report.length})</summary>
          <ul className="mt-1 flex max-h-64 flex-col gap-0.5 overflow-auto">
            {result.report.map((row) => (
              <li key={`${row.row}:${row.outcome}`}>
                Row {row.row ?? '?'} {row.email ? `(${row.email})` : ''}:{' '}
                {OUTCOME_LABEL[row.outcome]}, {row.detail ?? row.why}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <a
        href={
          result.report_url ??
          `data:text/csv;charset=utf-8,${encodeURIComponent(reportCsv(result.report))}`
        }
        download={result.report_url ? undefined : 'import-report.csv'}
        className="text-accent mt-2 inline-block text-xs font-medium"
      >
        Download the full report (CSV)
      </a>
    </div>
  );
}
