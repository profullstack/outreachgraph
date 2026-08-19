'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

/**
 * Asks for a reset link.
 *
 * The confirmation deliberately does not say whether the address was found.
 * The API answers the same way either way — telling the visitor here would
 * undo that on the only screen where anyone would look.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      const response = await fetch('/api/v1/auth/password/forgot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body?.error?.message ?? 'that did not work');
        return;
      }

      setSent(true);
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="border-border rounded-2xl border p-4">
        <p className="text-sm font-medium">Check your inbox.</p>
        <p className="text-ink-muted mt-1 text-sm">
          If {email} has an account, a reset link is on its way. It expires in an hour, and you can
          ask again in a minute if nothing arrives.
        </p>
        <Link href="/login" className="text-accent mt-3 inline-block text-sm underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-ink-muted text-xs font-medium">Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="border-border bg-surface-raised rounded-xl border px-3 py-3"
        />
      </label>

      {error ? (
        <p role="alert" className="text-hot text-sm">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="bg-accent mt-1 rounded-xl px-4 text-sm font-medium text-white disabled:opacity-60"
      >
        {busy ? 'Sending…' : 'Email me a link'}
      </button>

      <Link href="/login" className="text-ink-muted text-sm underline">
        Back to sign in
      </Link>
    </form>
  );
}
