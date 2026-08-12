'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type State = 'idle' | 'working' | 'done' | 'failed';

/**
 * Confirms the address, then gets out of the way.
 *
 * The POST happens on mount rather than behind a button: the person already
 * expressed intent by clicking the link in their inbox, and asking them to
 * click a second time to do the thing they just asked for is friction with no
 * security value. Prefetch protection comes from this being a POST at all.
 */
export function VerifyForm({ token }: { token: string }) {
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState<string | undefined>();

  useEffect(() => {
    if (!token) {
      setState('failed');
      setMessage('That link is missing its token. Try the most recent email.');
      return;
    }

    let cancelled = false;
    setState('working');

    (async () => {
      try {
        const response = await fetch('/api/v1/auth/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ token }),
        });

        if (cancelled) return;

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          setState('failed');
          setMessage(body?.error?.message ?? 'that link is invalid or has expired');
          return;
        }

        setState('done');
      } catch {
        if (!cancelled) {
          setState('failed');
          setMessage('could not reach the server');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state === 'done') {
    return (
      <div className="border-border rounded-2xl border p-4">
        <p className="text-sm font-medium">Confirmed.</p>
        <p className="text-ink-muted mt-1 text-sm">
          Your address is verified and outreach is unlocked.
        </p>
        <Link
          href="/today"
          className="bg-accent mt-4 inline-flex items-center justify-center rounded-xl px-5 py-3 text-sm font-medium text-white"
        >
          Go to Today
        </Link>
      </div>
    );
  }

  if (state === 'failed') {
    return (
      <div className="border-border rounded-2xl border p-4">
        <p role="alert" className="text-hot text-sm">
          {message}
        </p>
        <p className="text-ink-muted mt-2 text-sm">
          Sign in and use “Resend” to get a fresh link — each one supersedes the last.
        </p>
        <Link href="/login" className="text-accent mt-3 inline-block text-sm underline">
          Sign in
        </Link>
      </div>
    );
  }

  return <p className="text-ink-muted text-sm">Confirming…</p>;
}
