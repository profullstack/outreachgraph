'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface InvitationForMe {
  id: string;
  organizationName: string;
  role: string;
  invitedBy: string | null;
}

/**
 * Team invitations addressed to the signed-in user.
 *
 * The emailed link used to be the only way in, so an invitation that landed in
 * spam — or in an alias nobody reads — left someone who already had an account
 * with no way to know they had been asked. The API matches these on the
 * account's verified address, which is why accepting here needs no token.
 *
 * Renders nothing until there is something to show: a failed fetch is not
 * worth a banner of its own on every page.
 */
export function PendingInvitations() {
  const router = useRouter();
  const [invitations, setInvitations] = useState<InvitationForMe[]>([]);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let live = true;

    fetch('/api/v1/me/invitations', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { invitations: [] }))
      .then((payload: { invitations?: InvitationForMe[] }) => {
        if (live) setInvitations(payload.invitations ?? []);
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, []);

  async function join(id: string): Promise<void> {
    setBusy(id);
    setError(undefined);

    try {
      const response = await fetch(`/api/v1/me/invitations/${encodeURIComponent(id)}/accept`, {
        method: 'POST',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        setBusy(undefined);
        return;
      }

      // Same as the emailed link: the API re-pins the session onto the
      // workspace just joined, and a refresh shows it.
      setInvitations((current) => current.filter((invitation) => invitation.id !== id));
      setBusy(undefined);
      router.replace('/inbox');
      router.refresh();
    } catch {
      setError('could not reach the server');
      setBusy(undefined);
    }
  }

  if (invitations.length === 0) return null;

  return (
    <section className="mb-4 space-y-2">
      {invitations.map((invitation) => (
        <div
          key={invitation.id}
          className="border-border bg-surface-raised flex items-center justify-between gap-3 rounded-2xl border p-4"
        >
          <div className="min-w-0 text-sm">
            <div className="font-medium">
              {invitation.invitedBy ?? 'A teammate'} invited you to their team
            </div>
            <div className="text-ink-muted truncate text-xs">
              {invitation.organizationName} · {invitation.role}
            </div>
          </div>

          <button
            type="button"
            onClick={() => void join(invitation.id)}
            disabled={busy !== undefined}
            className="bg-accent shrink-0 rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy === invitation.id ? 'Joining…' : 'Join'}
          </button>
        </div>
      ))}

      {error ? (
        <p role="alert" className="text-hot text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}
