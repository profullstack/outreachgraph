'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

/**
 * One campaign per product, for a workspace that sells many.
 *
 * The intake above starts one run for one product, and setting up a product
 * is a form per site. Someone with a portfolio of fifty sites was looking at a
 * hundred forms. This takes the list of *their own* sites instead: each one is
 * read, described, saved as a product and given a campaign that is already
 * searching for buyers — on the worker, because each is half a minute of
 * model time.
 *
 * Every site is listed with its state rather than only a progress bar. With a
 * few dozen products the question is which ones are set up, and which one
 * could not be read.
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

interface Existing {
  domain: string;
  offeringId: string;
  name: string;
}

const POLL_MS = 4000;

const STATUS_LABEL: Record<BatchItem['status'], string> = {
  pending: 'waiting',
  running: 'reading the site',
  done: 'searching for buyers',
  failed: 'failed',
};

function count(text: string): number {
  return text.split(/[\s,;]+/).filter((entry) => entry.trim()).length;
}

function hostOf(url: string | undefined): string {
  return (url ?? '').replace(/^https?:\/\//, '');
}

export function BulkProductIntake() {
  const router = useRouter();

  const [text, setText] = useState('');
  const [autopilot, setAutopilot] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [existing, setExisting] = useState<Existing[]>([]);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [batchId, setBatchId] = useState<string | undefined>();
  const [batch, setBatch] = useState<Batch | undefined>();

  const settled = !!batch && batch.pending + batch.running === 0;

  // Polls until every site has settled, and stops when this form goes away.
  useEffect(() => {
    if (!batchId || settled) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const response = await fetch(`/api/v1/batches/${batchId}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok || cancelled) return;
        setBatch((await response.json()) as Batch);
      } catch {
        // The next poll is a few seconds away and will say the same thing.
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [batchId, settled]);

  // The campaign list below is stale once the products exist.
  useEffect(() => {
    if (settled) router.refresh();
  }, [settled, router]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (count(text) === 0) return;

    setBusy(true);
    setError(undefined);
    setExisting([]);
    setInvalid([]);
    setBatchId(undefined);
    setBatch(undefined);

    try {
      const response = await fetch('/api/v1/campaigns/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ domains: text, autopilot }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setExisting((payload.existing as Existing[] | undefined) ?? []);
      setInvalid((payload.invalid as string[] | undefined) ?? []);
      if ((payload.queued as string[] | undefined)?.length) setBatchId(payload.batchId as string);
      setText('');
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  function retryFailed() {
    const failed = (batch?.items ?? [])
      .filter((item) => item.status === 'failed')
      .map((item) => hostOf(item.url));
    setText(failed.join('\n'));
    setBatchId(undefined);
    setBatch(undefined);
  }

  const n = count(text);
  const finished = batch ? batch.done + batch.failed : 0;

  return (
    <form onSubmit={submit} className="border-border bg-surface-raised rounded-2xl border p-4">
      <label htmlFor="product-sites" className="text-sm font-medium">
        Your sites
      </label>
      <p className="text-ink-muted mt-1 text-xs">
        One per line, up to a hundred. Each becomes a product with its own campaign: we read the
        site, describe what it sells and who buys it, and start finding those buyers. Sites that are
        already a product here are skipped.
      </p>

      <textarea
        id="product-sites"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={8}
        placeholder={'ugig.net\nnichedb.dev\nbl0ggers.com'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="border-border bg-surface mt-3 w-full rounded-xl border px-3 py-3 font-mono text-[13px]"
      />

      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={autopilot}
          onChange={(e) => setAutopilot(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Run them on autopilot</span>
          <span className="text-ink-muted block text-[13px] leading-relaxed">
            Every campaign finds people and writes to them without asking. Leave this off to approve
            each message yourself.
          </span>
        </span>
      </label>

      <button
        type="submit"
        disabled={busy || n === 0}
        className="bg-accent mt-3 rounded-xl px-4 py-3 text-sm font-medium text-white disabled:opacity-40"
      >
        {busy ? 'Queueing…' : n > 1 ? `Start ${n} campaigns` : 'Start campaign'}
      </button>

      {error ? (
        <p role="alert" className="text-hot mt-3 text-sm">
          {error}
        </p>
      ) : null}

      {existing.length > 0 ? (
        <p className="text-ink-muted mt-3 text-xs">
          Already products here, left as they are:{' '}
          <span className="font-mono">{existing.map((p) => p.domain).join(', ')}</span>
        </p>
      ) : null}

      {invalid.length > 0 ? (
        <p className="text-ink-muted mt-2 text-xs">
          Not websites, ignored: <span className="font-mono">{invalid.join(', ')}</span>
        </p>
      ) : null}

      {batch ? (
        <div className="border-border mt-4 border-t pt-4">
          <p className="text-xs font-medium">
            {settled ? 'Finished' : 'Working'} — {finished} of {batch.total} set up
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {batch.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-mono">{hostOf(item.url)}</span>
                <span
                  className={
                    item.status === 'failed'
                      ? 'text-hot'
                      : item.status === 'done'
                        ? 'text-good'
                        : 'text-ink-muted'
                  }
                >
                  {STATUS_LABEL[item.status]}
                  {item.status === 'failed' && item.lastError ? ` — ${item.lastError}` : ''}
                </span>
              </li>
            ))}
          </ul>

          {settled && batch.failed > 0 ? (
            <button
              type="button"
              onClick={retryFailed}
              className="border-border mt-3 rounded-xl border px-4 py-2 text-sm font-medium"
            >
              Put the {batch.failed} that failed back in the box
            </button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
