'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

/**
 * Add prospects from company URLs (PRD §8, URL-first intake).
 *
 * Unlike the handle form beside it, nothing happens while you wait: the API
 * answers 202 with a batch id and the crawling happens on the worker. So this
 * reports progress rather than a result, and keeps reporting until the batch
 * is done — a spinner that resolves to nothing was the old behaviour of an
 * empty app, and a hundred URLs takes long enough that silence reads as a
 * failure.
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

const POLL_MS = 3000;

export function AddByUrl() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [batchId, setBatchId] = useState<string | undefined>();
  const [batch, setBatch] = useState<Batch | undefined>();

  const settled = batch ? batch.pending === 0 && batch.running === 0 : false;

  /**
   * Polls while anything is outstanding, and stops as soon as nothing is.
   * The cleanup matters: without it, navigating away leaves a timer calling an
   * endpoint for a batch nobody is looking at.
   */
  useEffect(() => {
    if (!batchId || settled) return;

    let cancelled = false;

    const tick = async () => {
      try {
        const response = await fetch(`/api/v1/batches/${batchId}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) return;
        const payload = (await response.json()) as Batch;
        if (!cancelled) setBatch(payload);
      } catch {
        // A dropped poll is not worth surfacing; the next one will say the
        // same thing a moment later.
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [batchId, settled]);

  // Once everything has landed, the prospect list behind this form is stale.
  useEffect(() => {
    if (settled) router.refresh();
  }, [settled, router]);

  async function submit(event: FormEvent) {
    event.preventDefault();

    const urls = text
      .split(/[\s,]+/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (urls.length === 0) return;

    setBusy(true);
    setError(undefined);
    setNote(undefined);
    setBatch(undefined);
    setBatchId(undefined);

    try {
      const response = await fetch('/api/v1/prospects/by-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ urls }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      const parts = [`${payload.queued} queued`];
      if (payload.duplicates?.length) parts.push(`${payload.duplicates.length} already queued`);
      if (payload.rejected?.length) parts.push(`${payload.rejected.length} not usable`);

      setNote(parts.join(' · '));
      setBatchId(payload.batchId);
      setText('');
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  const count = text.split(/[\s,]+/).filter(Boolean).length;

  return (
    <form onSubmit={submit} className="border-border bg-surface-raised rounded-2xl border p-4">
      <label htmlFor="urls" className="text-sm font-medium">
        Add from company websites
      </label>
      <p className="text-ink-muted mt-1 text-xs">
        One URL per line, up to 100. We read each homepage, work out who is worth talking to, and
        queue them for approval.
      </p>

      <textarea
        id="urls"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={'stripe.com\nvercel.com'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="border-border bg-surface mt-3 w-full rounded-xl border px-3 py-3 font-mono text-[13px]"
      />

      <div className="mt-3 flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || count === 0}
          className="bg-accent shrink-0 rounded-xl px-4 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Queueing…' : count > 1 ? `Add ${count} sites` : 'Add site'}
        </button>
        {count > 100 ? (
          <span className="text-hot text-xs">{count} URLs — the limit is 100</span>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-hot mt-3 text-sm">
          {error}
        </p>
      ) : null}

      {note ? <p className="text-ink-muted mt-3 text-sm">{note}</p> : null}

      {batch ? <BatchProgress batch={batch} settled={settled} /> : null}
    </form>
  );
}

function BatchProgress({ batch, settled }: { batch: Batch; settled: boolean }) {
  const finished = batch.done + batch.failed;
  const percent = batch.total === 0 ? 0 : Math.round((finished / batch.total) * 100);

  return (
    <div className="border-border mt-4 border-t pt-4">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">
          {settled ? 'Finished' : 'Working'} — {finished} of {batch.total}
        </span>
        <span className="text-ink-muted font-mono">{percent}%</span>
      </div>

      <div className="bg-border mt-2 h-1.5 overflow-hidden rounded-full">
        <div
          className="bg-accent h-full rounded-full transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Only the ones that went wrong. A list of ninety-nine successes is
          noise; the failures are the reason anyone opens this. */}
      {batch.failed > 0 ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {batch.items
            .filter((item) => item.status === 'failed')
            .map((item) => (
              <li key={item.id} className="text-xs">
                <span className="font-mono">{item.url ?? item.id}</span>
                <span className="text-hot ml-2">{item.lastError ?? 'failed'}</span>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
