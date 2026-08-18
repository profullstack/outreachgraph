'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CadenceRowView } from '../lib/api';

/**
 * Putting one prospect on a plan.
 *
 * Only active plans are offered. A draft is a plan somebody has not agreed to
 * run yet, and enrolling into one would produce an enrolment that sits there
 * doing nothing with no indication why.
 *
 * "Already on this plan" comes back as its own answer rather than an error,
 * because it is a fact about the world and not a failed request — and the
 * honest response to a double-tap is to say so, not to enrol them twice.
 */
export function EnrolButton({
  personId,
  campaignId,
  cadences,
}: {
  personId: string;
  campaignId: string | null;
  cadences: CadenceRowView[];
}) {
  const router = useRouter();
  const active = cadences.filter((cadence) => cadence.status === 'active');

  const [cadenceId, setCadenceId] = useState(active[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  if (active.length === 0) return null;

  async function enrol(): Promise<void> {
    if (!campaignId) {
      setError('this prospect is not in a campaign yet');
      return;
    }

    setBusy(true);
    setError(undefined);
    setNote(undefined);

    try {
      const response = await fetch(`/api/v1/cadences/${encodeURIComponent(cadenceId)}/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ personId, campaignId }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        enrolled?: boolean;
        reason?: string;
        firstDueAt?: string;
        error?: { message?: string };
      };

      if (response.status === 409) {
        setNote(payload.reason ?? 'already on this plan');
        return;
      }

      if (!response.ok) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setNote('On the plan. The first step is queued.');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-border bg-surface-raised mt-6 rounded-2xl border p-4">
      <h2 className="text-sm font-semibold">Put them on a plan</h2>

      <div className="mt-3 flex flex-wrap gap-2">
        <select
          aria-label="Plan"
          value={cadenceId}
          onChange={(e) => setCadenceId(e.target.value)}
          className="border-border bg-surface min-h-[44px] flex-1 rounded-xl border px-3"
        >
          {active.map((cadence) => (
            <option key={cadence.id} value={cadence.id}>
              {cadence.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={enrol}
          disabled={busy || !cadenceId}
          className="bg-accent min-h-[44px] rounded-xl px-4 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Enrol'}
        </button>
      </div>

      {note ? <p className="text-ink-muted mt-2 text-xs">{note}</p> : null}
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </section>
  );
}
