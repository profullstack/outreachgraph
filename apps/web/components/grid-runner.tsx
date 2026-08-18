'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Advancing a grid, on purpose rather than on a timer.
 *
 * A grid is the one place a user can spend a lot of model budget in one
 * action, so it moves when somebody asks it to and reports how far it got.
 * Running it automatically in the background would make the cost invisible at
 * exactly the moment it matters.
 *
 * Safe to press repeatedly: the runner resumes from the cells that are still
 * unanswered and never re-answers one.
 */
export function GridRunner({ id, remaining }: { id: string; remaining: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function run(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNote(undefined);

    try {
      const response = await fetch(`/api/v1/grids/${encodeURIComponent(id)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ limit: 25 }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        answered?: number;
        noEvidence?: number;
        remaining?: number;
        status?: string;
        error?: { message?: string };
      };

      if (!response.ok) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setNote(
        `${payload.answered ?? 0} answered, ${payload.noEvidence ?? 0} with nothing to go on, ${payload.remaining ?? 0} left.`,
      );
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  if (remaining === 0) {
    return <p className="text-ink-muted text-xs">Every cell has been answered.</p>;
  }

  return (
    <div>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="bg-accent min-h-[44px] rounded-xl px-4 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Working…' : `Answer up to 25 of ${remaining}`}
      </button>

      {note ? <p className="text-ink-muted mt-2 text-xs">{note}</p> : null}
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}
