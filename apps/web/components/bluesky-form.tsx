'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { BlueskyIntegrationView } from '../lib/api';

/**
 * Connecting the Bluesky account public replies go out from.
 *
 * The counterpart to the mailbox form, and the same shape for the same reason:
 * the policy engine asks one question — does this workspace have a usable
 * account for this network — and both answers must be reached the same way.
 *
 * Two things this screen has to say clearly, because getting either wrong is
 * how somebody types their real password into a box:
 *
 *   - **An app password is not the account password.** Bluesky issues them
 *     separately and revokes them individually, which is what makes
 *     disconnecting us cost nothing. The link to generate one is right here,
 *     because "go and find it in settings" is where people give up and use
 *     the real one instead.
 *   - **What gets posted is a public reply under their own name.** Not a DM,
 *     not a broadcast. Somebody agreeing to connect an account should know
 *     what will appear on it.
 */
export function BlueskyForm({ initial }: { initial: BlueskyIntegrationView }) {
  const router = useRouter();
  const { account, canConnect } = initial;

  const [identifier, setIdentifier] = useState(account.handle ?? '');
  const [appPassword, setAppPassword] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy('save');
    setError(undefined);
    setSaved(false);

    try {
      const response = await fetch('/api/v1/integrations/bluesky', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ identifier, appPassword }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      if (!response.ok) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }

      // Never kept after a successful connect: the API cannot read it back,
      // and leaving it in the field implies we could.
      setAppPassword('');
      setSaved(true);
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  async function disconnect(): Promise<void> {
    if (!confirm('Disconnect Bluesky? Cadence steps on it will become manual.')) return;

    setBusy('remove');
    setError(undefined);

    try {
      const response = await fetch('/api/v1/integrations/bluesky', {
        method: 'DELETE',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        setError(`that failed (${response.status})`);
        return;
      }

      setIdentifier('');
      setSaved(false);
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <form onSubmit={submit} className="border-border bg-surface-raised rounded-2xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Bluesky</h2>
          <p className="text-ink-muted mt-1 text-xs">
            The one network we may post to for you. Replies go out publicly, under your own account,
            in the thread the signal came from.
          </p>
        </div>

        {account.connected ? (
          <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-600">
            Connected
          </span>
        ) : null}
      </div>

      {!canConnect ? (
        <p className="text-ink-muted border-border mt-3 rounded-xl border border-dashed p-3 text-xs">
          This deployment has no encryption key set, so a credential cannot be stored safely.
          Nothing here will save until <code>SECRET_ENCRYPTION_KEY</code> is configured.
        </p>
      ) : null}

      <label htmlFor="bsky-handle" className="text-ink-muted mt-4 block text-xs">
        Handle
      </label>
      <input
        id="bsky-handle"
        value={identifier}
        onChange={(e) => {
          setIdentifier(e.target.value);
          setSaved(false);
        }}
        placeholder="you.bsky.social"
        autoComplete="username"
        className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
      />

      <label htmlFor="bsky-password" className="text-ink-muted mt-4 block text-xs">
        App password
      </label>
      <input
        id="bsky-password"
        type="password"
        value={appPassword}
        onChange={(e) => {
          setAppPassword(e.target.value);
          setSaved(false);
        }}
        placeholder={account.connected ? 'stored — retype to replace' : 'xxxx-xxxx-xxxx-xxxx'}
        autoComplete="new-password"
        className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
      />
      <p className="text-ink-muted mt-1 text-xs">
        Not your account password.{' '}
        <a
          href="https://bsky.app/settings/app-passwords"
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent underline"
        >
          Generate one here
        </a>{' '}
        — it can be revoked on its own, so disconnecting us never changes how you sign in.
      </p>

      {error ? <p className="mt-3 text-xs text-rose-600">{error}</p> : null}
      {saved ? <p className="mt-3 text-xs text-emerald-600">Connected.</p> : null}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="submit"
          disabled={busy !== undefined || !identifier || !appPassword}
          className="bg-accent min-h-[44px] rounded-xl px-4 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy === 'save' ? 'Checking…' : account.connected ? 'Reconnect' : 'Connect'}
        </button>

        {account.connected ? (
          <button
            type="button"
            onClick={disconnect}
            disabled={busy !== undefined}
            className="border-border text-ink-muted min-h-[44px] rounded-xl border px-4 text-sm disabled:opacity-50"
          >
            {busy === 'remove' ? 'Removing…' : 'Disconnect'}
          </button>
        ) : null}
      </div>

      <p className="text-ink-muted mt-3 text-xs">
        We check the credential against Bluesky before storing it, so a saved account is a working
        one.
      </p>
    </form>
  );
}
