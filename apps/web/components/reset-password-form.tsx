'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

/**
 * Chooses a new password against a token from the emailed link.
 *
 * Unlike verification, this one waits for a button: the token is single-use
 * and consuming it on mount would burn the link before the person had typed
 * anything, leaving them with a spent token and no password. That also means a
 * mail scanner that follows the link cannot destroy it — it only ever renders
 * this form.
 *
 * On success it does not bounce to /today. The reset deleted every session for
 * the account, so there is nothing to land in; signing in is the confirmation
 * that the new password took.
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();

    // Checked here rather than at the API, which never sees the second field:
    // a typo'd new password locks someone out of their own account, and the
    // round trip would consume the token on the way.
    if (password !== confirm) {
      setError('those two passwords do not match');
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      const response = await fetch('/api/v1/auth/password/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token, password }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body?.error?.message ?? 'that link is invalid or has expired');
        return;
      }

      setDone(true);
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="border-border rounded-2xl border p-4">
        <p role="alert" className="text-hot text-sm">
          That link is missing its token.
        </p>
        <p className="text-ink-muted mt-2 text-sm">
          Ask for a fresh one — each link supersedes the last.
        </p>
        <Link href="/forgot" className="text-accent mt-3 inline-block text-sm underline">
          Email me a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="border-border rounded-2xl border p-4">
        <p className="text-sm font-medium">Password changed.</p>
        <p className="text-ink-muted mt-1 text-sm">
          Everywhere that was signed in has been signed out. Use the new password from here.
        </p>
        <Link
          href="/login"
          className="bg-accent mt-4 inline-flex items-center justify-center rounded-xl px-5 py-3 text-sm font-medium text-white"
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-ink-muted text-xs font-medium">New password</span>
        <input
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border-border bg-surface-raised rounded-xl border px-3 py-3"
        />
        <span className="text-ink-muted text-xs">At least 12 characters.</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-ink-muted text-xs font-medium">Confirm new password</span>
        <input
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
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
        {busy ? 'Saving…' : 'Set new password'}
      </button>

      <Link href="/login" className="text-ink-muted text-sm underline">
        Back to sign in
      </Link>
    </form>
  );
}
