'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The two switches a running product needs: autopilot and pause.
 *
 * Separate on purpose, as on the campaign list: autopilot off still researches
 * and drafts, and only waits for approval; paused stops the work entirely.
 */
export function CampaignControls({
  campaignId,
  autopilot: initialAutopilot,
  status: initialStatus,
}: {
  campaignId: string;
  autopilot: boolean;
  status: string;
}) {
  const router = useRouter();
  const [autopilot, setAutopilot] = useState(initialAutopilot);
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function patch(body: { autopilot?: boolean; status?: string }) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/campaigns/${encodeURIComponent(campaignId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }
      if (typeof body.autopilot === 'boolean') setAutopilot(body.autopilot);
      if (body.status) setStatus(body.status);
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  if (status === 'archived') {
    return <p className="text-ink-muted text-sm">Archived. Nothing runs for this product.</p>;
  }

  const paused = status === 'paused';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={autopilot}
        disabled={busy}
        onClick={() => void patch({ autopilot: !autopilot })}
        className={`rounded-full border px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${
          autopilot ? 'border-accent bg-accent text-white' : 'border-border text-ink-muted'
        }`}
      >
        Autopilot {autopilot ? 'on' : 'off'}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void patch({ status: paused ? 'active' : 'paused' })}
        className="border-border rounded-full border px-3 py-1.5 text-sm font-medium disabled:opacity-40"
      >
        {paused ? 'Resume' : 'Pause'}
      </button>
      {error ? (
        <span role="alert" className="text-hot text-xs">
          {error}
        </span>
      ) : null}
    </div>
  );
}
