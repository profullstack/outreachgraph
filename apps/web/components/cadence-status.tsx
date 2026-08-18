'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Starting, pausing and archiving a plan.
 *
 * A cadence is created as a draft on purpose. Between writing a sequence of
 * touches and agreeing that it should start reaching people there is a
 * decision, and a builder that went live on save would make that decision on
 * the user's behalf every time.
 */
export function CadenceStatus({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function set(next: string): Promise<void> {
    if (next === 'archived' && !confirm('Archive this plan? Enrolments stop advancing.')) return;

    setBusy(true);
    setError(undefined);

    try {
      const response = await fetch(`/api/v1/cadences/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ status: next }),
      });

      if (!response.ok) {
        setError(`that failed (${response.status})`);
        return;
      }

      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status !== 'active' ? (
        <button
          type="button"
          onClick={() => set('active')}
          disabled={busy}
          className="bg-accent min-h-[40px] rounded-xl px-3 text-sm font-medium text-white disabled:opacity-50"
        >
          {status === 'paused' ? 'Resume' : 'Start'}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => set('paused')}
          disabled={busy}
          className="border-border min-h-[40px] rounded-xl border px-3 text-sm disabled:opacity-50"
        >
          Pause
        </button>
      )}

      {status !== 'archived' ? (
        <button
          type="button"
          onClick={() => set('archived')}
          disabled={busy}
          className="text-ink-muted min-h-[40px] px-2 text-sm underline disabled:opacity-50"
        >
          Archive
        </button>
      ) : null}

      {error ? <span className="text-xs text-rose-600">{error}</span> : null}
    </div>
  );
}
