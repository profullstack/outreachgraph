'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Switching one rule on or off without deleting what it has already done. */
export function RuleToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle(): Promise<void> {
    setBusy(true);

    try {
      await fetch(`/api/v1/rules/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
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
