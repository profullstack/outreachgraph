'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';

/**
 * The mass URL intake (PRD §8, URL-first intake).
 *
 * This is the top of the funnel and it is built for volume: paste a thousand
 * addresses or drop a CSV, and the work of splitting that into what the API
 * accepts happens here rather than in the operator's head. The previous form
 * lived at the top of the prospect list under "Add from company websites",
 * where it was both too small for a real list and impossible to find if you
 * were looking for somewhere to start outreach.
 *
 * Nothing happens while you wait — the API answers 202 and the crawling runs
 * on the worker — so this reports progress until every batch has settled. A
 * spinner that resolves to nothing is what an empty product looks like.
 */

interface BatchItem {
  id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  url?: string;
  lastError?: string;
}

interface Batch {
  batchId: string;
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  items: BatchItem[];
}

interface Rejected {
  url: string;
  reason: string;
}

/** The server's own ceiling on one submission; longer lists are split to fit. */
const PER_REQUEST = 100;
const POLL_MS = 3000;

/** Splits on whitespace and commas, so a pasted column and a CSV row both work. */
function parseUrls(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function chunk(urls: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += size) chunks.push(urls.slice(i, i + size));
  return chunks;
}

export function BulkUrlIntake() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [queued, setQueued] = useState(0);
  const [duplicates, setDuplicates] = useState(0);
  const [rejected, setRejected] = useState<Rejected[]>([]);
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [batches, setBatches] = useState<Record<string, Batch>>({});

  const tracked = batchIds.map((id) => batches[id]).filter((batch): batch is Batch => !!batch);
  const outstanding = tracked.reduce((sum, batch) => sum + batch.pending + batch.running, 0);
  const settled = batchIds.length > 0 && tracked.length === batchIds.length && outstanding === 0;

  /**
   * Polls every batch still carrying work, and stops as soon as none is.
   *
   * The cleanup matters: without it, leaving this page keeps a timer calling
   * endpoints for batches nobody is looking at.
   */
  useEffect(() => {
    if (batchIds.length === 0 || settled) return;

    let cancelled = false;

    const tick = async () => {
      const results = await Promise.all(
        batchIds.map(async (id) => {
          try {
            const response = await fetch(`/api/v1/batches/${id}`, {
              credentials: 'same-origin',
              cache: 'no-store',
            });
            if (!response.ok) return undefined;
            return (await response.json()) as Batch;
          } catch {
            // A dropped poll is not worth surfacing; the next one is three
            // seconds away and will say the same thing.
            return undefined;
          }
        }),
      );

      if (cancelled) return;

      setBatches((current) => {
        const next = { ...current };
        for (const batch of results) if (batch) next[batch.batchId] = batch;
        return next;
      });
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [batchIds, settled]);

  // Once everything has landed, the prospect list this fed is stale.
  useEffect(() => {
    if (settled) router.refresh();
  }, [settled, router]);

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const contents = await file.text();
    // Appended rather than replacing: a second file is a bigger list, not a
    // different one.
    setText((current) => [current.trim(), ...parseUrls(contents)].filter(Boolean).join('\n'));

    // Clearing lets the same file be picked again after an edit.
    if (fileInput.current) fileInput.current.value = '';
  }

  async function submit(event: FormEvent) {
    event.preventDefault();

    const urls = parseUrls(text);
    if (urls.length === 0) return;

    setBusy(true);
    setError(undefined);
    setQueued(0);
    setDuplicates(0);
    setRejected([]);
    setBatchIds([]);
    setBatches({});

    const ids: string[] = [];
    let queuedTotal = 0;
    let duplicateTotal = 0;
    const rejectedAll: Rejected[] = [];

    try {
      // Sequential on purpose. These are crawl jobs on someone else's servers;
      // firing ten requests at once only moves the queue into their rate limits.
      for (const group of chunk(urls, PER_REQUEST)) {
        const response = await fetch('/api/v1/prospects/by-url', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ urls: group }),
        });

        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          setError(payload?.error?.message ?? `that failed (${response.status})`);
          break;
        }

        if (payload.batchId) ids.push(payload.batchId as string);
        queuedTotal += Number(payload.queued ?? 0);
        duplicateTotal += (payload.duplicates as string[] | undefined)?.length ?? 0;
        if (Array.isArray(payload.rejected)) rejectedAll.push(...(payload.rejected as Rejected[]));
      }

      setQueued(queuedTotal);
      setDuplicates(duplicateTotal);
      setRejected(rejectedAll);
      setBatchIds(ids);
      if (ids.length > 0) setText('');
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Puts the failures back in the box.
   *
   * A hundred URLs where six failed is not a run to repeat — it is six URLs to
   * try again, and retyping them by hand is how people give up on a batch.
   */
  function retryFailed() {
    const failed = tracked
      .flatMap((batch) => batch.items)
      .filter((item) => item.status === 'failed')
      .map((item) => item.url)
      .filter((url): url is string => !!url);

    setText(failed.join('\n'));
    setBatchIds([]);
    setBatches({});
  }

  const count = parseUrls(text).length;
  const groups = Math.ceil(count / PER_REQUEST);
  const failedCount = tracked.reduce((sum, batch) => sum + batch.failed, 0);

  return (
    <form onSubmit={submit} className="border-border bg-surface-raised rounded-2xl border p-4">
      <label htmlFor="urls" className="text-sm font-medium">
        Company websites
      </label>
      <p className="text-ink-muted mt-1 text-xs">
        One URL per line — paste as many as you like. We read each homepage, work out who is worth
        talking to, and queue them for approval.
      </p>

      <textarea
        id="urls"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={10}
        placeholder={'stripe.com\nvercel.com\nlinear.app'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="border-border bg-surface mt-3 w-full rounded-xl border px-3 py-3 font-mono text-[13px]"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || count === 0}
          className="bg-accent shrink-0 rounded-xl px-4 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Queueing…' : count > 1 ? `Add ${count} sites` : 'Add site'}
        </button>

        <label className="border-border text-ink-muted cursor-pointer rounded-xl border px-4 py-3 text-sm font-medium">
          Upload a list
          <input
            ref={fileInput}
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            onChange={(event) => void readFile(event)}
            className="hidden"
          />
        </label>

        {/* Over the per-request ceiling is a fact about the plumbing, not an
            error the operator has to solve by editing their list. */}
        {groups > 1 ? (
          <span className="text-ink-muted text-xs">
            {count} URLs · sent as {groups} batches
          </span>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-hot mt-3 text-sm">
          {error}
        </p>
      ) : null}

      {batchIds.length > 0 ? (
        <p className="text-ink-muted mt-3 text-sm">
          {[
            `${queued} queued`,
            ...(duplicates > 0 ? [`${duplicates} already queued`] : []),
            ...(rejected.length > 0 ? [`${rejected.length} not usable`] : []),
          ].join(' · ')}
        </p>
      ) : null}

      {rejected.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {rejected.map((entry) => (
            <li key={entry.url} className="text-xs">
              <span className="font-mono">{entry.url}</span>
              <span className="text-ink-muted ml-2">{entry.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {tracked.length > 0 ? (
        <Progress
          batches={tracked}
          settled={settled}
          failedCount={failedCount}
          onRetryFailed={retryFailed}
        />
      ) : null}
    </form>
  );
}

function Progress({
  batches,
  settled,
  failedCount,
  onRetryFailed,
}: {
  batches: readonly Batch[];
  settled: boolean;
  failedCount: number;
  onRetryFailed: () => void;
}) {
  const total = batches.reduce((sum, batch) => sum + batch.total, 0);
  const finished = batches.reduce((sum, batch) => sum + batch.done + batch.failed, 0);
  const percent = total === 0 ? 0 : Math.round((finished / total) * 100);

  const failures = batches
    .flatMap((batch) => batch.items)
    .filter((item) => item.status === 'failed');

  return (
    <div className="border-border mt-4 border-t pt-4">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">
          {settled ? 'Finished' : 'Working'} — {finished} of {total}
        </span>
        <span className="text-ink-muted font-mono">{percent}%</span>
      </div>

      <div className="bg-border mt-2 h-1.5 overflow-hidden rounded-full">
        <div
          className="bg-accent h-full rounded-full transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Only the ones that went wrong. A list of nine hundred successes is
          noise; the failures are the reason anyone watches this. */}
      {failures.length > 0 ? (
        <>
          <ul className="mt-3 flex flex-col gap-1.5">
            {failures.map((item) => (
              <li key={item.id} className="text-xs">
                <span className="font-mono">{item.url ?? item.id}</span>
                <span className="text-hot ml-2">{item.lastError ?? 'failed'}</span>
              </li>
            ))}
          </ul>

          {settled ? (
            <button
              type="button"
              onClick={onRetryFailed}
              className="border-border mt-3 rounded-xl border px-4 py-2 text-sm font-medium"
            >
              Put the {failedCount} that failed back in the box
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
