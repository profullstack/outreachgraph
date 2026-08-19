'use client';

import { useRouter } from 'next/navigation';
import { useState, type ChangeEvent } from 'react';
import { mapHeaders } from '@outreachgraph/domain';
import { applyMapping, parseCsv, type MappedRow } from '../lib/csv';

/**
 * Importing a list of people you already have permission to email.
 *
 * The screen is arranged around the two things that go wrong with a bulk
 * import, neither of which is the upload.
 *
 * The first is silent loss. A list of seventeen thousand becomes fifteen and
 * nobody can say which two thousand went or why, so the import is never
 * trusted again. Every dropped row is stored with its reason and shown back,
 * grouped, with examples.
 *
 * The second is consent. Everything else this product contacts was found by
 * crawling, where the evidence travels with the record. An imported list
 * arrives with none, and once the spreadsheet is closed there is nothing to
 * distinguish your own signups from a purchased list. Asking here is the only
 * cheap moment.
 */

const CHUNK = 500;

interface ImportSummary {
  readonly imported: number;
  readonly merged: number;
  readonly rejected: number;
}

interface RejectGroup {
  readonly reason: string;
  readonly n: number;
}

const REASON_LABELS: Readonly<Record<string, string>> = {
  no_email: 'no address in the row',
  malformed_email: 'not a valid address',
  undeliverable_domain: 'domain cannot receive mail',
  disposable_domain: 'throwaway mailbox',
  role_address: 'nobody reads that mailbox',
  placeholder_address: 'placeholder or test address',
  duplicate: 'already on the list',
};

export function ContactImport() {
  const router = useRouter();

  const [rows, setRows] = useState<MappedRow[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [filename, setFilename] = useState('');
  const [consentSource, setConsentSource] = useState('');

  const [progress, setProgress] = useState<number | undefined>();
  const [summary, setSummary] = useState<ImportSummary | undefined>();
  const [groups, setGroups] = useState<RejectGroup[]>([]);
  const [error, setError] = useState<string | undefined>();

  function onFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(undefined);
    setSummary(undefined);
    setFilename(file.name);

    const reader = new FileReader();

    reader.onload = () => {
      const parsed = parseCsv(String(reader.result ?? ''));
      const [head, ...body] = parsed;

      if (!head) {
        setError('That file has no rows.');
        return;
      }

      const found = mapHeaders(head);

      if (found.email === undefined) {
        setError(
          `No email column found. Columns seen: ${head.join(', ')}. Rename one to "email" and try again.`,
        );
        setHeaders(head);
        setRows([]);
        return;
      }

      setHeaders(head);
      setMapping(found);
      setRows(applyMapping(body, found));
    };

    reader.readAsText(file);
  }

  async function run(): Promise<void> {
    setError(undefined);
    setProgress(0);

    try {
      const started = await fetch('/api/v1/contacts/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename, consentSource }),
      });

      if (!started.ok) {
        setError('Could not start the import.');
        setProgress(undefined);
        return;
      }

      const { importId } = (await started.json()) as { importId: string };
      const totals = { imported: 0, merged: 0, rejected: 0 };

      // Sequentially, so the server sees a steady trickle rather than
      // thirty-four simultaneous writes, and so progress means something.
      for (let offset = 0; offset < rows.length; offset += CHUNK) {
        const response = await fetch(`/api/v1/contacts/imports/${importId}/rows`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ startRow: offset, rows: rows.slice(offset, offset + CHUNK) }),
        });

        if (!response.ok) {
          setError(`Stopped at row ${offset}. Nothing before it was lost — re-run to continue.`);
          break;
        }

        const chunk = (await response.json()) as ImportSummary;
        totals.imported += chunk.imported;
        totals.merged += chunk.merged;
        totals.rejected += chunk.rejected;

        setProgress(Math.min(100, Math.round(((offset + CHUNK) / rows.length) * 100)));
        setSummary({ ...totals });
      }

      await fetch(`/api/v1/contacts/imports/${importId}/finish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      const detail = await fetch(`/api/v1/contacts/imports/${importId}`);

      if (detail.ok) {
        const body = (await detail.json()) as { rejectsByReason: RejectGroup[] };
        setGroups(body.rejectsByReason);
      }

      setProgress(100);
      router.refresh();
    } catch {
      setError('Lost the connection. Re-running is safe — imported rows are matched, not doubled.');
      setProgress(undefined);
    }
  }

  const busy = progress !== undefined && progress < 100;

  return (
    <section className="border-border bg-surface-raised rounded-2xl border p-4">
      <h2 className="font-medium">Import a list</h2>
      <p className="text-ink-muted mt-1 text-sm">
        A CSV with an email column. Names, company and title are used when present. Everything is
        checked on the way in and anything unusable is reported back rather than dropped quietly.
      </p>

      <div className="mt-4">
        <label className="text-ink-muted text-xs" htmlFor="csv">
          CSV file
        </label>
        <input
          id="csv"
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          disabled={busy}
          className="border-border bg-surface mt-1 w-full rounded-xl border p-2 text-sm"
        />
      </div>

      {rows.length > 0 ? (
        <>
          <p className="mt-3 text-sm">
            {rows.length.toLocaleString()} rows read from {filename}.
          </p>

          <dl className="text-ink-muted mt-2 grid grid-cols-2 gap-1 text-xs">
            {Object.entries(mapping).map(([field, index]) => (
              <div key={field}>
                <dt className="inline font-medium">{field}</dt>{' '}
                <dd className="inline">← {headers[index]}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-4">
            <label className="text-ink-muted text-xs" htmlFor="consent">
              Where did these people opt in?
            </label>
            <input
              id="consent"
              value={consentSource}
              onChange={(event) => setConsentSource(event.target.value)}
              placeholder="e.g. Profullstack app signup, marketing opt-in checkbox"
              disabled={busy}
              className="border-border bg-surface mt-1 w-full rounded-xl border p-2 text-sm"
            />
            <p className="text-ink-muted mt-1 text-xs">
              Recorded against every person imported. This is what a deliverability complaint or a
              data request actually asks for, and it cannot be reconstructed later.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void run()}
            disabled={busy || !consentSource.trim()}
            className="border-border mt-4 rounded-xl border px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? `Importing… ${progress}%` : `Import ${rows.length.toLocaleString()} contacts`}
          </button>

          {!consentSource.trim() ? (
            <p className="text-ink-muted mt-2 text-xs">Say where they opted in before importing.</p>
          ) : null}
        </>
      ) : null}

      {summary ? (
        <div className="border-border mt-4 rounded-xl border p-3 text-sm">
          <p>
            <span className="font-medium">{summary.imported.toLocaleString()}</span> added
            {summary.merged > 0 ? `, ${summary.merged.toLocaleString()} already known` : ''}
            {summary.rejected > 0 ? `, ${summary.rejected.toLocaleString()} not usable` : ''}.
          </p>

          {groups.length > 0 ? (
            <ul className="text-ink-muted mt-2 flex flex-col gap-1 text-xs">
              {groups.map((group) => (
                <li key={group.reason}>
                  <span className="font-medium">{group.n.toLocaleString()}</span>{' '}
                  {REASON_LABELS[group.reason] ?? group.reason}
                </li>
              ))}
            </ul>
          ) : null}

          {progress === 100 ? (
            <p className="text-ink-muted mt-2 text-xs">
              Looking up published profiles for each of them now — a GitHub or Mastodon account
              where one exists. Most people have none, which is normal.
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-hot mt-3 text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}
