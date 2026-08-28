'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Accepting an invitation, once there is an account to attach it to.
 *
 * Deliberately a button rather than something that fires on page load. The
 * link arrives by email, and mail clients and scanners follow links in the
 * background — an invitation that accepted itself on GET would be accepted by
 * a link preview before its recipient ever saw it.
 */
export function JoinInvitation({ token, organization }: { token: string; organization: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function join(): Promise<void> {
    setBusy(true);
    setError(undefined);

    try {
      const response = await fetch(`/api/v1/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      // The API re-pins the session onto the workspace just joined, so a plain
      // refresh is what makes the rest of the app show the new account.
      router.replace('/today');
      router.refresh();
    } catch {
      setError('could not reach the server');
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void join()}
        disabled={busy}
        className="bg-accent w-full rounded-xl px-4 py-3 text-sm font-medium text-white disabled:opacity-40"
      >
        {busy ? 'Joining…' : `Join ${organization}`}
      </button>

      {error ? (
        <p role="alert" className="text-hot mt-3 text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
