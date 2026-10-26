'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

async function post(path: string) {
  const response = await fetch(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: '{}',
  });
  const json = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
    run?: { runId: string };
  };
  if (!response.ok) throw new Error(json.error?.message ?? `request failed (${response.status})`);
  return json;
}

/**
 * Stop a run (or its pending retry), or resume one that stopped. Resuming
 * reuses the run's slot, so steps that already changed something are replayed
 * from their record instead of being repeated.
 */
export function WorkflowRunActions({
  workflowId,
  runId,
  status,
}: {
  workflowId: string;
  runId: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}`;

  async function act(path: string, next?: (runId: string) => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await post(path);
      if (next && result.run) next(result.run.runId);
      else router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const cancellable = status === 'running' || status === 'retry_scheduled';
  const resumable = ['failed', 'cancelled', 'dead_letter', 'retry_scheduled'].includes(status);
  if (!cancellable && !resumable) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {cancellable ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(`${base}/cancel`)}
          className="border-border min-h-[44px] rounded-xl border px-4 text-sm font-medium disabled:opacity-50"
        >
          Stop
        </button>
      ) : null}
      {resumable ? (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(`${base}/resume`, (id) => router.push(`/workflows/${workflowId}/runs/${id}`))
          }
          className="bg-accent min-h-[44px] rounded-xl px-4 text-sm font-medium text-white disabled:opacity-50"
        >
          Resume this run
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="w-full text-sm text-rose-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Brings an old version back as the newest; history is never rewritten. */
export function RestoreVersion({ workflowId, version }: { workflowId: string; version: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await post(`/workflows/${encodeURIComponent(workflowId)}/versions/${version}/restore`);
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
      className="text-accent min-h-[36px] text-xs underline disabled:opacity-50"
    >
      {busy ? '…' : 'Restore'}
    </button>
  );
}
