'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { CoinPayIntegrationView } from '../lib/api';

/**
 * Connecting the workspace's own CoinPay account, so Today can show who is
 * behind on paying it. Read-only on CoinPay's side: the key only reads the
 * "who's behind" report; nothing here moves money or emails anyone.
 */
export function CoinPayForm({ initial }: { initial: CoinPayIntegrationView }) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const connected = initial.connection.connected;

  async function connect(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy('save');
    setError(undefined);
    try {
      const response = await fetch('/api/v1/integrations/coinpay', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ apiKey }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }
      setApiKey('');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  async function disconnect(): Promise<void> {
    if (!confirm('Disconnect CoinPay? Today stops showing who is behind on payments.')) return;
    setBusy('remove');
    setError(undefined);
    try {
      const response = await fetch('/api/v1/integrations/coinpay', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        setError(`that failed (${response.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section id="coinpay" className="border-border rounded-2xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">CoinPay</h2>
        {connected ? (
          <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-600">
            Connected
          </span>
        ) : null}
      </div>
      <p className="text-ink-muted mt-1 text-sm">
        If you sell through CoinPay, Today shows the customers behind on paying you: overdue
        invoices and declined cards, grouped by what to do, with an email drafted for each.
      </p>

      {!initial.canConnect ? (
        <p className="text-ink-muted border-border mt-3 rounded-xl border border-dashed p-3 text-xs">
          This deployment has no encryption key set, so an API key cannot be stored safely.
        </p>
      ) : null}

      <form onSubmit={connect} className="mt-3 flex items-end gap-2">
        <label className="flex-1 text-sm">
          <span className="text-ink-muted text-xs">
            A business API key: CoinPay › Businesses › your business › API keys.
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={connected ? 'stored — paste a new one to replace' : 'cp_live_…'}
            autoComplete="off"
            className="border-border mt-1 w-full rounded-xl border p-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={busy !== undefined || !apiKey.trim() || !initial.canConnect}
          className="bg-accent rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy === 'save' ? 'Checking…' : connected ? 'Replace' : 'Connect'}
        </button>
        {connected ? (
          <button
            type="button"
            onClick={disconnect}
            disabled={busy !== undefined}
            className="border-border rounded-xl border px-3 py-2 text-xs disabled:opacity-40"
          >
            Disconnect
          </button>
        ) : null}
      </form>

      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </section>
  );
}
