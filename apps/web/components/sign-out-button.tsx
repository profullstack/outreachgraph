'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Ends the session and returns to the public landing page. */
export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } finally {
          // Navigate regardless: a failed logout call still means the user
          // wants out of this screen, and the cookie may already be gone.
          router.replace('/');
          router.refresh();
        }
      }}
      className="border-border w-full rounded-xl border py-3 text-sm font-medium disabled:opacity-60"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
