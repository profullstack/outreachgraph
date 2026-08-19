'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Clearing the queue in one press.
 *
 * Two presses, in fact, and the first one is the point. A control that can put
 * mail on the wire for two hundred people should not fire on a single click
 * next to the per-card buttons, so this asks the server what *would* happen
 * first — the same policy engine, run with `dryRun` — and shows the answer
 * before anything is written.
 *
 * That preview is not a courtesy. The interesting outcome here is usually not
 * "approved 200": it is "approved 25, held 34, all behind four shared
 * inboxes", and a reviewer who pressed the button expecting the first number
 * and got the second has no way to tell whether the product is broken. Showing
 * it up front makes the hold the expected result rather than a surprise.
 */

interface BulkResult {
  readonly dryRun: boolean;
  readonly attempted: number;
  readonly approved: number;
  readonly held: number;
  readonly sent: number;
  readonly researchQueued: number;
  readonly holds: readonly { gate: string; reason: string; count: number }[];
  readonly more: boolean;
}

export function ApproveAll({
  filter,
  channel,
  pending,
}: {
  filter: string;
  channel: string;
  /** How many cards the current view holds, for the button's label. */
  pending: number;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<BulkResult | undefined>();
  const [done, setDone] = useState<BulkResult | undefined>();
  const [busy, setBusy] = useState<'preview' | 'run' | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function call(dryRun: boolean): Promise<BulkResult | undefined> {
    const response = await fetch('/api/v1/recommendations/approve-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filter, channel, dryRun }),
    });

    const body = (await response.json()) as BulkResult & { error?: { message?: string } };

    if (!response.ok) {
      setError(body.error?.message ?? `that failed (${response.status})`);
      return undefined;
    }

    return body;
  }

  async function onPreview(): Promise<void> {
    setBusy('preview');
    setError(undefined);
    setDone(undefined);

    const result = await call(true);
    if (result) setPreview(result);
    setBusy(undefined);
  }

  async function onRun(): Promise<void> {
    setBusy('run');
    setError(undefined);

    const result = await call(false);

    if (result) {
      setDone(result);
      setPreview(undefined);
      // The queue behind this is a server component, so the list and the
      // counts both come back correct without a full reload.
      router.refresh();
    }

    setBusy(undefined);
  }

  if (pending === 0 && !done) return null;

  return (
    <section className="border-border mb-4 rounded-2xl border p-3">
      {done ? (
        <div className="text-sm">
          <p>
            Approved {done.approved.toLocaleString()}
            {done.sent > 0 ? `, sent ${done.sent.toLocaleString()}` : ''}
            {done.researchQueued > 0 ? `, queued ${done.researchQueued} for research` : ''}
            {done.held > 0 ? `, held ${done.held.toLocaleString()}` : ''}.
          </p>
          <Holds holds={done.holds} />
          {done.more ? (
            <button
              type="button"
              onClick={() => void onPreview()}
              className="border-border mt-2 rounded-xl border px-3 py-2 text-sm font-medium"
            >
              More remain — carry on
            </button>
          ) : null}
        </div>
      ) : preview ? (
        <div className="text-sm">
          <p className="font-medium">
            {preview.approved > 0
              ? `This will approve ${preview.approved.toLocaleString()} card${preview.approved === 1 ? '' : 's'}.`
              : 'Nothing here can be approved right now.'}
          </p>
          {preview.held > 0 ? (
            <p className="text-ink-muted">
              {preview.held.toLocaleString()} will be held by policy and stay in the queue.
            </p>
          ) : null}
          <Holds holds={preview.holds} />

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void onRun()}
              disabled={busy !== undefined || preview.approved === 0}
              className="border-border rounded-xl border px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              {busy === 'run' ? 'Approving…' : `Approve ${preview.approved.toLocaleString()}`}
            </button>
            <button
              type="button"
              onClick={() => setPreview(undefined)}
              disabled={busy !== undefined}
              className="text-ink-muted px-3 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm">
            <div className="font-medium">Approve everything here</div>
            <div className="text-ink-muted text-xs">
              Runs the same checks as approving one at a time. Shows you what it will do first.
            </div>
          </div>
          <button
            type="button"
            onClick={() => void onPreview()}
            disabled={busy !== undefined}
            className="border-border shrink-0 rounded-xl border px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy === 'preview' ? 'Checking…' : 'Approve all'}
          </button>
        </div>
      )}

      {error ? (
        <p role="alert" className="text-hot mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** Why the held ones were held, grouped rather than listed per card. */
function Holds({ holds }: { holds: readonly { gate: string; reason: string; count: number }[] }) {
  if (holds.length === 0) return null;

  return (
    <ul className="text-ink-muted mt-2 flex flex-col gap-1 text-xs">
      {holds.map((hold) => (
        <li key={hold.gate}>
          <span className="font-medium">{hold.count}×</span> {hold.reason}
        </li>
      ))}
    </ul>
  );
}
