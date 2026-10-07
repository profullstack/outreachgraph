'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Switching the planner on or off for one product. */
export function PlannerToggle({ offeringId, enabled }: { offeringId: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle(): Promise<void> {
    setBusy(true);
    try {
      await fetch(`/api/v1/planner/offerings/${encodeURIComponent(offeringId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ enabled: !enabled }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      className="border-border text-ink-muted min-h-[36px] shrink-0 rounded-xl border px-3 text-xs disabled:opacity-50"
    >
      {busy ? '…' : enabled ? 'Turn off' : 'Turn on'}
    </button>
  );
}

/** Launches this month's plays now instead of on the next hourly sweep. */
export function PlannerRunButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>();

  async function run(): Promise<void> {
    setBusy(true);
    setNote(undefined);
    try {
      const response = await fetch('/api/v1/planner/run', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const body = (await response.json().catch(() => ({}))) as {
        launched?: Array<{ playKey: string; people: number; campaignId?: string }>;
      };
      const launched = (body.launched ?? []).filter((play) => play.campaignId);
      setNote(
        launched.length === 0
          ? 'Nothing new: this month’s plays already ran, or nobody fits them yet.'
          : `Launched ${launched.length} play${launched.length === 1 ? '' : 's'} to ${launched.reduce((sum, play) => sum + play.people, 0)} people.`,
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="bg-accent min-h-[40px] rounded-xl px-4 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Running…' : 'Run now'}
      </button>
      {note ? <span className="text-ink-muted text-xs">{note}</span> : null}
    </div>
  );
}
