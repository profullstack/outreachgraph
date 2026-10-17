'use client';

import { useState } from 'react';

/**
 * The product's demo video.
 *
 * A cold email that describes an automation gets skimmed and deleted; one
 * that links two minutes of it running lets a stranger judge it without a
 * call. Set here, the link goes under every first-touch email (once per
 * person) and is the one link buyer-lead replies may carry.
 */
export function ProductDemo({
  offeringId,
  demoUrl,
}: {
  offeringId: string;
  demoUrl: string | null;
}) {
  const [url, setUrl] = useState(demoUrl ?? '');
  const [saved, setSaved] = useState(demoUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  async function save(): Promise<void> {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/v1/products/${encodeURIComponent(offeringId)}/demo`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ demoUrl: url.trim() || null }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        demoUrl?: string | null;
        error?: { message?: string };
      };
      if (!response.ok) {
        setMessage(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }
      setSaved(payload.demoUrl ?? '');
      setUrl(payload.demoUrl ?? '');
      setMessage(payload.demoUrl ? 'Saved.' : 'Removed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-border bg-surface-raised mt-3 rounded-2xl border p-3">
      <h2 className="text-sm font-semibold">Demo video</h2>
      <p className="text-ink-muted text-xs">
        Show it instead of describing it. A 1&ndash;2 minute screen recording (Loom, YouTube) is
        linked under each first email, once per person, and in buyer-lead replies.
      </p>
      <input
        type="url"
        inputMode="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://www.loom.com/share/…"
        aria-label="Demo video link"
        className="border-border bg-surface mt-2 w-full rounded-xl border px-3 py-2 text-sm"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || url.trim() === saved}
          onClick={() => void save()}
          className="bg-accent rounded-xl px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          Save
        </button>
        <span className="text-ink-muted text-xs">
          {message ?? (saved ? '' : 'None yet: first emails describe the product in words.')}
        </span>
      </div>
    </section>
  );
}
