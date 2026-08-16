'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { EmailIntegrationView, SmtpPresetView } from '../lib/types';

/**
 * Connecting the mailbox outreach is sent from.
 *
 * This is the control that turns a drafted message into a delivered one. Until
 * a workspace has one, the policy engine has nothing to send *through*, every
 * email recommendation resolves to `manual_only`, and the approval queue can
 * only tell the reviewer to go and do it themselves.
 *
 * Two decisions worth keeping:
 *
 *   - **The provider picker fills in the host, port and TLS mode.** Nobody
 *     should have to know that 465 is implicit TLS and 587 upgrades, and
 *     getting that pair wrong produces a connection that hangs rather than an
 *     error that explains itself.
 *   - **The password field is never populated from the server.** It cannot be
 *     — the API does not return it — and showing a masked placeholder would
 *     imply otherwise. Reconnecting means retyping it, which is the honest
 *     behaviour for a credential we deliberately cannot read back.
 */
export function MailboxForm({ initial }: { initial: EmailIntegrationView }) {
  const router = useRouter();
  const { account, presets } = initial;

  const [presetId, setPresetId] = useState(() => matchPreset(presets, account.host));
  const [host, setHost] = useState(account.host ?? '');
  const [port, setPort] = useState(account.port ?? 465);
  const [secure, setSecure] = useState(account.secure ?? true);
  const [username, setUsername] = useState(account.username ?? '');
  const [password, setPassword] = useState('');
  const [fromEmail, setFromEmail] = useState(account.fromEmail ?? '');
  const [fromName, setFromName] = useState(account.fromName ?? '');
  const [replyTo, setReplyTo] = useState(account.replyTo ?? '');

  const [busy, setBusy] = useState<'save' | 'remove' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  const preset = presets.find((p) => p.id === presetId);

  function choosePreset(id: string): void {
    setPresetId(id);
    setSaved(false);

    const chosen = presets.find((p) => p.id === id);
    if (!chosen || chosen.id === 'custom') return;

    setHost(chosen.host);
    setPort(chosen.port);
    setSecure(chosen.secure);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy('save');
    setError(undefined);
    setSaved(false);

    try {
      const response = await fetch('/api/v1/integrations/email', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          host,
          port: Number(port),
          secure,
          username,
          password,
          fromEmail: fromEmail || username,
          ...(fromName ? { fromName } : {}),
          ...(replyTo ? { replyTo } : {}),
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      if (!response.ok) {
        // The mail server's own words. "535 Username and Password not
        // accepted" tells the user to check their app password; "that failed"
        // tells them nothing.
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setPassword('');
      setSaved(true);
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  async function disconnect(): Promise<void> {
    if (!confirm('Disconnect this mailbox? Outreach will stop sending from it.')) return;

    setBusy('remove');
    setError(undefined);

    try {
      const response = await fetch('/api/v1/integrations/email', {
        method: 'DELETE',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        setError(`could not disconnect (${response.status})`);
        return;
      }

      setPassword('');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  if (!initial.canConnect) {
    return (
      <section className="border-border bg-surface-raised rounded-2xl border p-4">
        <h2 className="text-base font-semibold">Sending mailbox</h2>
        <p className="text-ink-muted mt-2 text-sm">
          This deployment has no <code className="text-ink">SECRET_ENCRYPTION_KEY</code>, so a
          mailbox password cannot be stored safely yet. Set one and restart to connect a mailbox.
        </p>
        {initial.platformFallback ? (
          <p className="text-ink-muted mt-2 text-sm">
            Outreach still sends through the platform sender in the meantime.
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="border-border bg-surface-raised rounded-2xl border p-4">
      <header className="mb-3">
        <h2 className="text-base font-semibold">Sending mailbox</h2>
        <p className="text-ink-muted text-sm">
          {account.connected
            ? `Outreach sends from ${account.fromEmail}.`
            : initial.platformFallback
              ? 'Connect your own mailbox so replies land in your inbox and mail comes from your domain.'
              : 'Connect a mailbox. Until you do, approved messages cannot be sent.'}
        </p>
      </header>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="text-sm">
          <span className="text-ink-muted text-xs">Provider</span>
          <select
            value={presetId}
            onChange={(e) => choosePreset(e.target.value)}
            className="border-border mt-1 w-full rounded-xl border p-2 text-sm"
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {preset?.note ? (
          <p className="border-border text-ink-muted rounded-xl border border-dashed p-3 text-xs">
            {preset.note}
          </p>
        ) : null}

        <div className="grid grid-cols-3 gap-2">
          <label className="col-span-2 text-sm">
            <span className="text-ink-muted text-xs">SMTP host</span>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              required
              autoComplete="off"
              className="border-border mt-1 w-full rounded-xl border p-2 text-sm"
            />
          </label>

          <label className="text-sm">
            <span className="text-ink-muted text-xs">Port</span>
            <input
              type="number"
              value={port}
              onChange={(e) => {
                const next = Number(e.target.value);
                setPort(next);
                // 465 is implicit TLS, 587 upgrades. Keeping these in step
                // stops the most common misconfiguration.
                if (next === 465) setSecure(true);
                if (next === 587 || next === 25) setSecure(false);
              }}
              required
              className="border-border mt-1 w-full rounded-xl border p-2 text-sm"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
          <span>TLS on connect (port 465). Uncheck for STARTTLS submission (587).</span>
        </label>

        <label className="text-sm">
          <span className="text-ink-muted text-xs">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
            placeholder="user@company.com"
            className="border-border mt-1 w-full rounded-xl border p-2 text-sm"
          />
        </label>

        <label className="text-sm">
          <span className="text-ink-muted text-xs">
            {account.connected ? 'Password (retype to change)' : 'Password or app password'}
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            className="border-border mt-1 w-full rounded-xl border p-2 text-sm"
          />
          <span className="text-ink-muted mt-1 block text-xs">
            Stored encrypted. It is never shown again, here or anywhere else.
          </span>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">
            <span className="text-ink-muted text-xs">From address</span>
            <input
              type="email"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder={username || 'user@company.com'}
              className="border-border mt-1 w-full rounded-xl border p-2 text-sm"
            />
          </label>

          <label className="text-sm">
            <span className="text-ink-muted text-xs">From name</span>
            <input
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Jane at Company"
              className="border-border mt-1 w-full rounded-xl border p-2 text-sm"
            />
          </label>
        </div>

        <label className="text-sm">
          <span className="text-ink-muted text-xs">Reply-to (optional)</span>
          <input
            type="email"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
            placeholder="Defaults to the from address"
            className="border-border mt-1 w-full rounded-xl border p-2 text-sm"
          />
        </label>

        {error ? (
          <p role="alert" className="text-hot text-sm">
            {error}
          </p>
        ) : null}

        {saved ? (
          <p className="text-sm text-green-700 dark:text-green-400">
            Connected. We logged in to the server before saving, so this mailbox works.
          </p>
        ) : null}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={Boolean(busy)}
            className="bg-accent flex-1 rounded-xl py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy === 'save' ? 'Checking the login…' : account.connected ? 'Update' : 'Connect'}
          </button>

          {account.connected ? (
            <button
              type="button"
              onClick={disconnect}
              disabled={Boolean(busy)}
              className="border-border text-hot rounded-xl border px-4 py-2 text-sm font-medium disabled:opacity-60"
            >
              {busy === 'remove' ? 'Removing…' : 'Disconnect'}
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

/** Picks the preset a stored host came from, so the form opens where it was. */
function matchPreset(presets: SmtpPresetView[], host: string | undefined): string {
  if (!host) return presets[0]?.id ?? 'custom';
  return presets.find((p) => p.host && p.host === host)?.id ?? 'custom';
}
