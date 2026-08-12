'use client';

import { useState } from 'react';

/**
 * Tells an unverified account why approving will fail, before they try.
 *
 * Discovering a gate by being refused mid-task is the worst way to learn
 * about it, so this states the limit up front and offers the one action that
 * clears it.
 */
export function VerifyBanner({ email }: { email: string | null }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  async function resend() {
    setState('sending');
    try {
      const response = await fetch('/api/v1/auth/verify/resend', {
        method: 'POST',
        credentials: 'same-origin',
      });
      setState(response.ok ? 'sent' : 'failed');
    } catch {
      setState('failed');
    }
  }

  return (
    <div className="border-hot/40 bg-hot/5 mb-4 rounded-2xl border p-3">
      <p className="text-sm font-medium">Confirm your email to send anything.</p>
      <p className="text-ink-muted mt-1 text-sm">
        Research, signals and drafts all work now. Approving outreach needs a confirmed address
        {email ? ` — we sent a link to ${email}` : ''}.
      </p>

      {state === 'sent' ? (
        <p className="text-ink-muted mt-2 text-xs">Sent. The newest link is the one that works.</p>
      ) : (
        <button
          type="button"
          onClick={resend}
          disabled={state === 'sending'}
          className="text-accent mt-2 text-sm underline disabled:opacity-40"
        >
          {state === 'sending' ? 'Sending…' : 'Resend the link'}
        </button>
      )}

      {state === 'failed' ? (
        <p role="alert" className="text-hot mt-2 text-xs">
          Could not send it. Try again in a moment.
        </p>
      ) : null}
    </div>
  );
}
