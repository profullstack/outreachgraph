'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CampaignReviewSuggestion } from '@outreachgraph/domain';

/** A measurable signal and a pause action that always waits for a human click. */
export function CampaignReviewCard({
  campaignId,
  suggestion,
}: {
  campaignId: string;
  suggestion: CampaignReviewSuggestion;
}) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  if (dismissed) return null;

  async function pauseForReview() {
    setBusy(true);
    setError(undefined);

    try {
      const response = await fetch(`/api/v1/campaigns/${encodeURIComponent(campaignId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ status: 'paused' }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(payload.error?.message ?? `could not pause (${response.status})`);
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
    <section className="border-amber-500/40 bg-amber-500/5 mb-6 rounded-2xl border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Campaign review suggested</h2>
          <p className="text-ink-muted mt-1 text-sm leading-relaxed">
            The campaign recorded {suggestion.emailsSent} sent emails and {suggestion.replies}{' '}
            replies in the last 30 days ({formatPercent(suggestion.replyRate)}). That is below the{' '}
            {formatPercent(suggestion.benchmarkFloor)} low end of the fresh-list benchmark. Consider
            pausing while you review the audience and message.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void pauseForReview()}
          className="bg-accent min-h-11 shrink-0 rounded-xl px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Pausing…' : 'Pause and review'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <Link href={`/funnel?campaign=${encodeURIComponent(campaignId)}`} className="underline">
          See campaign results
        </Link>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-ink-muted min-h-11 underline underline-offset-2"
        >
          Keep running for now
        </button>
      </div>

      {error ? (
        <p role="alert" className="text-hot mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value === 0 ? 0 : 1)}%`;
}
