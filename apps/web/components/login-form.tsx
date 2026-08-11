'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

/**
 * Sign in / create account.
 *
 * Posts to the API from the browser so the `Set-Cookie` lands on the user's
 * own session, then reloads server components to pick it up. Same-origin,
 * because the API is served from this container under /api.
 */
export function LoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      const response = await fetch(`/api/v1/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The session cookie is set by this response.
        credentials: 'same-origin',
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body?.error?.message ?? 'that did not work');
        return;
      }

      router.replace('/today');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-ink-muted text-xs font-medium">Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="border-border bg-surface-raised rounded-xl border px-3 py-3"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-ink-muted text-xs font-medium">Password</span>
        <input
          type="password"
          required
          minLength={mode === 'register' ? 12 : 1}
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border-border bg-surface-raised rounded-xl border px-3 py-3"
        />
        {mode === 'register' ? (
          <span className="text-ink-muted text-xs">At least 12 characters.</span>
        ) : null}
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
        {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode(mode === 'login' ? 'register' : 'login');
          setError(undefined);
        }}
        className="text-ink-muted text-sm underline"
      >
        {mode === 'login' ? 'Create an account instead' : 'I already have an account'}
      </button>
    </form>
  );
}
