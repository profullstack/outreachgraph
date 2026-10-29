'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * "Clear all" on the Manual posts page: skip every hand-off and open post.
 *
 * For a queue too far behind to work down by hand. Two presses, because it
 * dismisses hundreds of cards at once: the first asks, the second clears.
 */
export function ClearManualPosts({ pending }: { pending: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  if (pending === 0 && !message) return null;

  async function clear(): Promise<void> {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch('/api/v1/manual-posts/clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: '{}',
      });
      const body = (await response.json().catch(() => ({}))) as {
        cleared?: { handoffs: number; linkPosts: number };
        error?: { message?: string };
      };
      if (!response.ok || !body.cleared) {
        setMessage(body.error?.message ?? `that failed (${response.status})`);
        return;
      }
      setMessage(
        `Skipped ${body.cleared.linkPosts} post${body.cleared.linkPosts === 1 ? '' : 's'} and ${body.cleared.handoffs} hand-off${body.cleared.handoffs === 1 ? '' : 's'}.`,
      );
      setConfirming(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      {confirming ? (
        <>
          <span>Skip every post and hand-off waiting here? This cannot be undone.</span>
          <button
            type="button"
            onClick={() => void clear()}
            disabled={busy}
            className="rounded-xl border border-red-500 px-3 py-1 font-medium text-red-600 disabled:opacity-50"
          >
            {busy ? 'Clearing…' : 'Yes, clear all'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="border-border rounded-xl border px-3 py-1"
          >
            Cancel
          </button>
        </>
      ) : (
        pending > 0 && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="border-border rounded-xl border px-3 py-1 font-medium"
          >
            Clear all
          </button>
        )
      )}
      {message && <span className="text-ink-muted">{message}</span>}
    </div>
  );
}
