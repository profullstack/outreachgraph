'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ProfileFields } from '@profullstack/profile/react';
import { CoinpaySignInButton } from './coinpay-sign-in';

/** Asked for when creating an account, beside the email box; never on sign-in. */
const SIGNUP_FIELDS = [
  'first_name',
  'last_name',
  'company_domain',
  'job_title',
  'linkedin_url',
] as const;

/**
 * Sign in / create account.
 *
 * Posts to the API from the browser so the `Set-Cookie` lands on the user's
 * own session, then reloads server components to pick it up. Same-origin,
 * because the API is served from this container under /api.
 *
 * `next` exists for the invitation flow: somebody arriving on a `/join` link
 * has to sign in or sign up first, and landing them on Today afterwards
 * abandons the invitation they came to accept. Callers pass a path; the login
 * page validates the one it reads from the query string before passing it
 * here, so this component cannot be pointed at another origin.
 */
export function LoginForm({
  next = '/inbox',
  invite,
  initialMode = 'login',
}: {
  next?: string;
  /** An /i/<code> invite: sent with a new account so it counts on any device. */
  invite?: string;
  initialMode?: 'login' | 'register';
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const profile =
      mode === 'register'
        ? Object.fromEntries(SIGNUP_FIELDS.map((f) => [f, form.get(f) ?? '']))
        : {};

    try {
      const response = await fetch(`/api/v1/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The session cookie is set by this response.
        credentials: 'same-origin',
        body: JSON.stringify({
          email,
          password,
          ...profile,
          ...(mode === 'register' && invite ? { invite } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setFieldErrors(body?.error?.details?.fields ?? {});
        setError(body?.error?.message ?? 'that did not work');
        return;
      }

      router.replace(next);
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <CoinpaySignInButton next={next} mode={mode} />
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

      {mode === 'register' ? (
        <ProfileFields fields={SIGNUP_FIELDS} errors={fieldErrors} idPrefix="signup-" />
      ) : null}

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
        ) : (
          // Only when signing in. Offering a reset to someone in the middle of
          // choosing a password reads as an error message.
          <Link href="/forgot" className="text-ink-muted self-start text-xs underline">
            Forgot your password?
          </Link>
        )}
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
          setFieldErrors({});
        }}
        className="text-ink-muted text-sm underline"
      >
        {mode === 'login' ? 'Create an account instead' : 'I already have an account'}
      </button>
    </form>
  );
}
