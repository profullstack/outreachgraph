'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { CrmConnectionView, CrmIntegrationView } from '../lib/api';

const LABEL: Record<CrmConnectionView['provider'], string> = {
  hubspot: 'HubSpot',
  pipedrive: 'Pipedrive',
};

const HELP: Record<CrmConnectionView['provider'], string> = {
  hubspot:
    'A private app access token: HubSpot Settings › Integrations › Private Apps, with contacts read and write scopes.',
  pipedrive: 'Your personal API token: Pipedrive › Personal preferences › API.',
};

/**
 * Connecting a CRM.
 *
 * Only replies and approved outreach reach it, as a contact (created if
 * missing, never overwritten) with a note. Saying which two events on the
 * form is deliberate: "sync to CRM" with no qualifier reads as "every
 * prospect we ever found", which is what nobody wants in their CRM.
 */
export function CrmForm({ initial }: { initial: CrmIntegrationView }) {
  return (
    <section className="border-border rounded-2xl border p-4">
      <h2 className="text-base font-semibold">CRM</h2>
      <p className="text-ink-muted mt-1 text-sm">
        When someone replies, or you approve outreach to them, they are added to your CRM (if they
        are not there already) with a note. Only people with a personal email address are synced.
      </p>

      {!initial.canConnect ? (
        <p className="text-ink-muted border-border mt-3 rounded-xl border border-dashed p-3 text-xs">
          This deployment has no encryption key set, so a CRM token cannot be stored safely.
        </p>
      ) : null}

      <div className="mt-3 flex flex-col gap-3">
        {initial.providers.map((connection) => (
          <CrmRow
            key={connection.provider}
            connection={connection}
            canConnect={initial.canConnect}
          />
        ))}
      </div>
    </section>
  );
}

function CrmRow({
  connection,
  canConnect,
}: {
  connection: CrmConnectionView;
  canConnect: boolean;
}) {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const label = LABEL[connection.provider];

  async function connect(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy('save');
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/integrations/crm/${connection.provider}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }
      setToken('');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  async function disconnect(): Promise<void> {
    if (!confirm(`Disconnect ${label}? Nothing more is synced until you reconnect.`)) return;
    setBusy('remove');
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/integrations/crm/${connection.provider}`, {
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
    <form onSubmit={connect} className="border-border rounded-xl border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{label}</p>
        {connection.connected ? (
          <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-600">
            Connected
          </span>
        ) : connection.status === 'revoked' ? (
          <span className="rounded-full bg-rose-500/15 px-2 py-1 text-[11px] font-medium text-rose-600">
            Token refused
          </span>
        ) : null}
      </div>

      {connection.lastSyncAt ? (
        <p className="text-ink-muted mt-1 text-xs">
          Last sync {new Date(connection.lastSyncAt).toLocaleString()}
          {connection.lastError ? ` · ${connection.lastError}` : ''}
        </p>
      ) : null}

      <div className="mt-2 flex items-end gap-2">
        <label className="flex-1 text-sm">
          <span className="text-ink-muted text-xs">{HELP[connection.provider]}</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={connection.connected ? 'stored — paste a new one to replace' : 'token'}
            autoComplete="off"
            className="border-border mt-1 w-full rounded-xl border p-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={busy !== undefined || !token.trim() || !canConnect}
          className="bg-accent rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy === 'save' ? 'Checking…' : connection.connected ? 'Replace' : 'Connect'}
        </button>
        {connection.connected || connection.status ? (
          <button
            type="button"
            onClick={disconnect}
            disabled={busy !== undefined}
            className="border-border rounded-xl border px-3 py-2 text-xs disabled:opacity-40"
          >
            Disconnect
          </button>
        ) : null}
      </div>

      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </form>
  );
}
