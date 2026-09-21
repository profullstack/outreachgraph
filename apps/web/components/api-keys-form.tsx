'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { ApiKeyView } from '../lib/api';

/**
 * Keys for the agents that drive this workspace.
 *
 * The secret is shown once, here, the moment it is minted, and never again:
 * the API stores a hash and cannot read it back. Everything else on the list
 * is a prefix, a name and a last-used time — enough to know which key an
 * agent is holding and which to revoke, without the page ever being a place
 * to copy a live credential from.
 */
export function ApiKeysForm({ initial }: { initial: readonly ApiKeyView[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'mint' | string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [fresh, setFresh] = useState<{ name: string; key: string } | undefined>();

  async function mint(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy('mint');
    setError(undefined);

    try {
      const response = await fetch('/api/v1/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        key?: { name: string; key: string };
        error?: { message?: string };
      };

      if (!response.ok || !payload.key) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setFresh(payload.key);
      setName('');
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  async function revoke(id: string, label: string): Promise<void> {
    if (!confirm(`Revoke “${label}”? Anything using it stops working now.`)) return;

    setBusy(id);
    setError(undefined);

    try {
      const response = await fetch(`/api/v1/api-keys/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        setError(`could not revoke (${response.status})`);
        return;
      }
      if (fresh && initial.find((k) => k.id === id)?.name === fresh.name) setFresh(undefined);
      router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="border-border rounded-2xl border p-4">
      <h2 className="text-base font-semibold">API keys</h2>
      <p className="text-ink-muted mt-1 text-sm">
        For agents that run outreach through the API. Read{' '}
        <a href="/api/v1/public/llms.txt" className="underline">
          llms.txt
        </a>{' '}
        or the{' '}
        <a href="/api/v1/public/openapi.json" className="underline">
          OpenAPI schema
        </a>
        . Send a key as <code>X-API-Key</code> on every request.
      </p>

      {fresh ? (
        <div className="border-accent mt-3 rounded-xl border p-3 text-sm">
          <p className="font-medium">
            “{fresh.name}” is ready. Copy it now; it is not shown again.
          </p>
          <code className="mt-2 block break-all rounded-lg bg-black/5 p-2 text-xs">
            {fresh.key}
          </code>
        </div>
      ) : null}

      <ul className="mt-3 flex flex-col gap-2">
        {initial.length === 0 ? (
          <li className="border-border text-ink-muted rounded-xl border border-dashed p-3 text-xs">
            No keys yet.
          </li>
        ) : null}
        {initial.map((key) => (
          <li
            key={key.id}
            className="border-border flex items-center justify-between gap-3 rounded-xl border p-3 text-sm"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{key.name}</p>
              <p className="text-ink-muted text-xs">
                <code>{key.prefix}…</code>
                {key.lastUsedAt
                  ? ` · last used ${new Date(key.lastUsedAt).toLocaleString()}`
                  : ' · never used'}
              </p>
            </div>
            <button
              type="button"
              disabled={busy === key.id}
              onClick={() => revoke(key.id, key.name)}
              className="border-border rounded-xl border px-3 py-2 text-xs disabled:opacity-40"
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>

      <form onSubmit={mint} className="mt-3 flex items-end gap-2">
        <label className="flex-1 text-sm">
          <span className="text-ink-muted text-xs">New key name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Claude outreach agent"
            required
            maxLength={100}
            className="border-border mt-1 w-full rounded-xl border p-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={busy === 'mint' || !name.trim()}
          className="bg-accent rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy === 'mint' ? 'Minting…' : 'Create key'}
        </button>
      </form>

      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    </section>
  );
}
